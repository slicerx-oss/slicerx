# Cloud slicing from a partner app

A phone app, or any app that can't run the SlicerX engine or the MCP server itself, can slice in the SlicerX cloud over plain HTTPS. The app slices on the person's own SlicerX account, with a token the person issues to that app and can revoke at any time. Every slice counts against that account's daily cloud slices. There is no partner billing: the person's account limits are the only limits.

This page is the HTTP API such an app calls: getting the token, keeping it, the routes, the limits, the errors and the downloads. The same API is behind `slicerx_cloud_slice`, `slicerx_cloud_jobs` and `slicerx_cloud_access` in the MCP server, so a desktop app can use those tools instead (see "From the MCP server" below).

Cloud slicing is invite only while SlicerX is pre-alpha. An account that isn't on the invite list can issue a token, but every slicing route answers `not_invited` until the account is invited. `GET /v1/access` tells you which case you're in.

## What a partner app token can do

The token is an `sxk_` API token with the `cloud_slice` scope and nothing else.

- It uploads meshes and 3MF projects, queues slicing jobs, reads them back and downloads their G-code and previews.
- It sees only the jobs it queued. The person's own jobs, from the SlicerX app or their own tools, and the jobs of other partner apps stay hidden; asking for one answers `404 not_found`.
- It can't send a job to a printer. A job with `targetPrinterId` is refused with `403 forbidden`. Send the G-code to the printer through your own printer connection, where the person approves the print as usual. Nothing in this API starts a print.
- It has no other rights in the account: no profiles, no library, no printers or bridges, no settings, no other tokens.
- It always expires, after 30 days, 90 days or a year (the person picks). It allows 60 requests per minute.

## Getting a token

The person makes it in SlicerX:

1. In SlicerX, sign in and open Settings, Account.
2. Under Partner apps, type your app's name, pick how long the token lasts and press Create token.
3. Copy the token (`sxk_` and 64 hex digits) and paste it into your app. SlicerX shows it once and keeps only a hash of it.

The token is listed under Partner apps with your app's name, when it expires and when it was last used. Revoke ends it at once: the next request with it answers `401 unauthorized`. The person can make more than one token for the same app, one per phone, say.

Your app can't make a token on its own, and no API makes one from a partner's side. The person's own sign-in makes it, in SlicerX.

## Keeping it

Treat the token like a password.

- Keep it in the device's secure storage: the iOS Keychain, the Android Keystore (EncryptedSharedPreferences or an equivalent), or the desktop's keychain or credential manager. Never in plain app settings, a database, a log, a crash report or analytics.
- Send it only in the `Authorization` header. Never put it in a URL, a query string, a deep link or a QR code that leaves the device. The service never reads a token from a URL.
- When the service answers `401 unauthorized`, the token is unknown, expired or revoked. Stop using it, delete it from storage, and ask the person for a new one. Don't retry with the same token.

## The service

The base URL is the cloud service the edition runs (`backend.cloudApi` in its edition config, the same address the SlicerX app uses). Every request goes over HTTPS. All bodies are JSON except mesh uploads and downloads.

Every route except `GET /v1/about` needs `Authorization: Bearer <token>`.

| Route | Does |
| --- | --- |
| `GET /v1/about` | the service's name, version and source link; no token |
| `GET /v1/access` | whether the account is invited, its slices per day, slices in the last 24 hours, the largest upload, and `partnerApp`, your app's name as the person typed it |
| `GET /v1/meshes/{sha256}` | 200 when the account already has this mesh, 404 when you need to upload it |
| `PUT /v1/meshes/{sha256}` | uploads a mesh: STL or a 3MF project, as it is or gzip compressed with `Content-Encoding: gzip`; the bytes must hash (before compression) to `{sha256}` |
| `POST /v1/jobs` | queues a slicing job |
| `GET /v1/jobs` | the jobs this token queued, newest first; `?limit=` 1 to 100, default 20 |
| `GET /v1/jobs/{id}` | one job: status, progress, stage, result and download paths |
| `POST /v1/jobs/{id}/cancel` | cancels a queued or running job |
| `GET /v1/jobs/{id}/gcode`, `/preview` | the G-code and the SXPV preview |
| `GET /v1/jobs/{id}/plates/{n}/gcode`, `/preview` | plate `n`'s G-code and preview, for a job that named plates |

The device and delivery routes in the cloud service's README are for the person's printer bridge and need the `link` scope, which a partner app token never has.

### Check access first

```http
GET /v1/access
Authorization: Bearer sxk_...
```

```json
{ "invited": true, "jobsPerDay": 20, "jobsToday": 3, "maxUploadBytes": 26214400, "partnerApp": "My Phone App" }
```

`{ "invited": false, "partnerApp": "My Phone App" }` means the account is not on the invite list yet. Show the person that before you upload anything. `jobsPerDay` minus `jobsToday` is how many slices are left; each plate a job names counts as one.

### Upload the model

Hash the file's bytes with SHA-256 (lowercase hex). Ask whether the account has it, and upload it only on a 404:

```http
GET /v1/meshes/9f2c...e1
Authorization: Bearer sxk_...
```

```http
PUT /v1/meshes/9f2c...e1
Authorization: Bearer sxk_...
Content-Type: application/octet-stream
Content-Encoding: gzip

<the gzip compressed file>
```

The answer is `201` with `{ "sha256", "bytes" }`. The account's upload limit (`maxUploadBytes`) and the 50 MB request limit count the body as sent, so compress when that makes it smaller. A gzip body may inflate to at most 200 MB. A body that doesn't hash to the path is refused with `400 bad_request`. Meshes are per account: uploading the same file again is a no-op.

### Queue a job

```http
POST /v1/jobs
Authorization: Bearer sxk_...
Content-Type: application/json

{
  "name": "Bracket",
  "request": {
    "schemaVersion": 1,
    "plate": { "objects": [{ "id": "o0", "name": "bracket.stl", "mesh": "9f2c...e1" }] },
    "config": { "layer_height": 0.2, "sparse_infill_density": "15%" },
    "options": { "engine": "sx", "emitGcode": true, "emitPreview": true }
  }
}
```

`request` is an `sx slice --request` body (`sx schema request` prints its JSON Schema, and [engine-path.md](engine-path.md) explains it), with one difference: each object's `mesh` is the SHA-256 of a mesh this account uploaded, never a file path. Requests are checked before they are queued: schema version 1, 1 to 64 objects, engine `sx`, and every mesh uploaded. `config` takes the printer's, filament's and process's settings as one object of setting keys; leave a key out and the engine's default applies.

For a 3MF project, `options.plates` (1 to 32 plate numbers from 1 to 1000, each once) slices those plates, each on its own, and each counts as one of the day's slices. Without it a project slices its first plate.

The answer is `202` with the job, status `queued`.

### Wait for it

Poll `GET /v1/jobs/{id}` every 2 to 5 seconds while the app is open. There is no push for cloud jobs. `status` is `queued`, `running`, `succeeded`, `failed` or `canceled`; `progress` goes from 0 to 1 and `stage` names the step. A job that names plates has `plateCount` and, while it runs, `plateIndex`.

```json
{
  "id": "6a1d...",
  "name": "Bracket",
  "status": "succeeded",
  "progress": 1,
  "result": { "schemaVersion": 1, "layerCount": 100, "stats": { "timeS": 2710, "filamentG": [8.4] }, "gcodeSha256": "41b0...", "warnings": [] },
  "gcodeUrl": "/v1/jobs/6a1d.../gcode",
  "previewUrl": "/v1/jobs/6a1d.../preview",
  "createdAt": "2026-11-05T21:04:11Z",
  "finishedAt": "2026-11-05T21:04:19Z"
}
```

A failed job has `error` in plain words. A job that named plates has `result.plates`, each plate's own report, and `plates: [{ plate, gcodeUrl, previewUrl }]` for each plate that sliced. A result with collisions lists them in `result.collisions` (and each plate's), with `collisionPlate` naming the plate.

### Download the result

`gcodeUrl` and `previewUrl` are paths on the same service. Fetch them with the same `Authorization` header; they are not signed links and don't work without it.

```http
GET /v1/jobs/6a1d.../gcode
Authorization: Bearer sxk_...
```

Check the G-code against `result.gcodeSha256` before you send it to a printer. The preview is an SXPV file (`readPreview` in `@slicerx/contracts` reads it). Results and uploads are kept for 7 days after a job finishes; after that the job has no download paths and the files answer 404.

## Limits

| Limit | Value | Answer when over it |
| --- | --- | --- |
| Slices per rolling 24 hours | the account's, 20 by default; shared by the person's app, their tools and every partner app on the account; canceled jobs count | `429 limit`, no `Retry-After` |
| Jobs queued or running at once | 5 per account | `429 limit`, no `Retry-After` |
| Requests per minute | 60 per token | `429 limit` with `Retry-After` in seconds |
| Largest upload | the account's (`maxUploadBytes`, 25 MB by default), as sent | `413 limit` |
| Request body | 50 MB for a mesh, 256 KB for a job | `413` |
| Objects per job | 64 | `400 bad_request` |
| Plates per job | 32 | `400 bad_request` |
| Kept files | 7 days after the job finishes | `404 not_found` |

## Errors

Every refusal is JSON:

```json
{ "error": { "code": "limit", "message": "this account has used its 20 cloud slices for the last 24 hours" } }
```

Branch on `code`; show `message`.

| Status | Code | Meaning | What to do |
| --- | --- | --- | --- |
| 400 | `bad_request` | the request is malformed, or names a mesh that isn't uploaded | fix the request |
| 401 | `unauthorized` | no token, or it is unknown, expired or revoked | delete the token and ask the person for a new one |
| 403 | `forbidden` | the token lacks `cloud_slice`, or a partner app token named a printer | don't retry |
| 403 | `not_invited` | the account isn't on the invite list | tell the person; slice on the device if you can |
| 404 | `not_found` | no such job or file for this token, or the files expired | |
| 409 | `conflict` | cancel of a job that already finished | |
| 413 | `limit` | the upload is over the account's limit | simplify the model |
| 429 | `limit` | daily slices or five active jobs (no `Retry-After`), or the token's rate (with `Retry-After`) | wait; never retry a daily limit in a loop |
| 502 | `unavailable` | the service couldn't reach its storage | retry later with backoff |

## From the MCP server

A desktop partner app that runs `@slicerx/mcp` as a child process gets the same API through tools. Start the server with `--cloud-api <url>` and give it the partner app token in the environment (`SLICERX_MCP_CLOUD_TOKEN`) or in the system keychain under `slicerx-cloud` or a `slicerx-cloud-<name>` item named by `SLICERX_MCP_CLOUD_KEY_REF` (account `slicerx`). Never on the command line.

| Tool | Does |
| --- | --- |
| `slicerx_cloud_access` | reads back the token: invited, slices per day, used and left, the largest upload, `partnerApp`, and `jobsVisible` (`own` for a partner app token) |
| `slicerx_cloud_slice` | uploads a model or 3MF project and queues a job; never names a printer |
| `slicerx_cloud_jobs` | one job or the recent ones, with each plate's result and downloads |

A revoked or expired token comes back as `auth_failed`, and the message says to ask the person for a new token.

## Testing your app

Run the cloud service on your own machine with the memory backend: `editions/slicerx/packages/cloud/service/run-local.sh --memory`, with `SX_CLOUD_DEV_PARTNER_TOKEN=sxk_<anything>` set to make a partner app token for the local test account (20 slices a day, 25 MB uploads). Nothing is saved, and no real account is touched. The service then listens on `http://127.0.0.1:8787`; use plain HTTP only against your own machine.
