# @slicerx/pair

Pairs a phone with SlicerX on a desktop or in a browser, then lets the phone browse printers, request slices and send print jobs. Every message between the two is end-to-end encrypted with a key only the paired devices hold. Anything that heats, moves or starts a printer still waits for a person to approve it, on the host's approval card or on an approver phone.

The threat model is in [SECURITY.md](SECURITY.md).

## Entry points

| Import | Gives | Runs in |
| --- | --- | --- |
| `@slicerx/pair` | everything below, plus identities, stores and transports | anywhere |
| `@slicerx/pair/host` | `createPairHost` | desktop app, browser app |
| `@slicerx/pair/client` | `createPairClient` | the phone app |
| `@slicerx/pair/relay` | `createMemoryRelay`, `RELAY_LIMITS`, `routeAllowed` | tests, and the reference for the hosted relay |

The package is plain TypeScript. Its crypto comes from `@noble/curves`, `@noble/hashes` and `@noble/ciphers`, which have no native parts, so the same code runs in browsers, Node, Tauri webviews and React Native.

## Pairing

The host calls `createOffer()` and gets a link for a QR code and a short code for typing:

```ts
const offer = host.createOffer()
showQr(offer.link)          // slicerx://pair#v=1&o=...&s=...&k=...
showCode(offer.code)        // 7KQ4-M2XD-9PH0, valid 5 minutes
offer.onAttempt(async (attempt) => {
  showDigits(await attempt.sas)          // "482 913"
  // The person compares with the phone, then:
  attempt.confirm()                      // or attempt.reject()
  const r = await attempt.result
})
```

On the phone:

```ts
const flow = await client.pair(scannedOrTyped)
showDigits(await flow.sas)
flow.confirm()                           // after the person says both screens match
const r = await flow.result              // { ok: true, hosts: [...] }
```

The link carries a one-time offer id, a 32 byte secret, the host's ephemeral X25519 key, the host name, the host's LAN addresses and its relay. The short code (11 random symbols and a check symbol) derives the offer id and secret, and works through the relay only. Either way, an offer serves one phone and burns after five wrong proofs.

Both sides then run the handshake in `src/handshake.ts`: an X25519 exchange where the phone commits to its nonce before it sees the host's. Both screens show six digits derived from the whole transcript. The pairing is stored only after the person confirms on both screens. The phone's device name and identity keys travel inside the encrypted confirm, never in the clear.

Pairings are listed and revocable on both sides: `host.devices()`, `host.revoke(id)`, `host.setRights(id, rights)`, `client.hosts()` and `client.unpair(id)`. A revocation reaches the other side when it is online and takes effect at once on the side that made it.

### Rights

Each pairing carries `{ request, approve, introduce }`. `request` sends slices and jobs, `approve` decides approval requests, and `introduce` vouches for a new device of the same account. The host's copy is the one that counts; the phone gets it from `host.info` for its UI. By default a phone gets `request` and `approve`, and `introduce` too when the pairing is linked to the account.

## Account link

When the host and the phone are signed in to the same account (`@slicerx/store` auth), the pairing is marked as account linked. A new phone of that account can then be approved from any device already trusted:

```ts
// New phone, signed in
const flow = await client.joinAccount()           // "Approve this phone on a device you already use"
showDigits(await flow.sas)

// Trusted phone (or the host itself, with host.watchJoinRequests)
client.watchJoinRequests(accountRelay, (req) => showRequest(req.name, () => req.review()))
```

The join request goes over the relay's account route, and the two devices run the same six-digit handshake as a QR pairing. The relay checks only that both are signed in. Comparing the digits keeps the relay, or anyone who has the account password, from adding a device.

When a trusted phone approves, it signs one grant per host it may introduce to (`src/grant.ts`). The new phone presents the grant on first contact with each host. The host checks that the issuer is a device it paired with, holds the introduce right and belongs to the same account. The new device's rights are capped at the issuer's. Revoked grants are remembered, so a revoked device cannot come back with the same grant.

`host.revokeAccountDevices(deviceIds)` applies revocations from the account's device list. The host honors them without further proof because a revocation can only take access away.

## Transports

The phone tries the host's LAN addresses first, then the relay. Neither transport is trusted. Both carry opaque text frames, and the encryption on top provides the security.

- LAN: plain `ws://` to a private, link-local or `.local` address. `isLocalUrl` is the same rule sx-link applies to printers, so a pairing link cannot point the phone at the internet.
- Relay: a WebSocket that forwards frames between opaque routes. Routes are 32 byte values derived from the offer or the device key; the relay cannot link them to a person or read what they carry.

Each connection starts a new session (`src/session.ts`, session version 2):

1. The device sends `init`: a fresh X25519 key `eD`, a nonce and a MAC under the device key.
2. The host answers `accept` with its own fresh key `eH`, a nonce and a MAC under a key that needs both the device key and `DH(eD, host static key)`. The host static key is the identity's `dhPub`, which the phone pinned at pairing.
3. Both derive the session keys from `DH(eD, eH)`, the device key and `DH(eD, host static key)`, salted with a hash of both frames.

A copied device key alone therefore cannot answer as the host: the accept MAC fails on the phone. The keys differ per direction, and counters rise strictly, so a frame cannot be replayed, reordered or reflected.

Both frames carry `v: 2`. A host answers an older `init` with `refuse {reason: "update"}`, and the phone reports that this app needs an update. A phone that gets an `accept` without `v: 2` stops with an error saying SlicerX on the computer needs an update. Neither side falls back to the version 1 key schedule. The hub (sx-link) needs the identity's static secret to answer phones with the app closed, so the app passes it as `hostDh` in `remote.configure`.

### Relay protocol

One JSON object per WebSocket text frame.

| From | Frame | Meaning |
| --- | --- | --- |
| client | `{"op":"auth","token"}` | Account session (Supabase access token). Needed only for `acct:` routes. |
| client | `{"op":"sub","route"}` / `{"op":"unsub","route"}` | Receive frames sent to a route. |
| client | `{"op":"send","to","body"}` | Forward `body` to every subscriber of `to`, or queue it. |
| relay | `{"op":"msg","route","body"}` | A frame for a route this connection subscribed to. |
| relay | `{"op":"error","code","message"}` | Refused frame (`too_large`, `forbidden`, `rate_limited`). |

Rules the hosted relay must follow (`createMemoryRelay` implements them):

- Opaque routes are exactly 43 base64url characters. Anyone who knows one may use it.
- `acct:<userId>:join`, and the same with one or two 22 character suffixes, are served only to a connection whose verified session belongs to `<userId>`.
- A body is at most 1,500,000 characters.
- A frame for a route with no subscriber waits up to 10 minutes; each route keeps at most 64.
- The relay never logs bodies or routes, and never parses bodies.
- Rate limits per connection are up to the relay (suggested: 256 subscriptions, 50 frames per second, 20 MB per minute).

The hosted relay is `packages/connect/relay` (sx-relay). It adds a `quota` request, an `auth` reply and a `scope` on `rate_limited`, all described in its README. Opaque routes work without an account at lower limits; signing in raises them. `test/hosted-relay.test.ts` checks it against the rules above.

## Host integration

```ts
import { createPairHost, ensureIdentity } from '@slicerx/pair'

const identity = await ensureIdentity(identityStore, defaultEnv, 'Studio Mac', 'desktop')
const host = await createPairHost({
  identity,
  store: pairingStore,                 // PairingStore: holds device keys, so keep it in secure storage
  kind: 'desktop',                     // or 'web', 'link'
  accountId: session?.userId ?? null,
  endpoints: { lan: ['ws://192.168.1.20:47616/pair'], relay: 'wss://relay.slicerx.app/v1' },
  services: {
    printers: hostApi.printers,        // PrinterHost
    approvals: hostApi.approvals,      // ApprovalHost (sx-permit, or the TS broker)
    slicer,                            // PairSlicer: slices a library item or an uploaded model
    cloudSlicer,                       // optional
    library,                           // { list(): LibraryEntry[] }
    approvalFeed,                      // mimir's pending approvals, so phones can decide them
  },
})
host.attachRelay(await connectRelay({ url, socket: (u) => new WebSocket(u) }))
lanListener.onConnection((pipe) => host.handlePipe(pipe))
```

- `approvals.grant` is called only after a person approved, on the host (`host.jobApprovals.decide`) or on an approver phone with a valid signed decision.
- `PairSlicer.slice` gets `req.options` (the phone's material id and Easy settings) and, for uploaded models, `req.blob`. The options are length-checked but loosely typed on the wire, so validate them against the settings schema before use.
- `approvalFeed.decide` must do exactly what a click on the host's own approval card does.
- `host.jobApprovals` lists the approvals phone jobs raise, for the host's approval card.
- `host.audit()` returns every phone decision with its signature.

The host must be running with the app open for phones to reach it. A browser tab cannot listen on the LAN, so the browser build reaches phones on the LAN through sx-link and otherwise through the relay.

### LAN listener

sx-link (and the desktop app's Rust side) accepts phone connections on the LAN and passes frames through unread. The protocol is in `packages/connect/link/README.md`, section "LAN listener for phones": `pair.listen`, `pair.send`, `pair.close` and the `pair` and `pair.closed` events on the paired localhost socket. The listener is off by default. It serves `/pair` only, stops when the app's localhost connection ends, and exposes no printer methods, secrets or pairing code.

`serveLanThroughBridge(host, link.pair, port?)` turns each phone connection into a Pipe for `host.handlePipe` and starts the listener. Pass the returned `urls` (built from the private IPv4 addresses sx-link reports) to `host.setEndpoints({ lan: lan.urls, relay })`, so QR codes and new pairings carry them. Link-local IPv6 is skipped because its zone names the computer's interface, which means nothing on the phone. mDNS is not implemented yet, so phones learn the address from the QR code.

## Phone integration

```ts
const client = createPairClient({
  identity,                           // ensureIdentity(secureStoreIdentityStore, env, deviceName, 'ios')
  store,                              // PairingStore on expo-secure-store or the Keychain
  relays: ['wss://relay.slicerx.app/v1'],
  defaultRelay: 'wss://relay.slicerx.app/v1',
  socket: (url) => new WebSocket(url),
  openRelay: (url) => connectRelay({ url, socket: (u) => new WebSocket(u), token: getAccessToken }),
  accountId: session?.userId ?? null,
  env: { now: Date.now, random: (n) => Crypto.getRandomValues(new Uint8Array(n)) },
})

const conn = await client.connect(pairingId)
const printers = await conn.printers()
const slice = await conn.slice({ source: { kind: 'library', id }, where: 'host' }, onProgress)
const { requestId } = await conn.send({ sliceId: slice.sliceId, target: { fleetId }, start: true })
conn.on('approval.request', (v) => showApprovalCard(v))   // then conn.approve(v) from its button
conn.onJob((u) => showJobState(u))
```

Notes for the Expo app:

- Randomness: Hermes has no `crypto.getRandomValues` by default. Pass `env.random` from `expo-crypto`, or install a polyfill before importing this package.
- Storage: the identity and pairing records hold secret keys. Keep them in `expo-secure-store` (Keychain on iOS, Keystore on Android), never in AsyncStorage.
- Local network: iOS needs `NSLocalNetworkUsageDescription` and `NSBonjourServices` (`_slicerx._tcp`); Android needs cleartext allowed for private addresses in the network security config. The relay path works without either.
- Approvals: call `conn.approve(v)` only from the approval card's button. Consider requiring Face ID or the device passcode first (`expo-local-authentication`), since the phone can start printers.
- Slicing on the phone: Hermes has no WebAssembly, so `@slicerx/core-web` cannot run directly. The options are a native module over the C ABI (`sx-ffi`) or a hidden WebView. Either way, `conn.uploadSlice()` sends the G-code, and the host checks its SHA-256 before it keeps the file.

## Print jobs

`send()` builds one approval request for the whole job: an upload action per printer, plus a start action per printer when `start` is true. Parameter hashes follow `ApprovalAction` in `@slicerx/contracts`, so the printer host verifies the token against exactly the file (by SHA-256), printer and options that were approved. Approver phones and the host's card see the request at once; the first decision wins. A request expires after 5 minutes. A phone signs its decision with its identity key over the request's hash, so a decision cannot be moved to another request, and the host keeps the signature as the audit record.

Phone job requests always ask, whatever the Pilot policy says for queue and start.

`conn.startFile(fileRef)` starts a file an earlier job left on a printer (the `fileRef` comes with the job's `queued` update), and `conn.control(printerId, 'pause' | 'resume' | 'cancel')` controls the current print. Each raises its own approval request with one action.

### PrinterHost on the phone

`createPairedPrinterHost({ connection, local })` gives phone code a plain `PrinterHost` backed by the paired computer, so code written for the demo fleet runs unchanged. Reads go straight through. Side effects keep two gates:

1. The caller passes a token from the phone's own broker (`local`), minted after the person confirmed on the phone.
2. The computer raises its own approval request for the same host calls. The adapter signs it only when every action verifies against the phone's token, and denies it otherwise. The computer's broker then mints the token its printers check.

Without the approve right, the adapter still checks the phone's token, then waits for the computer's own approval card. `upload` puts the file on the printer and returns a `RemoteFile` whose path names the computer's `fileRef`; `start`, `pause`, `resume` and `cancel` follow the contract. `sendSlice` sends a plate the computer sliced. Fleet changes and plugin tools stay on the computer. Approval events for requests the adapter raised should be filtered with `ownsSettled(requestId)`, so the app does not show the same approval twice. On React Native, use `snapshotImage` instead of `snapshot`, since a Blob cannot be built from bytes there.

## Tests

```
pnpm --filter @slicerx/pair test
```

99 tests. The unit tests use no network and no wall clock (randomness and time are injected). They pair over a fake LAN and the in-memory relay, run print jobs against `@slicerx/fleet-sim` with Pilot's approval broker, and check that:

- both screens show the same digits, and a party in the middle of a code pairing never matches them (40 runs);
- a wrong secret, a swapped host key, a second phone on a used offer or an expired link all fail;
- the relay log never contains device names, printer names, file names or identity keys;
- replayed, reordered, altered and reflected frames are dropped, and a wrong device key gets no session;
- a device key without the host's static key cannot answer as the host, and old session versions are refused both ways with an update message;
- no printer changes state before an approval, after a denial, after expiry, or with a decision signed for another request or by another key;
- the phone's PrinterHost signs the computer's request only when the phone's own token covers every action, and a token works once;
- grants with a bad signature, an unknown or unprivileged issuer, another account, another host, an old date or a revoked id are refused.

`test/link.integration.test.ts` runs phone jobs end to end through the real sx-link binary, its sx-permit broker and the Moonraker mock: the job starts only after the phone approves, a denied request gets no token, and a phone pairs and sends over the LAN listener, which never sees a device name, printer name, file name or G-code. It is skipped unless `target/debug/sx-link` is built (`cargo build -p sx-link`).

## Dependencies

- `@noble/curves` 2.4.0, `@noble/hashes` 2.4.0, `@noble/ciphers` 2.4.0 (MIT): X25519, Ed25519, SHA-256, HKDF, HMAC, XChaCha20-Poly1305. Audited, pure JavaScript.
- `zod` 4.6.5: parses every frame and payload.
- `@slicerx/contracts`: printer and approval types, `canonicalJson`, `hashParams`.
- Dev: `vitest`, `@slicerx/fleet-sim`, `@slicerx/pilot` (the approval broker), `@slicerx/link-client` and `@slicerx/mock-printers` (the sx-link test).

## Status

- Done and tested: pairing by QR link, short code and account; LAN and relay transports; sessions; rights; revocation on both sides; introductions; phone uploads; host and cloud slicing hooks; print jobs through approvals, including through sx-link and its broker; phone approvals of Pilot requests.
- Needs other packages: the hosted relay and the account device list (cloud, store), host wiring in the web and desktop apps (studio), and the Expo screens (mobile).
