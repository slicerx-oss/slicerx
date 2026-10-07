# @slicerx/cloud

Cloud slicing, delivery of sliced jobs to the user's printers, and sync of printer, filament and process profiles, printers and fleets across devices. Edition feature `cloud`, licensed Apache-2.0.

| Path | What it is |
| --- | --- |
| `service/` | `sx-cloud`, the HTTP service and slicing worker (Rust, axum, `sx-core`) |
| `scan/` | `sx-upload-scan`, the safety pipeline for library uploads (type detection, archive audit, mesh checks, ClamAV, blocklist, conversion to sx3mf) |
| `src/` | `@slicerx/cloud`, the typed client for the app, the mobile app and the MCP server |
| `src/sync/` | `@slicerx/cloud/sync`, offline-first profile sync |
| `supabase/migrations/0004_cloud.sql`, `0006_cloud_access.sql` | tables, row level security and functions (the `cloud` database module), and the invite list |

## Invite only

The SlicerX edition hosts cloud slicing for invited accounts only. A donations-funded project cannot pay for compute on every slice, and slicing on the device is already fast natively and in the browser.

- The switch is `features.cloudSlicing` in the edition config. `editions/slicerx/edition.config.ts` turns it on when `SLICERX_CLOUD_API_URL` names a deployed service and leaves it off otherwise; `SLICERX_FEATURES` can override it.
- With the switch off, `sx-cloud` serves only `/healthz` and `/v1/about` and runs the library upload scan and the account purge. Jobs, meshes, devices and deliveries are not served, and no slicing worker starts.
- With it on, only accounts in `cloud_access` (`0006_cloud_access.sql`) can upload meshes, queue jobs, read results or act as a bridge. Each row sets jobs per rolling 24 hours (default 20, canceled jobs count) and the largest mesh upload (default 25 MB, at most the bucket's 50 MB). A banned account loses access while it stays listed. The service role manages the list with `grant_cloud_access(email, jobs_per_day, max_upload_mb, note)` and `revoke_cloud_access(email)`; both are audited, and revoking cancels the account's queued jobs.
- The database enforces access and the daily limit in the job trigger, and the storage policy hides an uninvited member's cloud files. The service checks the list on every slicing and bridge request and refuses uploads over the account's limit.
- The upload scan is independent of this: the library needs it.

## Why Rust for the service

The service links `sx-core` directly, the same engine the desktop app and the CLI use. That means no child process per job, no temp files, one static binary in a small image, and meshes that never touch a filesystem path. A Node service calling `sx slice --request` would need a writable directory per job, would read mesh paths out of the request JSON, and would ship two runtimes in the image. The client stays TypeScript because every caller (app, mobile, MCP server) is TypeScript.

## Service

`sx-cloud` runs the API, the workers, or both (`SX_CLOUD_ROLE=all|api|worker`). Workers claim jobs from the `cloud_jobs` queue with `claim_cloud_job` (`FOR UPDATE SKIP LOCKED`), so any number of worker processes can share one database. A worker that stops sending heartbeats for 120 s loses its job to another worker. After three claims the job fails.

Every route except `/healthz` and `/v1/about` needs `Authorization: Bearer <credential>`. The credential is either the access token of a signed-in Supabase session, which may call every route and lets the app and the mobile app work without creating a token, or an `sxk_` API token resolved once per request with `resolve_api_token`. Tokens need the `cloud_slice` scope for meshes and jobs and the `link` scope for the device and delivery routes a bridge uses. A missing or unknown credential is 401; a token without the route's scope is 403. Each token request counts against the token's per-minute limit (`resolve_api_token` with `p_report_limit`); over it the answer is 429 with `Retry-After`. The caller's address is recorded as the token's last use.

| Route | Does |
| --- | --- |
| `GET /v1/about` | brand name, version and the source link (`legal.sourceUrl`); no credential |
| `GET /v1/access` | `{ invited: false }`, or `{ invited: true, jobsPerDay, jobsToday, maxUploadBytes }`; needs `cloud_slice` but no invite |
| `GET /v1/meshes/{sha256}` | 200 when the caller has uploaded this mesh, else 404 |
| `PUT /v1/meshes/{sha256}` | uploads a mesh (STL, raw `SXMP` parts or the benchmark JSON, up to the account's limit); the body must hash to the path |
| `POST /v1/jobs` | `{ name?, request, targetPrinterId? }` queues a job; `request` is an `sx slice --request` body whose object `mesh` values are SHA-256 ids of uploaded meshes |
| `GET /v1/jobs`, `GET /v1/jobs/{id}` | the caller's jobs with status, progress, stage, the result JSON and download paths |
| `POST /v1/jobs/{id}/cancel` | cancels a queued or running job |
| `GET /v1/jobs/{id}/gcode`, `/preview` | the G-code and the SXPV preview |
| `POST /v1/devices` | `{ name, kind }` registers a device (`link`, `desktop`, `web`, `mobile`) |
| `PUT /v1/devices/{id}/printers` | a bridge's printer list: `[{ localId, name, driver?, model? }]`; printers it leaves out are marked deleted |
| `GET /v1/devices/{id}/deliveries?wait=25` | open deliveries for a bridge; with `wait` the call is held until an offer arrives (at most 30 s) |
| `POST /v1/devices/{device}/deliveries/{id}/state` | `{ state, message? }` from the bridge; repeating the current state is accepted |
| `GET /v1/devices/{device}/deliveries/{id}/gcode` | the G-code of an open delivery, for its bridge |

Requests are checked before they are queued: schema version 1, 1 to 64 objects, engine `sx`, every mesh a hash the caller has uploaded. A `meshes` map of file paths is refused, so a request can never make a worker read a path. The worker checks each mesh against its hash again after download. A member can have five jobs queued or running at once. Every route except `/healthz`, `/v1/about` and `/v1/access` needs an invited account; otherwise the answer is 403 with code `not_invited`. Errors come back as `{ "error": { "code", "message" } }` with codes `unauthorized`, `forbidden`, `not_invited`, `not_found`, `bad_request`, `conflict`, `limit` (429 for the job and rate limits, 413 for an upload over the account's limit) and `unavailable`.

Results are stored in the private `cloud-results` bucket at `<user id>/<job id>/slice.gcode` and `slice.sxpv`, and uploads in `cloud-inputs` at `<user id>/<sha256>`. Members can read their own folders directly with their session, and the service reads and writes both with the service role.

Progress runs from 2 percent (fetching meshes) through 10 to 90 percent while slicing, driven by the core's stage reports from `run_request_with`, to 90 percent and up while uploading. The worker writes it when it moves by 2 points and at least every heartbeat. The core cannot stop mid-slice, so a job canceled while slicing finishes on the worker and its output is dropped.

### Library upload scan

A creator makes a listing and a version, uploads the file to the `uploads-quarantine` bucket and calls `submit_version`. The scan worker (`scan_worker.rs`) claims queued versions with `claim_scan`, reads the file and runs `sx-upload-scan`. A clean file is converted to an sx3mf and written to `listing-files` with a preview, and `finish_scan` records the report and the file manifest. A refused file is recorded as rejected and removed from quarantine. The worker never approves: `approve_listing` is the moderator's call. If `clamd` does not answer, the version stays claimed and `requeue_stale_scans` returns it to the queue later.

### Configuration

Public settings come from the edition config through `sx-edition-config` (`docs/integrating.md`, "Run the services"): `SLICERX_CONFIG` names the resolved JSON and the `SLICERX_*` overrides apply on top. The service refuses to start unless `features.cloudSlicing` is on. It reads the Supabase URL from `backend.supabase`, puts `brand.name` in its user agent and serves `legal.sourceUrl` at `/v1/about`, with `{commit}` filled from `SX_CLOUD_COMMIT`. Secrets and deployment settings stay in the environment:

| Variable | Default | |
| --- | --- | --- |
| `SX_CLOUD_SERVICE_KEY` | | the project's secret key (`sb_secret_...`, sent on the `apikey` header only) or the legacy service role key; never put it in a client or the edition config |
| `SX_CLOUD_BACKEND` | `supabase` | or `memory`, which keeps everything in the process |
| `SX_CLOUD_BIND` | `127.0.0.1:8787` | `0.0.0.0:8787` in the image |
| `SX_CLOUD_ROLE` | `all` | `api` or `worker` to scale them apart |
| `SX_CLOUD_WORKERS` | `1` | worker tasks per process; each slice uses all cores through rayon |
| `SX_CLOUD_WORKER_ID` | host name | prefix of the id stored on claimed jobs |
| `SX_CLOUD_COMMIT` | `main` | the deployed commit, for the source link |
| `SX_CLOUD_PURGE_INTERVAL_S` | `3600` | how often a worker process runs `purge_due_accounts` and deletes the purged accounts' files; `0` turns it off |
| `SX_CLOUD_RETENTION_DAYS` | `7` | days uploaded meshes and results are kept; the purge deletes older ones (`expire_cloud_files`) and the jobs lose their download URLs; `0` keeps everything |
| `SX_CLOUD_IDLE_EXIT_S` | | exit cleanly after this many seconds with no request (other than `/healthz`) and no job slicing, for hosts that start the service on demand (Fly.io) |
| `SX_CLAMD_ADDR` | | where `clamd` listens (`host:port` or `unix:/path`); turns on the library scan worker. There is no mode without the malware scan |
| `SX_SCAN_WORKERS` | `1` | scan worker tasks per process |
| `SX_SCAN_BLOCKLIST` | | a text file of SHA-256 hashes the library refuses |
| `SX_CLOUD_TRUST_FORWARDED` | | `1` behind a proxy that sets `X-Forwarded-For` |
| `SX_CLOUD_DEV_TOKEN` | | memory backend only: a token with both scopes for a local test user |

### Run it

```
service/run-local.sh             # against the stack; run it on the build machine
service/run-local.sh --memory    # no database; token sxk_local_dev
docker build -f editions/slicerx/packages/cloud/service/Dockerfile --build-arg COMMIT=$(git rev-parse HEAD) -t sx-cloud .   # from the repository root
SX_CLOUD_TOKEN=... service/smoke.sh <service url>   # upload, slice and download against a running service
```

The hosted deployment runs on Fly.io from `service/fly.toml`.

## Delivery to a printer

A job with `targetPrinterId` names one of the user's synced printers that a bridge reaches. When the job succeeds, a trigger adds a `cloud_deliveries` row in state `offered` for that bridge. The bridge (sx-link, or the desktop app acting as one) long-polls `GET /v1/devices/{id}/deliveries` over an outbound connection, so nothing listens on the user's network. Every poll returns all open deliveries (the bridge dedupes by id); with `wait` it returns early only when one is `offered`, and otherwise returns after `wait` seconds, possibly with `[]`. The G-code comes from the delivery's `gcodePath` on this service with the bridge's token.

The bridge downloads the G-code, checks its SHA-256, and raises a normal local approval: an `ApprovalRequest` with `printer.upload` and `printer.start` actions for that printer and file. Only the user's approval on that machine mints the token that the printer host checks. The cloud never holds or relays approval tokens and has no way to start a print. The database allows only these transitions, so a bridge cannot report `approved` without passing through `awaiting_approval`:

```
offered -> downloaded -> awaiting_approval -> approved -> uploaded -> printing
   any of the first three -> declined | failed | expired | canceled
   approved, uploaded -> failed
```

Offers expire after a day. The user can cancel one from any device with `cancel_cloud_delivery` until it is approved.

`createDeliveryAgent` in `src/delivery.ts` implements the bridge side in TypeScript over `PrinterHost` and `ApprovalHost` from `@slicerx/contracts`, for the desktop app. It uses `printer.start` with `{}` options and assumes the printer host keeps the file name on upload. A Rust puller for sx-link is planned and will follow the same protocol.

## Profile sync

`createProfileSync` keeps a local copy of the user's profiles, printers and fleets in a `KeyValueStore` (IndexedDB, a Tauri store or a mobile key-value store; `memoryStore()` for tests). Edits apply locally at once and survive restarts. `sync()` pushes pending edits through `sync_push` with the revision each was based on, then pulls everything above its cursor through `sync_pull`.

- Revisions come from one sequence, drawn under a per-user transaction lock, so a user's revisions follow commit order and pulling above the last seen revision never skips a row.
- Concurrent edits to different fields, or to different settings keys, merge automatically. Fleet membership merges as a set. Edits to the same key are kept as a conflict, and `resolve(entity, id, 'mine' | 'theirs')` settles them.
- A change whose answer was lost is recognized on the next push and is not applied twice.
- Deletions are tombstones (`deleted = true`); clients cannot delete rows.
- Printer rows never hold credentials or addresses. The database refuses `access_code`, `api_key`, `password`, `secret`, `token`, `host`, `ip`, `address` and `serial` in printer settings, and the client refuses them before they are queued.
- A rejected change is reported in `rejections()` and does not block the rest of the batch.

```ts
import { createProfileSync, supabaseSyncTransport } from '@slicerx/cloud/sync'

const sync = createProfileSync({
  transport: supabaseSyncTransport(supabase), // the signed-in supabase-js client
  store,                                      // a KeyValueStore
  userId: session.user.id,
  deviceId,                                   // from client.registerDevice
})
await sync.save('profile', { kind: 'filament', name: 'Generic PETG', settings: { nozzle_temperature: 240 } })
await sync.sync()
```

`createMemorySyncServer()` applies the same rules in memory, for tests and for running the app without a service.

## Client

```ts
import { createCloudClient, createJobOutbox, createCloudSlicer } from '@slicerx/cloud'

const cloud = createCloudClient({ baseUrl, credential: () => session?.access_token ?? token })
const job = await cloud.slicePlate({
  name: 'Bracket',
  meshes: { bracket: stlBytes },
  request: { plate: { objects: [{ id: 'a', mesh: 'bracket' }] }, config: { layer_height: 0.2 } },
  targetPrinterId,
})
```

Every call returns `CloudResult<T>`, `{ ok: true, value }` or `{ ok: false, code, message }`, and never throws for network or service errors; `offline` means the request did not reach the service. `slicePlate` uploads only the meshes the service does not have. `downloadGcode` checks the file against the reported hash. `createJobOutbox` queues plates sent while offline and submits them in order later, and keeps refused plates for the user. `createCloudSlicer` wraps the client as a `SlicerHost`, the shape of `EditionHost.cloud`. `access()` says whether the account is invited and how much of its daily limit is left, so the app can explain a refusal before uploading.

## Tests

```
cargo test -p sx-cloud                            # API, worker, progress, delivery, invite list, rate limit and purge rules on the memory backend
pnpm --filter @slicerx/cloud test                 # 25 tests; includes the real binary when target/debug/sx-cloud exists
supabase test db                                  # supabase/tests/cloud.test.sql (39) and cloud_access.test.sql (25), pgTAP
```

Two suites run against a local or LAN stack and skip otherwise: `service/tests/supabase.rs` (set `SLICERX_SUPABASE_URL` and `SX_CLOUD_SERVICE_KEY`) slices a job and walks its delivery through the database, and `test/sync.supabase.test.ts` (set `SLICERX_SUPABASE_URL`, `SLICERX_SUPABASE_ANON_KEY` and `SERVICE_ROLE_KEY`) syncs through `sync_pull` and `sync_push` as two signed-in users. Both create throwaway users and delete them afterwards.

## Status

- The service, the worker, the delivery states and the sync functions pass their tests on the memory backend and on the LAN development stack.
- The service runs on the development stack. The hosted deployment (Supabase plus Fly.io) is prepared in `service/fly.toml` and has not been launched.
- Not built yet: stopping a slice mid-run on cancel, per-job time and memory limits beyond what the container sets, an end to end run with the sx-link inbox puller (waiting on its download path check), and realtime subscriptions in the client (the tables are in the realtime publication).
