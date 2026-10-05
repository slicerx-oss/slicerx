<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright (C) 2026 The SlicerX contributors -->
# The .sxlock format

An `.sxlock` file is a locked SlicerX project: an `.sx3mf` (see `SPEC.md`) encrypted so that only the SlicerX account that exported it can open it. The `.sx3mf` format stays open and readable; `.sxlock` is a separate wrapper around it. Opening a locked file needs the account service, so it works only online and only while signed in as the owner, or through an integrator holding the owner's token with the `sxlock_open` scope.

Media type: `application/vnd.slicerx.sxlock`. Extension: `.sxlock`.

## Layout

All integers are single bytes. UUIDs are their 16 bytes in RFC 9562 order (the hex digits of the text form, without dashes).

| Offset | Size | Field | Value |
| --- | --- | --- | --- |
| 0 | 8 | magic | `89 53 58 4C 4F 43 4B 0A` (`\x89SXLOCK\n`) |
| 8 | 1 | version | `1` |
| 9 | 1 | format | `1`: the plaintext is an `.sx3mf` |
| 10 | 1 | cipher | `1`: AES-256-GCM with a 96-bit nonce and a 128-bit tag |
| 11 | 1 | reserved | `0` |
| 12 | 16 | owner | account id (Supabase `auth.users.id`) of the exporting account |
| 28 | 16 | key id | the account key the content key was derived from |
| 44 | 32 | salt | random, new for every file |
| 76 | 12 | nonce | random, new for every file |
| 88 | n + 16 | body | AES-256-GCM ciphertext of the `.sx3mf`, then the tag |

The 88 header bytes are the associated data of the encryption, so changing any of them makes the tag check fail. Readers refuse a file whose version, format, cipher or reserved byte they do not know, and never try another cipher.

The header names the owner's account id and nothing else about the project. Model names, metadata, thumbnails and settings are all inside the ciphertext. A future version that wants readable metadata puts it in the header on purpose, under a new version number.

## Keys

Every account has one or more 32-byte account keys, made by the server with a secure random generator and stored in the `sxlock` schema of the database (`supabase/migrations/0010_sxlock.sql`). No client role can read that schema, and no function returns a secret.

The content key of a file is

```
content_key = HMAC-SHA256(account_secret, "sxlock/v1" || owner || key_id || salt)
```

with `owner` and `key_id` as 16 bytes each and `salt` as 32 bytes. Each file gets its own random salt, so each file gets its own content key, and the server never stores per-file state. Instead of wrapping a random content key and storing the wrapped copy in the file, the server derives it again on demand: there is no wrapped key in the file to tamper with, and revoking an account key makes every file under it unopenable.

Exporting: the client makes a 32-byte random salt and calls `sxlock_seal(salt)` as the signed-in account. The server answers with the owner, the account's active key id (made on first use) and the content key. The client makes a random nonce, writes the header and encrypts the `.sx3mf` with the header as associated data.

Opening: the client reads the header, calls `sxlock_open(owner, key_id, salt)` and decrypts. The server refuses unless the caller is the owner, the key belongs to the owner and the key is not revoked.

## Rotation and revocation

- `rotate_sxlock_key()` retires the active key and makes a new one. Files locked before still open; new exports use the new key.
- `revoke_sxlock_key(id)` revokes one key for good. Every file locked with it stops opening, for everyone, including the owner. Use it when a file must not be opened again, or after a key may have been exposed.
- `sxlock_keys()` lists the account's keys (id, created, retired, revoked) without secrets.
- Deleting the account deletes its keys, so its locked files can no longer be opened.

## Refusals

The server raises an error whose `hint` names the reason; clients show one fixed sentence for each:

| Reason | When |
| --- | --- |
| `offline` | the account service could not be reached (set by the client) |
| `unavailable` | the build has no account service at all (set by the client) |
| `signed_out` | no session, or an API token that is unknown, expired or revoked |
| `wrong_account` | the caller is not the owner named in the header |
| `unknown_key` | the key id is not one of the owner's keys |
| `revoked` | the owner revoked the key |
| `missing_scope` | the API token lacks the scope for the call (`sxlock_open` or `sxlock_seal`) |
| `rate_limited` | the token used up its per-minute limit |
| `banned` | the account is banned |
| `invalid` | the request or the answer is malformed |

A reader also refuses with `not_sxlock` (wrong magic), `unsupported` (unknown version, format, cipher or reserved byte) and `damaged` (too short, or the tag check failed).

## Integrators

Every integrator uses the same path. It acts for one SlicerX account with an `sxk_` API token the account owner makes in SlicerX, and keeps that token in the system keychain. Two scopes cover locked projects, and a token gets only the ones it needs:

- `sxlock_open`: `sxlock_open_with_token(token, owner, key_id, salt)` returns the content key of a file whose header names the token's own account.
- `sxlock_seal`: `sxlock_seal_with_token(token, salt)` returns a content key for a new file under the account's active key.

Both are callable with the edition's public anon key and count against the token's per-minute limit. A token never lists keys, rotates or revokes them; those need a signed-in session.

There are three ways in, all on that token:

- MCP: `@slicerx/mcp` has `slicerx_sxlock_open`, `slicerx_sxlock_export` and `slicerx_sxlock_inspect` (its README, "Locked projects").
- Code: `@slicerx/embed/sxlock` has `openSxlock`, `sealSxlock`, `readSxlockHeader` and `tokenKeys`. It runs wherever WebCrypto does (browsers, Node 20 and later, Electron).
- An app that embeds the SlicerX app: set `EditionHost.sxlock` to `tokenKeys(...)`, and Export and Open in the app use the token instead of a session.

```js
import { openSxlock, sealSxlock, tokenKeys, SxlockError } from '@slicerx/embed/sxlock'

const keys = tokenKeys({ supabaseUrl, anonKey, token })
try {
  const sx3mf = await openSxlock(new Uint8Array(fileBytes), keys) // needs sxlock_open
  const locked = await sealSxlock(sx3mf, keys) // needs sxlock_seal
} catch (e) {
  if (e instanceof SxlockError) show(e.message) // e.code: offline, wrong_account, revoked, missing_scope, damaged...
}
```

What a typical integrator needs to handle:

- Listing: tell locked files by their magic, and read the owner from the header with `readSxlockHeader` (offline). Nothing on the server lists files, since it keeps no per-file state; a file whose owner is not the token's account can be marked as locked to another account without a request.
- Opening: needs the network every time. The decrypted `.sx3mf` is the owner's project in the clear; keep it in memory or private storage, never next to the locked file.
- Exporting: only with a token that has `sxlock_seal`, and always for the token's own account.
- Errors: `SxlockError.code` is one of the reasons above and `message` is a sentence ready to show. `offline` and `rate_limited` are worth a retry button. `missing_scope` means the person should make a token with the right scope. The rest are final for that file.

## Security notes

- AES-256-GCM comes from the platform's WebCrypto. Nothing in the format is hand-written cryptography.
- Every file has its own content key, and every write of it a new random nonce.
- The server sees content keys when it derives them. It is trusted to hold the account secrets in any case.
- Offline opening is impossible by design. A client keeps the project that is open when a locked file is refused.
- Copies of an open locked file, such as autosaves, are written as `.sxlock` with the same owner, key id, salt and content key and a fresh random nonce each time (`resealSxlock`). The content key is held in memory as a non-extractable key and never stored, so no copy of a locked project is ever written in the clear, and restoring one needs the account like the file itself. A random 96-bit nonce stays safe far beyond any realistic number of saves under one key.
- The owner's account id in the header is visible to anyone holding the file.
