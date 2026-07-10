# Session Progress Tracker

## Current State — VERIFIED WORKING (2026-07-10)

Both target flows were driven end-to-end against the running local stack
(backend :3141, Firebase Auth Emulator :9099, in-memory Mongo :27017) via
direct API calls (see verification steps below). No browser automation was
available in this session, so the React UI itself was not click-tested, but
every API call the UI makes for these flows was exercised directly and
returned correct results.

**Flow 1 — login as student and teacher**: works. `POST /auth/login` (with
the emulator-aware fix in `AuthController.ts`) succeeds for both
`teacher@vibe.dev` / `Teacher123!` and `student@vibe.dev` / `Student123!`,
and `GET /users/me` returns the correct profile for each.

**Flow 2 — teacher creates course → GenAI pipeline → publish → student
enrolls → dashboard**: works end-to-end.
1. `POST /courses` (with `versionName`/`versionDescription`) creates course + first version.
2. `POST /courses/versions/:versionId/modules` creates a module.
3. `POST /courses/versions/:versionId/modules/:moduleId/sections` creates a section.
4. `POST /genai/jobs` starts a VIDEO job.
5. For each task in order (`AUDIO_EXTRACTION → TRANSCRIPT_GENERATION →
   SEGMENTATION → QUESTION_GENERATION → UPLOAD_CONTENT`): poll
   `GET /genai/jobs/:id` until `jobStatus.<task>` is `WAITING`, call
   `POST /genai/:id/tasks/approve/start`, poll until `COMPLETED`, call
   `POST /genai/:id/tasks/approve/continue` (skipped after UPLOAD_CONTENT).
   All 5 tasks completed; UPLOAD_CONTENT ("Accept & Publish") created 5
   Video + 5 Quiz items in the section (matches the mock's "5 segments").
6. `PUT /setting/course-setting/:courseId/:versionId/proctoring` with
   `isPublic: true` makes the course version public; it then shows up in
   `GET /courses/public`.
7. Teacher enrolling the student via
   `POST /users/:userId/enrollments/courses/:courseId/versions/:versionId`
   works, and the enrollment immediately shows up for the student in
   `GET /users/enrollments` (dashboard), with the correct item count (10).

Root cause of the previously-reported "stuck on publish/transcript" issue:
the frontend (`genai-api.ts` `pollForTaskCompletion`, and
`AISectionModal.tsx`) was reading `status.currentTask?.type/.status`, but
`GET /genai/jobs/:id` actually returns `jobStatus.{audioExtraction,
transcriptGeneration, segmentation, questionGeneration, uploadContent}`
with no `currentTask` field at all — so the frontend never saw a task
complete. Fixed by reading `status.jobStatus[<task>]` instead (this fix is
currently uncommitted in the working tree — matches the backend's actual
response shape, verified above).

## Working Items
- Local environment bootstrap (`setup.ps1`, Firebase emulator, in-memory MongoDB)
- Backend health check (`/health`)
- Seed test users (`teacher@vibe.dev`, `student@vibe.dev`)
- Login (backend `/auth/login` pre-check + Firebase emulator sign-in) for both roles
- Full course/module/section creation
- Full GenAI mock pipeline through publish (UPLOAD_CONTENT)
- Make-public + student browse + enroll + dashboard

## Repo hygiene notes
- `backend/.mongo-data/` (ephemeral per-run mongod data dirs created by
  `launch-dev.mjs`) was accidentally committed in `f073019f` (78 binary
  files). Removed from git tracking (`git rm -r --cached`, files kept on
  disk) and added to `.gitignore` so future runs don't re-pollute status.
- `AbilityDecorator.ts` had a no-op formatting-only diff (arrow-fn parens,
  trailing newline) with no behavioral change — reverted to match upstream
  byte-for-byte, since it wasn't needed for local setup.
- All other source changes in `f073019f` and the working tree were checked
  against what they enable (emulator-aware URLs/TLS/admin-init, `/users/me`
  route-ordering fix, cron crash-guard on empty dev DB, `targetSegments`
  mock-segmentation param, dev proxy port fix) — each is either required for
  local dev to run at all or a genuine bug fix exercised by the flows above.

## Broken Items
- None currently known for the two target flows. Not yet click-tested in
  an actual browser (no browser automation tool available this session).
- Self-service student course *registration* flow (`POST
  /course/registration/version/:versionId`, dynamic form schema) was not
  exercised — the enroll step above used the direct instructor-enroll
  endpoint instead. Worth a follow-up if that specific self-service path
  matters.
