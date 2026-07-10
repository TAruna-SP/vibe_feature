# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ViBe is an educational platform (pnpm monorepo) with continuous-assessment/adaptive-review features, AI-generated questions from video content, and proctoring. Workspace packages: `backend`, `frontend`, `backend/functions`, `docs`, `cli`, `mcp`, `e2e` (see `pnpm-workspace.yaml`).

## Local development

See `RUN_LOCALLY.md` and `SETUP_STATUS.md` for the full local-only bootstrap (no real Firebase project, no real MongoDB, no Anthropic key). Summary:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1   # one-time bootstrap
```

Then in separate terminals:
```powershell
cd backend; node scripts/launch-dev.mjs   # boots mongod (mongodb-memory-server), tsx, backend on :3141; auto-seeds dev users
npx firebase emulators:start --only auth  # Firebase Auth Emulator on :9099 (must be running before the backend)
cd frontend; pnpm dev                      # :5173
```

Dev login: `teacher@vibe.dev` / `Teacher123!`, `student@vibe.dev` / `Student123!` (re-seed with `node backend/scripts/seed-dev-users.cjs` if Mongo data is wiped — it wipes on every backend restart since it's an ephemeral in-memory server).

In this local-only mode, `WebhookService` mocks the AI pipeline (no real AI server call): submitting a video schedules RUNNING→COMPLETED transitions with ~4s delay per task, producing 5 segments.

## Commands

Backend (`backend/`):
- `pnpm test` — vitest with UI; `pnpm test:watch` — watch mode; `pnpm test:ci` — coverage + html report. Single test file: `pnpm exec vitest run src/modules/courses/tests/CourseController.test.ts`.
- `pnpm build` — `tsc` to `build/`; `pnpm start` — build + run from `build/index.js` (production path).
- `pnpm dev` — `tsc --watch` + nodemon over `build/` (legacy; prefer `node scripts/launch-dev.mjs` for local dev, see above).
- `pnpm generate` — `plop` scaffolding for new modules.

Frontend (`frontend/`):
- `pnpm dev` / `pnpm build` (`tsc -b && vite build`) / `pnpm preview`.
- `pnpm lint` / `pnpm fix` — `gts lint` / `gts fix`.
- `pnpm copy` — regenerate `openapi.json` from the backend (`cd ../backend && node scripts/generate-openapi.cjs`), then `pnpm gen-schema` regenerates `src/lib/api/schema.ts` via `openapi-typescript`. Run this pair after changing backend routes/validators so the frontend's typed API client stays in sync.

E2E (`e2e/`): Playwright. `pnpm test-e2e`.

## Backend architecture

Express + `routing-controllers` + `inversify` DI, entrypoint `backend/src/index.ts`.

**Module auto-discovery**: `backend/src/bootstrap/loadModules.ts` reads every directory under `backend/src/modules/` and dynamically imports its `index.ts`, expecting these named exports:
- `<module>ModuleControllers` — array of controller classes
- `<module>ModuleValidators` — array of validator classes (used for OpenAPI generation)
- `<module>ContainerModules` — inversify `ContainerModule`s
- `setup<Module>Container()` — function that wires the module's DI bindings

`appConfig.module` selects which module(s) load (`all` loads every module's controllers/validators into one inversify `Container`, driven by `InversifyAdapter`). This means adding a new backend module means adding a directory with this exact export contract — copy an existing module (e.g. `courses`) as the template rather than inventing a new shape.

Each module generally follows: `controllers/` (routing-controllers `@JsonController`s), `services/` (business logic), `classes/validators/` (class-validator DTOs — also drive OpenAPI schema and, notably, are stricter than their TS types suggest: fields typed `foo?: string` without `@IsOptional()` are still rejected when missing), `classes/transformers/`, `abilities/` (CASL-based permission rules checked via `authorizationChecker`/`@Authorized()`), `repositories/providers/mongodb/` (data access), `interfaces/`, `types.ts` (DI symbols), `tests/`.

Path aliases (`backend/package.json` `imports` map, `#root/*`, `#auth/*`, `#courses/*`, etc.) point at `./build/*.js` in production/staging and are resolved to `./src/*.ts` for local dev via `launch-dev.mjs`'s loader setup — don't hardcode `build/` paths in new code.

**GenAI pipeline**: a job (`GenAIController`/`GenAIService`/`WebhookService`) runs an ordered task state machine — `AUDIO_EXTRACTION → TRANSCRIPT_GENERATION → SEGMENTATION → QUESTION_GENERATION → UPLOAD_CONTENT`, tracked per-job in `job.jobStatus.{audioExtraction,transcriptGeneration,segmentation,questionGeneration,uploadContent}` (each `PENDING|WAITING|RUNNING|COMPLETED|FAILED`). The teacher-facing flow per task is: poll `GET /genai/jobs/:id` until the task is `WAITING`, `POST /genai/:id/tasks/approve/start` to run it, poll until `COMPLETED`/`FAILED`, then `POST /genai/:id/tasks/approve/continue` to advance (skip `continue` after `UPLOAD_CONTENT`, which is the terminal "publish" step that actually creates the Video/Quiz items in the target section). In real deployments an external AI server calls back into `POST /genAI/webhook/`; locally `WebhookService` mocks this.

## Frontend architecture

React + Vite + TanStack Router (`frontend/src/app/routes/`, split into `student-routes.tsx`/`teacher-routes.tsx`) + TanStack Query. State: `frontend/src/store` (zustand-style auth store).

API access is generated, not hand-written: `frontend/src/lib/openapi.ts` builds an `openapi-fetch` client typed from `frontend/src/types/schema.ts` (generated from `openapi.json`, itself generated from the backend — see `pnpm copy`/`pnpm gen-schema` above), wrapped by `openapi-react-query` for typed hooks. Some flows call `fetch` directly against `VITE_BASE_URL` instead (e.g. `frontend/src/lib/genai-api.ts`, the `/auth/login` pre-check in `AuthPage.tsx`) rather than going through the generated client — match the existing pattern in the file you're editing rather than mixing both in one call site.

Auth: Firebase Auth SDK (`frontend/src/lib/firebase.ts`) is the source of truth for the ID token (`firebaseUser.getIdToken()`, stored via the auth store / `localStorage['firebase-auth-token']`); the backend independently verifies Firebase ID tokens on protected routes. `loginWithEmail`/`loginWithGoogle` in `frontend/src/utils/auth.ts` do the actual Firebase sign-in; `AuthPage.tsx`'s `handleEmailLogin` also calls the backend `/auth/login` endpoint first as a pre-check (reCAPTCHA + credential validation) before doing the real Firebase sign-in.
