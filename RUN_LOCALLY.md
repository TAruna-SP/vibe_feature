# Running ViBe Locally

## Quick Start

### 1. Start the Backend
Open a terminal in `backend/` and run:
```powershell
node scripts/launch-dev.mjs
```

This automatically:
- Starts a local MongoDB replica set (ephemeral, port 27017)
- Boots the Express API server (port 3141)
- **Auto-seeds dev users** (Firebase emulator + MongoDB) ~8 seconds after startup

> The Firebase Auth Emulator must already be running on port 9099 before you start the backend.

### 2. Start Firebase Auth Emulator
Open another terminal in `backend/` and run:
```powershell
npx firebase emulators:start --only auth
```

### 3. Start the Frontend
Open another terminal in `frontend/` and run:
```powershell
pnpm dev
```

Frontend runs on http://localhost:5173.

---

## Dev Login Credentials

| Role    | Email                | Password     |
|---------|----------------------|--------------|
| Teacher | teacher@vibe.dev     | Teacher123!  |
| Student | student@vibe.dev     | Student123!  |
| Student | aruna@gmail.com      | Student123!  |

---

## How the AI Pipeline Mock Works

The `WebhookService` is a local mock — it does **not** call the real AI server.

When you submit a video URL (Custom/Wizard mode):
1. The backend receives the job and calls `approveTaskStart`.
2. The mock schedules RUNNING → COMPLETED webhooks with ~4 second delay.
3. Each task completes automatically — no manual intervention needed.
4. The pipeline creates **5 segments** from the video.
5. After all tasks complete, you can click **Accept & Publish** to upload content.

---

## Re-seeding Users

If the MongoDB data gets wiped (happens on every backend restart), run:
```powershell
node backend/scripts/seed-dev-users.cjs
```

This is idempotent — it's also called automatically 8 seconds after `launch-dev.mjs` starts.
