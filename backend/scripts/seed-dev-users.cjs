/**
 * seed-dev-users.cjs
 *
 * Seeds development users into:
 *   1. Firebase Auth Emulator (port 9099)
 *   2. MongoDB "vibe" database
 *
 * Run AFTER the backend dev server is up:
 *   node backend/scripts/seed-dev-users.cjs
 *
 * Idempotent — skips users that already exist.
 */

const { MongoClient, ObjectId } = require('mongodb');
const http = require('http');

const FIREBASE_EMULATOR = '127.0.0.1:9099';
const MONGO_URL = 'mongodb://127.0.0.1:27017/vibe?replicaSet=rs0&directConnection=true';
const PROJECT_ID = 'demo-vibe';

const USERS = [
  {
    email: 'teacher@vibe.dev',
    password: 'Teacher123!',
    displayName: 'Test Teacher',
    firstName: 'Test',
    lastName: 'Teacher',
    roles: 'admin',   // 'admin' gives teacher/course-creation abilities
  },
  {
    email: 'student@vibe.dev',
    password: 'Student123!',
    displayName: 'Test Student',
    firstName: 'Test',
    lastName: 'Student',
    roles: 'user',    // 'user' is student
  },
  {
    email: 'aruna@gmail.com',
    password: 'Student123!',
    displayName: 'Aruna Student',
    firstName: 'Aruna',
    lastName: 'Student',
    roles: 'user',
  }
];

function httpPost(host, port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: host, port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let raw = '';
        res.on('data', (d) => (raw += d));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function createFirebaseUser(email, password, displayName) {
  const [host, port] = FIREBASE_EMULATOR.split(':');
  const res = await httpPost(
    host, Number(port),
    `/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    { email, password, displayName, emailVerified: true, returnSecureToken: true }
  );

  if (res.status === 200 && res.body.localId) {
    return { localId: res.body.localId, created: true };
  }
  // EMAIL_EXISTS means already seeded — that's fine
  if (res.body?.error?.message === 'EMAIL_EXISTS') {
    // Sign in to get the localId
    const signIn = await httpPost(
      host, Number(port),
      `/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
      { email, password, returnSecureToken: true }
    );
    if (signIn.status === 200 && signIn.body.localId) {
      return { localId: signIn.body.localId, created: false };
    }
  }
  throw new Error(`Firebase user creation failed: ${JSON.stringify(res.body)}`);
}

async function main() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db('vibe');

  for (const user of USERS) {
    console.log(`\nSeeding user: ${user.email}`);

    // 1. Firebase emulator
    let firebaseResult;
    try {
      firebaseResult = await createFirebaseUser(user.email, user.password, user.displayName);
      if (firebaseResult.created) {
        console.log(`  ✅ Firebase user created. uid=${firebaseResult.localId}`);
      } else {
        console.log(`  ℹ️  Firebase user already exists. uid=${firebaseResult.localId}`);
      }
    } catch (err) {
      console.error(`  ❌ Firebase error: ${err.message}`);
      continue;
    }

    // 2. MongoDB
    const existing = await db.collection('users').findOne({ firebaseUID: firebaseResult.localId });
    if (existing) {
      console.log(`  ℹ️  MongoDB user already exists. _id=${existing._id}`);
    } else {
      const doc = {
        _id: new ObjectId(),
        firebaseUID: firebaseResult.localId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        roles: user.roles,
        avatar: null,
        gender: null,
        country: null,
        state: null,
        city: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await db.collection('users').insertOne(doc);
      console.log(`  ✅ MongoDB user created. _id=${doc._id}`);
    }
  }

  await client.close();
  console.log('\nDone seeding dev users.');
  console.log('\nLogin credentials:');
  for (const u of USERS) {
    console.log(`  ${u.email}  /  ${u.password}`);
  }
}

main().catch((err) => {
  console.error('Seed script failed:', err);
  process.exit(1);
});
