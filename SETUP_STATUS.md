# ViBe Local Setup — Status (rev 2)

This document tracks what was set up for a local-only run of the ViBe
monorepo (no real Firebase project, no real MongoDB, no Anthropic key).

## One-shot bootstrap

From PowerShell at `D:\Vicharanashala prjs\vibe_feature`:
```
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

The script:
1. Verifies node/pnpm/firebase/java in PATH
2. Kills leftover firebase/node processes on :9099
3. Runs `pnpm install --no-frozen-lockfile` if `node_modules` missing
4. Adds `tsx` at workspace root if missing (needed by backend dev launcher)
5. Verifies `ts-node` and `tsc` are present
6. Starts Firebase Auth Emulator on `127.0.0.1:9099`
7. PATCHes the emulator's email-validation regex to be lenient
8. POSTs `accounts:signUp` to seed `[email protected] / TestUser123`
9. Smoke-tests the backend: launches it, hits `/health`, kills it

If all green, run two terminals for actual development:
- Terminal A — backend:
  ```
  cd backend
  node scripts/launch-dev.mjs
  ```
- Terminal B — frontend:
  ```
  cd frontend
  pnpm dev
  ```

Then open http://localhost:5173 and sign in with the seeded test user.

## What was modified in source

| File                                                              | Change                                                        |
|-------------------------------------------------------------------|---------------------------------------------------------------|
| `backend/.env`                                                    | local dev env (TLS off, in-memory mongo, emulator host)       |
| `backend/package.json` (imports map)                              | `#root/*` etc. now resolve to `./src/*.ts` (was `./build/*.js`) |
| `backend/src/shared/database/.../MongoDatabase.ts`                | TLS disabled for local/dev URIs                               |
| `backend/src/modules/auth/services/FirebaseAuthService.ts`        | skips `admin.initializeApp` when `FIREBASE_AUTH_EMULATOR_HOST` is set |
| `backend/scripts/launch-dev.mjs`                                  | new — boots mongo + tsx + loads .env                          |
| `frontend/.env`                                                   | `VITE_USE_FIREBASE_EMULATOR=true` + stub keys                 |
| `frontend/src/lib/firebase.ts`                                    | `connectAuthEmulator(auth, 'http://127.0.0.1:9099')` in dev   |
| `frontend/vite.config.ts`                                         | proxy now points at `localhost:3141`                          |
| `backend/firebase.json`                                           | pinned emulator host/port to `127.0.0.1`                      |
| `backend/auth-emulator-config.json`                               | permissive email regex for emulator                           |
| `scripts/seed-user.json`                                          | test user payload                                             |

## How local dev works (no real services)

- **Firebase Auth**: emulator on `127.0.0.1:9099`. Sign-ups go there
  only. Frontend and backend both talk to the emulator.
- **MongoDB**: `mongodb-memory-server` boots an in-process mongod with
  an ephemeral data dir; URI is exported as `DB_URL` before the app loads.
- **Anthropic**: not loaded at startup; only used inside `GenAIService`
  on demand. Without an API key, AI features 500 — everything else works.

## Open issues / known limitations

1. The first run of `mongodb-memory-server.create()` downloads a
   `mongod` binary (~50MB) to `node_modules/.cache/mongodb-memory-server`.
   That step may take a minute and is the reason the smoke test waits
   up to 60s.
2. AI-driven question generation will not work without an
   `ANTHROPIC_API_KEY`. That's expected — it's a paid service.
3. The `dev` script (`backend/package.json`) still uses
   `tsc --watch` + `nodemon` over `build/`. The new
   `launch-dev.mjs` is the recommended path for local dev.
4. If the frontend is unable to talk to Firebase (emulator not running,
   wrong config), most flows will fail at the sign-in screen, not at
   page load. That's expected.

## If real services come online

Edit `backend/.env`:
- `DB_URL` -> real `mongodb+srv://...` URI (TLS auto-re-enables)
- `FIREBASE_*` -> real Firebase project keys (delete `FIREBASE_AUTH_EMULATOR_HOST` lines)
- `ANTHROPIC_API_KEY` -> real key
- Restore `backend/package.json` `imports` map to `./build/*.js`
- Run `pnpm build && pnpm start` instead of `launch-dev.mjs`

`frontend/.env` should match (real Firebase web config, drop
`VITE_USE_FIREBASE_EMULATOR`).
