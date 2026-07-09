#!/usr/bin/env node
/**
 * Local-dev launcher for the backend (build + run path).
 *
 *  1. Loads backend/.env
 *  2. Spawns the cached mongod binary on 127.0.0.1:27017 (ephemeral, no
 *     system service needed)
 *  3. Runs `node build/index.js` — uses the pre-compiled TypeScript
 *     output that the rest of the repo is built around
 *
 * Why build+run instead of tsx:
 *   tsx 4.x + esbuild + experimentalDecorators injects `__name` calls
 *   that break at runtime. The repo's reference workspace runs the
 *   compiled build (see `pnpm start`), which doesn't have that issue.
 *
 * Prereqs (handled by setup.ps1):
 *   - `pnpm install` completed
 *   - `pnpm exec tsc` produced backend/build/
 *   - mongod binary cached at C:\Users\D\.cache\mongodb-binaries\
 *
 * Run from anywhere:
 *   node backend/scripts/launch-dev.mjs
 */

import { config as loadDotenv } from 'dotenv';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function resolveEnvPath() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'backend', '.env');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const envPath = resolveEnvPath();
if (envPath) {
  loadDotenv({ path: envPath });
  console.log(`[launch-dev] loaded env from ${envPath}`);
} else {
  console.warn('[launch-dev] could not locate backend/.env via parent walk');
}

// Resolve paths robustly (Windows fileURLs have a leading slash before
// the drive letter that breaks path.dirname).
let scriptsDir = fileURLToPath(new URL('.', import.meta.url));
while (scriptsDir.endsWith(path.sep)) scriptsDir = scriptsDir.slice(0, -1);
const backendRoot = path.dirname(scriptsDir);            // .../backend
const repoRoot = path.dirname(backendRoot);              // .../vibe_feature

// ----- 1. Start mongod ---------------------------------------------------------
const cacheDir = path.join(os.homedir(), '.cache', 'mongodb-binaries');
const mongodCandidates = fs.existsSync(cacheDir)
  ? fs.readdirSync(cacheDir).filter(f => /^mongod-.*\.exe$/.test(f)).map(f => path.join(cacheDir, f))
  : [];

if (mongodCandidates.length === 0) {
  console.error(`[launch-dev] no mongod binary found in ${cacheDir}.`);
  console.error(`[launch-dev] run: cd backend && pnpm exec ts-node -e "import('mongodb-memory-server').then(m=>m.MongoMemoryServer.create().then(s=>s.stop()))"`);
  process.exit(1);
}
// Prefer the newest binary (lexicographic sort works for yyyy-mm-dd prefix).
mongodCandidates.sort();
const mongodBin = mongodCandidates[mongodCandidates.length - 1];

// Pick a free data dir (auto-cleaned between runs). Create inside workspace
// because the system C: drive has extremely low disk space (only ~22MB free).
const localMongoTempDir = path.join(backendRoot, '.mongo-data');
if (!fs.existsSync(localMongoTempDir)) {
  fs.mkdirSync(localMongoTempDir, { recursive: true });
}
const dataDir = fs.mkdtempSync(path.join(localMongoTempDir, 'vibe-mongo-'));
const mongoPort = 27017;

// Make sure no stale mongod is squatting on 27017.
try {
  spawnSync('powershell', ['-NoProfile', '-Command', `Get-Process mongod -ErrorAction SilentlyContinue | Stop-Process -Force`], { stdio: 'ignore' });
} catch {}

console.log(`[launch-dev] starting mongod from ${mongodBin}`);
console.log(`[launch-dev] dataDir=${dataDir} port=${mongoPort}`);

const mongod = spawn(mongodBin, [
  '--dbpath', dataDir,
  '--port', String(mongoPort),
  '--bind_ip', '127.0.0.1',
  '--quiet',
  // Backend uses transactions in UserRepository.create / BaseService._withTransaction.
  // Standalone mongod rejects transactions with "Transaction numbers are only allowed
  // on a replica set member or mongos". Run as a single-node replica set so transactions
  // work in dev. We initiate the set after the port is up below.
  '--replSet', 'rs0',
], { stdio: ['ignore', 'inherit', 'inherit'] });

mongod.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error(`[launch-dev] mongod exited with code ${code}`);
  }
});

// Wait for mongod to accept connections (up to 15s).
async function waitForMongo(port, timeoutMs = 15000) {
  const net = await import('node:net');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.end(); resolve(true); });
      sock.once('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`mongod did not accept connections on port ${port} within ${timeoutMs}ms`);
}
await waitForMongo(mongoPort);
console.log(`[launch-dev] mongod ready on 127.0.0.1:${mongoPort}`);

// Initiate the replica set so transactions work. Single-node, no auth.
// Retry up to 10 times because mongod reports "not yet primary" until
// the election finishes.
async function initiateReplicaSet() {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(`mongodb://127.0.0.1:${mongoPort}/?directConnection=true`);
  try {
    await client.connect();
    // Check if already initiated.
    try {
      const status = await client.db('admin').command({ hello: 1 });
      if (status.setName === 'rs0' && status.isWritablePrimary) {
        console.log('[launch-dev] replica set already initialized');
        return;
      }
    } catch {}
    for (let i = 0; i < 10; i++) {
      try {
        await client.db('admin').command({
          replSetInitiate: {
            _id: 'rs0',
            members: [{ _id: 0, host: `127.0.0.1:${mongoPort}` }],
          },
        });
        console.log('[launch-dev] replica set initiated (rs0)');
      } catch (err) {
        // "already initialized" or "already initialized" with election in
        // progress — both are fine, fall through to the primary wait.
        const msg = String(err?.message || '').toLowerCase();
        if (msg.includes('already initialized') || msg.includes('not primary') || msg.includes('replset') || msg.includes('configuration')) {
          console.log('[launch-dev] replSetInitiate skipped: ' + err.message);
        } else if (i === 9) {
          throw err;
        } else {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
      }
      // Wait for primary to be elected (up to 60s). Single-node replica sets
      // usually elect in 1-2s, but on a busy host or after a recent election
      // it can take longer.
      for (let j = 0; j < 120; j++) {
        const hello = await client.db('admin').command({ hello: 1 });
        if (hello.isWritablePrimary) {
          console.log('[launch-dev] rs0 primary elected after ' + (j * 250) + 'ms');
          return;
        }
        await new Promise(r => setTimeout(r, 250));
      }
      throw new Error('rs0 primary not elected within 30s');
    }
  } finally {
    await client.close().catch(() => {});
  }
}
await initiateReplicaSet();

// Ensure DB_URL points at our local mongod (unless user already set a real one).
if (!process.env.DB_URL || process.env.DB_URL.startsWith('mongodb://127.0.0.1:')) {
  const dbName = process.env.DB_NAME || 'vibe';
  process.env.DB_URL = `mongodb://127.0.0.1:${mongoPort}/${dbName}?replicaSet=rs0&directConnection=true`;
}
console.log(`[launch-dev] DB_URL=${process.env.DB_URL}`);

// ----- 2. Run compiled backend ------------------------------------------------
const indexJs = path.join(backendRoot, 'build', 'index.js');
if (!fs.existsSync(indexJs)) {
  console.error(`[launch-dev] build not found at ${indexJs}.`);
  console.error(`[launch-dev] run: cd backend && pnpm exec tsc`);
  // Give mongod time to exit before bailing.
  mongod.kill();
  process.exit(1);
}

const shutdown = (code = 0) => {
  try { mongod.kill(); } catch {}
  process.exit(code);
};
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Defensive: cron jobs in this app can throw on an empty database.
// Don't let an unhandled rejection take down the whole process.
process.on('unhandledRejection', (reason) => {
  console.warn('[launch-dev] unhandledRejection (ignored):', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.warn('[launch-dev] uncaughtException (ignored):', err?.message || err);
});

const child = spawn(process.execPath, ['--unhandled-rejections=warn', indexJs], {
  cwd: backendRoot,
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => {
  try { mongod.kill(); } catch {}
  // Best-effort data dir cleanup
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(code ?? 0);
});

// ----- 3. Auto-seed dev users after backend warms up -------------------------
// Wait 8 seconds for the Express server to finish registering routes, then
// seed the Firebase emulator + MongoDB with test accounts.  Idempotent, so
// running multiple times is safe.
setTimeout(async () => {
  const seedScript = path.join(scriptsDir, 'seed-dev-users.cjs');
  if (!fs.existsSync(seedScript)) {
    console.warn('[launch-dev] seed-dev-users.cjs not found; skipping auto-seed.');
    return;
  }
  console.log('[launch-dev] auto-seeding dev users ...');
  const seed = spawn(process.execPath, [seedScript], {
    cwd: backendRoot,
    stdio: 'inherit',
    env: process.env,
  });
  seed.on('exit', (code) => {
    if (code === 0) {
      console.log('[launch-dev] dev users seeded successfully.');
    } else {
      console.warn(`[launch-dev] seed script exited with code ${code} (non-fatal).`);
    }
  });
}, 8000);