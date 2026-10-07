# @slicerx/store

Typed client for sign-in, personal API tokens, paired devices and the free, moderated model library. It implements `AuthClient` and `StoreClient` from `@slicerx/contracts` in two modes: against a Supabase project, or offline from the seed in `seed/*.json`.

The library is free. Creators upload models, the upload scan checks the files, and staff approve each listing before anyone else sees it. The database (`supabase/migrations/0001_auth.sql` and `0002_store.sql`) holds every rule. This package is a thin client over PostgREST, RPC and storage, plus a few checks that save a network trip.

## Entry points

| Import | Gives | Database modules it needs |
| --- | --- | --- |
| `@slicerx/store/auth` | `createAuth(opts): AuthClient` | auth |
| `@slicerx/store` | `createStore(opts): StoreClient` (includes everything in `AuthClient`), plus the pure checks below | auth, store |

The store is removable. The app reaches it only through `StoreClient`, and a build without it imports `@slicerx/store/auth` alone. Paired devices, roles and bans belong to the auth module, so they work without the store.

Apps build the client from the edition config (`@slicerx/edition-config`) rather than wiring endpoints themselves:

```ts
import { editionFromBuild } from '@slicerx/edition-config'
import { createEditionAuth, createEditionStore } from '@slicerx/store'

const config = editionFromBuild()               // loadEditionConfig() in Node
const store = createEditionStore(config, {
  kind: 'desktop',                              // 'web' | 'desktop' | 'mobile'
  openExternal: (u) => host.auth.openExternal(u), // desktop and phone: opens the system browser
  storage,                                      // desktop and phone: keychain-backed AuthStorage
})
const auth = createEditionAuth(config, { kind: 'web', origin: location.origin })
```

The config decides everything else:

| Config field | Effect |
| --- | --- |
| `backend.supabase` | project URL and anon key. The config schema refuses a service role key. |
| `features.store` | `createEditionStore` returns null when it is off. `createEditionAuth` still works. |
| `features.demoData` | serves the bundled demo library offline, with no backend |
| `features.feed` | switches off the storefront feed. |
| `auth.providers` | the sign-in methods offered, in order. `signInMethods()` lists them, and any other method is refused. |
| `apps.web.origin` | web redirect: `<origin>/auth/callback` (the page origin is used when unset, for local development) |
| `apps.deepLinkScheme` | desktop and phone redirect: `<scheme>://auth/callback` |

`createStore(options)` and `createAuth(options)` take the same settings directly, for tests and tools.

Mutations return `StoreResult<T>`, either `{ ok: true, value }` or `{ ok: false, code, message }`, and do not throw. For moderation and other database rules, `message` is the database's own text, so a screen can show why a call was refused.

## The library

Reading, for anyone (a signed-in member also gets likes and follows):

- `listListings({ cursor, limit, tag, creatorId, query, sort, status })` returns approved listings, newest first or by popularity. Other statuses show only what the caller may see: their own, or all for staff.
- `feed({ cursor, limit, category })` is the storefront feed: approved listings with the reason each is shown.
- `getListing(idOrSlug)` returns the listing, its creator and the versions the caller may see.
- `getCreatorByHandle(handle)` returns the page with links, featured models in order and approved listings. `listCreators({ query, limit })` is the directory: only creators with an approved listing, unless the caller is staff or the creator.
- `trending({ days, limit })` ranks approved listings by what happened in the last `days` days (7 by default): a like counts 3, a make 5 and a download 1. Listings with nothing in the window are left out.
- `newCreators({ days, limit })` lists creators whose first approved listing went live in the last `days` days (30 by default), newest first.
- `recommended({ limit })` is "based on your likes": approved listings that share tags or a creator with the member's likes, without the ones they liked or uploaded. Empty when signed out or without likes.
- `comments`, `makes`, `printProfiles`, `files`, `listingStats`.

The database runs these as `trending_listings`, `new_creators` and `recommended_listings`; the offline store runs the same rules from `src/ranking.ts`, against the bundled catalog's latest activity rather than the real date.

Members save designs to a private Saved list with `setSaved(listingId, saved)` and read it with `savedListings()`. It is a collection of kind `saved`, made on the first save, never public and left out of `collections()`.

A listing is `pending`, `approved`, `rejected`, `archived` or `removed`. New listings start pending, and editing an approved or archived listing sends it back to review. Creators move their own listings with `archiveListing` (approved to archived), `unarchiveListing`, `resubmitListing` (rejected to pending) and `deleteListing` (pending, rejected or archived only). `myListings()` lists every status, and `creatorDashboard()` returns likes, comments, makes and downloads per listing.

Members like, comment (`addComment`, `editComment` for the body only, `deleteComment` through the database function, which removes the text), add makes, keep collections and follow creators.

Comments and collections are deferred past v1. `createEditionStore` turns them off (`DEFERRED_PAST_V1`, through `StoreFeatures.comments` and `StoreFeatures.collections`): reads return nothing and writes fail with `unavailable`. The tables, policies and client code stay, so turning them on later is a one-line change. `createStore` without features leaves them on. `download(listingId)` counts the download and returns a signed URL for the newest approved file in the `listing-files` bucket. Sign-in is required, and offline it returns a `seed://` address.

## Uploading a model

`uploadVersion(listingId, { name, version, changelog, bytes, format })` does the whole trip:

1. Checks the file before any network call: a lowercase name ending `.3mf`, `.sx3mf` or `.stl` that matches `format`, a version like `1.0.0`, and a size from 1 byte up to the library's limit. The limit and the accepted formats come from `getLibrarySettings()` (100 MB and all three formats when the settings cannot be read, and offline).
2. Computes the SHA-256 and inserts the `listing_versions` row with `storage_path` set to `<listing id>/<version id>/<file name>`.
3. Uploads the bytes to the `uploads-quarantine` bucket at that path.
4. Calls `submit_version`, which queues the scan.

An earlier attempt that never finished uploading is picked up again when the same version and file are sent. `getScanStatus(versionId)` reports the scan and review status, and `getScanReport(versionId)` returns the report for the creator and staff. A clean upload waits for review; in moderation mode `trusted-creators`, clean uploads from trusted creators go live at once, and in `auto-after-scan` every clean upload does.

Offline, the scan runs at once and checks the file signature (a zip archive for 3MF and SX3MF, a valid STL), so a bad file is rejected the way the real scan would reject it.

## Creator pages

One member has at most one page. `saveCreator({ handle, displayName, tagline, bio, location, logoUrl, bannerUrl, status })` makes it on the first call and updates it after, and the member becomes a creator. `setCreatorLinks(links)` replaces all links, and `setFeatured(listingIds)` replaces the featured models (up to six approved ones, in order). The first featured model is the page's pinned design.

`uploadCreatorImage({ kind, bytes, contentType })` stores a banner or logo (PNG, JPEG or WebP, up to 5 MB) in the public `creator-media` bucket under the member's id and returns its URL for `saveCreator`. Saving a new image removes the old ones the page no longer uses.

Links are checked on the device before saving, with the same rules as the database. `validateCreatorLink` is a pure function, exported for forms:

- https only, a plain host with a top level domain, at most 300 characters, and a label of 1 to 60 characters when given.
- A named service must point at its own domain: `patreon` at patreon.com, `youtube` at youtube.com or youtu.be, `x` at x.com or twitter.com, and so on. `website` and `other` accept any host.
- At most 12 links per page, and no address twice (`validateCreatorLinks`).

`validateUpload`, `validateHandle`, `validateDevice` and `slugify` are exported the same way. All of them are also at `@slicerx/store/validate`, which has no dependencies, so forms can use them without loading the client.

## Moderation

Staff calls. The database decides who may act, and the error carries its message.

- `moderationQueue()` returns pending listings and approved listings with a new version waiting, with a `ready` flag when every waiting file passed the scan.
- `approveListing(id, note?)`, `rejectListing(id, reason)` and `removeListing(id, reason)`. A reason is required (3 characters or more) and is shown to the creator. Approval needs every waiting file to have passed the scan.
- `banUser(userId, reason)` and `unbanUser(userId, reason?)`. A moderator cannot ban the owner, another moderator or themselves. A ban revokes API tokens and hides the person's page and listings.
- `auditLog({ limit, before })` reads the append-only log, newest first.
- `getModerationMode()`, `getLibrarySettings()` (mode, `maxFileMb`, `allowedFormats`, readable by everyone) and, for the owner, `setModerationMode('owner-approves-all' | 'moderators' | 'trusted-creators' | 'auto-after-scan')`. In `owner-approves-all` only the owner approves, and in the other three moderators approve too. `trusted-creators` also publishes a clean upload from a creator the owner marked trusted (`setCreatorTrusted(creatorId, trusted)`), and `auto-after-scan` publishes every clean upload, leaving staff to review afterwards and remove.
- `setUserRole(userId, role, reason?)` (owner only) assigns moderator, creator or member. `myRole()` answers `owner`, `moderator`, `creator`, `member`, `banned`, or null when signed out.

The offline client follows the same rules in memory. It has a demo user for each role, and you switch between them with `signInWithEmail`:

| Email | Role |
| --- | --- |
| `owner@example.com` | owner |
| `moderator@example.com` | moderator |
| `marrow@example.com`, `tidewell@example.com`, `kestrel@example.com`, `oddfellow@example.com`, `ferro@example.com` | creator |
| `rv@example.com` (the default), `ash@example.com` and others | member |
| `zed@example.com` | banned member: sign-in is refused, and `createStore({ offline: true, signedInAs: 'zed' })` shows every action refused |

## Sign-in

Both builds use PKCE, and the client never reads the URL on its own, so the host decides when a callback is complete.

In the browser, `signInWithEmail(email)` or `signInWithOAuth('github' | 'google' | 'apple')` returns to `/auth/callback`, and that route calls `store.completeSignIn(location.href)`. The session persists in localStorage.

On the desktop and the phone, the provider page opens in the system browser through `openExternal`. The OS delivers `<scheme>://auth/callback?code=...` to the app's deep link handler, which calls `store.completeSignIn(url)`. The session and its refresh token persist through the `AuthStorage` the host passes in, backed by the OS keychain.

`isAuthCallback(url, scheme)` tells whether a URL is one of these callbacks.

## Local Supabase auth settings

`pnpm --filter @slicerx/store supabase:config` rewrites the marked auth blocks in `supabase/config.toml` from the edition config (`SLICERX_CONFIG`, else `editions/slicerx/edition.config.ts`). It writes the site URL and the allowed redirects (the web origin, the local dev server and the deep link), and it enables each OAuth provider listed in `auth.providers` with its public client id. Provider secrets come from `SUPABASE_AUTH_EXTERNAL_<PROVIDER>_SECRET` in the environment. `--check` fails when the file is out of date, and a test runs the same check.

## Access token

`getAccessToken()` returns the signed-in user's access token, a short-lived JWT, for calling edition services such as cloud slicing. When fewer than 60 seconds remain before it expires, it refreshes the session first and stores the new one. It returns null when signed out, and always null offline. `onTokenChange(cb)` reports the token after sign-in and each refresh, and reports null after sign-out. The session lives under the key `sx-auth` in whichever `AuthStorage` the host passes. On the web that's `webAuthStorage(localStorage)` or the default. On desktop and phone it's a keychain-backed store.

## API tokens

`createApiToken({ name, scopes, expiresInDays })` returns the token record and the secret. The secret starts with `sxk_` and is shown only this once. Scopes are `read`, `mcp`, `cli`, `cloud_slice`, `link` (the sx-link bridge pulling cloud deliveries) `sxlock_open` and `sxlock_seal` (an integrator opening or making the member's locked projects). Tokens expire after 90 days unless another value from 1 to 365 is given, and `null` means no expiry. A user can hold 20 active tokens, and none can be created while the account is scheduled for deletion. `apiTokens()` lists the user's tokens without secrets, and `revokeApiToken(id)` revokes one. The database keeps only a SHA-256 hash of each token.

A token's rate limit is 60 requests per minute unless `rateLimitPerMinute` sets another value from 1 to 600. The cloud service passes each token to `resolve_api_token` with the client address. The database counts requests per token and minute, records the last address and time it accepted, and refuses requests over the limit. `revokeAllApiTokens()` revokes every active token at once.

## Locked projects

A locked project (`.sxlock`, `packages/sx3mf/SPEC-sxlock.md`) opens only for the account that exported it. The account's 32-byte secret lives in the `sxlock` schema of the database (`supabase/migrations/0010_sxlock.sql`), which no client role can read. `sxlockSeal(salt)` returns a content key for a new file under the account's active key, and `sxlockOpen({ owner, keyId, salt })` returns it again, only to the owner and only online. `sxlockKeys()` lists the keys without secrets. `rotateSxlockKey()` retires the active key: files made with it still open, new ones use the new key. `revokeSxlockKey(id)` stops every file made with that key from opening, for good. Failures carry a `reason` (`offline`, `signed_out`, `wrong_account`, `revoked`, `unknown_key`, `missing_scope`, `rate_limited`, `banned`, `invalid`). The offline client answers `offline` to all of them.

## Paired devices

The pairing flow (`packages/pair`) links phones and other devices to the account. The table lives in the auth module, so the methods are on `AuthClient`:

- `listPairedDevices()` returns the account's devices, newest first, revoked ones included.
- `addPairedDevice({ deviceId, name, platform, signPub })` links a device. An account holds at most 10 active devices.
- `revokePairedDevice(id)` sets `revoked_at`. A device stays revoked.
- `onPairedDeviceChange(cb)` reports `{ type: 'added' | 'revoked', device }` from any client, through a Realtime channel on `paired_devices` filtered by the member's id, so a revoked phone is noticed at once. It follows sign-in and sign-out. Offline it reports this client's own changes.

## Your account

`exportMyData()` returns one JSON document with everything stored about the member: account email and dates, profile, API tokens (without their hashes), paired devices, likes, downloads, follows, comments, makes, collections, the creator page, listings, listing versions and creator links, and the synced profiles, printers, fleets, devices and cloud jobs when the cloud module is on. Sections for modules an edition leaves out are missing from the document.

`requestAccountDeletion()` schedules deletion 30 days out and revokes the member's API tokens straight away. `cancelAccountDeletion()` undoes the request during those 30 days, and `pendingAccountDeletion()` reports it. `accountDeletionPolicy()` returns the list of what is removed and what is kept, for the confirmation screen. The owner account cannot request deletion: hand the owner role over first. When the grace period ends, the service calls `purge_due_accounts()`, which removes the account, its creator page and its uploads, and returns the purged ids so the service can delete files stored under them.

## Privacy

What the database stores about a member:

- Sign-in data: email address, sign-in identities and session records, which the auth service keeps.
- Profile: handle, display name, avatar URL, role, and a ban time and reason when staff banned the account.
- API tokens: name, scopes, rate limit, creation, expiry and revocation times, and the time and client address of the last accepted request. The token itself is stored only as a SHA-256 hash.
- Paired devices: name, platform, the public signing key, and link and revocation times.
- Library activity: likes, follows, comments, makes, collections, and a download count per listing.
- Creator data, for creators: the page, links, featured models, listings and versions with their files, and the review notes staff wrote.
- Cloud data, when the cloud module is on: synced profiles, printers, fleets, devices, and cloud slicing jobs and deliveries.

Deleting an account removes all of that. Three things are kept. Comments stay with the author and text removed, so replies keep their thread. Moderation audit entries about the account stay, with actor and target ids only. A record that the account id was deleted, and when, is also kept. Offline and demo mode store nothing on a server.

## Seed

`src/seed/generate.ts` builds the seed from a fixed PRNG and fixed dates. `pnpm --filter @slicerx/store seed:write` writes `seed/*.json` (database row shapes, one file per table) and `supabase/seed/*.sql` (`auth.sql`, then `store.sql`) from the same data, so offline mode and the local stack match. A test fails if either output drifts from the generator. Every creator and member in it is fictional, and the models are generic objects.

The seed has one owner, one moderator, five creators with pages (logos, links and featured models), thirteen members with one of them banned, 26 listings (20 approved, 3 pending, 1 rejected with a note, 1 archived, 1 removed), versions that passed the scan, print profiles, likes, comments, makes, collections, follows, downloads, an audit log, and moderation mode `owner-approves-all` (100 MB, all three formats). `auth.sql` creates the users and then sets roles and bans with `update` statements, because the sign-up trigger makes every profile a member. `audit_log.id` is an identity column, so `store.sql` leaves it to the database.

## Tests

`pnpm --filter @slicerx/store test` runs the seed, offline client, moderation rules, link and upload checks, account and paired device tests. They use no network and no wall clock, and they write the `store-*.json` contract fixtures.

Integration tests run against the local stack and are skipped unless the edition's `SLICERX_SUPABASE_URL` and `SLICERX_SUPABASE_ANON_KEY` point at a loopback or private network address:

```
eval "$(supabase status -o env | grep -E '^(API_URL|ANON_KEY|MAILPIT_URL)=')"
SLICERX_SUPABASE_URL=$API_URL SLICERX_SUPABASE_ANON_KEY=$ANON_KEY MAILPIT_URL=$MAILPIT_URL pnpm --filter @slicerx/store test
```

They read the seeded library as a visitor, sign in through the real magic link and PKCE exchange, check the access token's claims, create and revoke API tokens, export the member's data, schedule and cancel account deletion, link and revoke a paired device while listening on Realtime, and read the review queue as the moderator.

`pnpm --filter @slicerx/store gen:types` regenerates `src/generated/database.ts` from the local stack.

## Dependencies

- `@supabase/supabase-js` 2.117.2: auth (PKCE), PostgREST, Realtime and storage client.
- `zod` 4.6.5: validates rows at the network boundary.
- `tsx` 4.23.15 (dev): runs the seed writer.
- `vitest` 5.0.2 (dev): tests.
- `@types/node` 24.19.0 (dev): Node types for the seed writer and tests.
- `@slicerx/edition-config` (workspace): the edition config types the store reads.

## Status

- Offline mode covers all of `AuthClient` and `StoreClient` and applies the database's rules: pending until approved, owner-only approval in mode `owner`, reasons on rejection, an audit log, and banned members refused.
- Offline API tokens and paired devices live in memory and work nowhere else.
- Avatar and make photo uploads, and a realtime feed, are not built yet.
