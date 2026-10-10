# sx-link

Localhost bridge for the browser build. It serves connectors and approvals over one WebSocket, through the same code the desktop app links directly.

```
sx-link [--port 47615] [--allow-origin https://staging.example] [--no-mdns] [--loopback]
```

## Security

- Binds `127.0.0.1` only.
- The upgrade is refused unless the `Host` header names the listener (DNS rebinding) and any `Origin` is `https://slicerx.app`, a `localhost` or `127.0.0.1` dev origin, the Tauri webview, or one passed with `--allow-origin`.
- A client first sends `hello` with a random nonce; the hub answers with its key, its own nonce and a signature over both nonces and its port, and the client checks the key against the one it pinned. Then the client proves the code printed at start through a code exchange: CPace (draft-irtf-cfrg-cpace, ristretto255 with SHA-512, crate `sx-cpace`), bound to the hub key, the port and both nonces. The code never crosses the socket, and what crosses it cannot be checked against guesses offline: a program posing as the hub, on a first pairing with nothing pinned, gets one guess per attempt. The hub also proves it holds the code, so a client pins a hub key only after the exchange confirms it.
- The exchange takes two `pair` calls. The first carries `pake` (the client's message `Ya`); the hub answers `{pake: {app, agent, watch}}`, one message per code it holds. The second carries `confirm`, an HMAC tag for each of those, and the hub pairs with the role whose tag verifies and returns its own tag as `confirm`. A `pair` with `code` in clear or with a version 1 `proof` is refused without being compared, with a message to update. A remembered client sends `clientKey` instead. Five wrong confirms close the socket. Ten across all connections lock pairing for 60 seconds, and while locked even the first step is refused.
- The hub key has a fingerprint for people to compare: the first 80 bits of SHA-256 over the key in Crockford base32, four groups of four. `sx-link` prints it at start and `sx-link code` prints it on stderr. After a hub mismatch the app shows the fingerprint of the program that answered and asks the person to compare it with `sx-link code` before it trusts that key; it then pins that exact key rather than trusting whatever answers next.
- Printers and service URLs must be on the local network: private and loopback addresses, link-local, `*.local`, `*.lan`, `*.home.arpa` or single label names.
- Secrets are write only: `secrets.set`, `secrets.has`, `secrets.delete`. Values go to the OS keychain and are never returned.
- Upload data must match its declared SHA-256 before it reaches a printer.
- Side effects need an `ApprovalToken` minted by the bridge's `sx-permit` broker. `BrokerGate` checks each call's action, printer and parameter hash against it; each action verifies once and a token lives five minutes. `sx_link::serve` takes any `ApprovalGate`, and `serve_with_approvals` also exposes the broker to paired clients. Paired clients are trusted to call `approvals.grant` only from the approval card.

## Protocol

Text frames of JSON. Request `{"id", "method", "params"}`, reply `{"id", "result"}` or `{"id", "error":{"code","message"}}`. Error codes are the `PrinterErrorCode` values plus `bad_request`, `unauthorized` and `locked`. Events arrive as `{"event":"printer","subscription","printerId","data":PrinterEvent}`.

| Method | Params | Result |
| --- | --- | --- |
| `hello` | `nonce` | `{hubKey, hubNonce, sig, port}` |
| `pair` | `pake` (after `hello`) | `{pake: {app, agent, watch}}` |
| `pair` | `confirm` (after `pake`) or `clientKey`; `role?`, `remember?`, `name?` | `{paired, role, confirm?}`, plus `{clientKey, clientId}` when remembered |
| `plugins` | | `PluginManifest[]` |
| `printers.add` | `config: PrinterConfig`, `info?` | `PrinterInfo` |
| `printers.remove` | `printerId` | |
| `printers.authorize` | `printerId`, `timeoutSeconds?` | `{authorized, stored}`. Pairs with printers that need a tap on their own screen (Snapmaker 2.0) and stores the token under the printer's `credentialRef`. The reply never carries the token. Blocks this connection until the tap or the timeout (default 60 s, at most 120). |
| `discover` | `timeoutMs?` | `{printers: DiscoveredPrinter[]}`. Scans the local network: every connector's own discovery (Bambu Lab announcements, Elegoo's broadcast) plus an mDNS query for Moonraker, OctoPrint, PrusaLink and Duet. `timeoutMs` is 300 to 10000 (default 3000). Addresses off the local network are dropped and duplicates merged. See `docs/finding-printers.md`. |
| `printers.test` | `config: PrinterConfig` | `{ok, state?, cause?, message?, steps}`. Reach, sign in, read state, read temperatures, without registering the printer or changing anything on it. `steps` are `reach`, `sign_in`, `read_state`, `read_temperatures`, each `ok: true`, `false`, or `null` when an earlier step failed. `cause` is `unreachable`, `auth`, `timeout` (15 s), `protocol`, `not_supported` or `bad_request` (not a local address). It cannot tell LAN mode being off, a wrong port or a certificate problem from `unreachable`. The credential must already be in the keychain under `credentialRef`. |
| `camera.open`, `camera.quality`, `camera.close`, `camera.probe` | see `docs/camera.md` | Live camera video as binary frames, with stats events. |
| `camera.grab` | `printerId` | `{contentType, dataBase64, capturedAt, source}` or null without a camera. One still: the printer's snapshot, else the first JPEG frame of the live video (`source` `snapshot` or `stream`). A camera that sends only H.264 and has no snapshot gives `not_supported`. |
| `push.register` | `token` (Expo push token), `platform` (`ios`, `android`), `prefs {printDone, printFailed, attention, approvals}`, `tag?` | `{registered}`. The hub keeps up to 32 phones in `hub.json`. |
| `push.unregister` | `token` or `tag` | `{unregistered}` (count). The app passes the pairing id as `tag`, so revoking a pairing removes its phone. |
| `push.list` | | `[{tokenEnd, platform, prefs, tag, createdAt}]`. Tokens are never returned, only their last six characters. |
| `list` | | `PrinterInfo[]`, every printer whether or not it is in a fleet |
| `fleets.list` | | `Fleet[]` |
| `fleets.create` | `name`, `color?`, `icon?`, `printerIds?` | `Fleet` |
| `fleets.rename`, `fleets.update`, `fleets.delete` | `fleetId`, `name` or `{color?, icon?}` (null clears) | `Fleet`, or `{deleted}` |
| `fleets.add`, `fleets.remove` | `fleetId`, `printerId` | `Fleet` |
| `status` | `printerId` | `PrinterStatus` (an unreachable printer reads as offline) |
| `subscribe` / `unsubscribe` | `printerId` / `subscription` | `{subscription}` |
| `upload` | `printerId`, `file:{name,kind,sha256,dataBase64}`, `token` | `RemoteFile` |
| `start` | `file: RemoteFile`, `opts?`, `token` | |
| `pause`, `resume`, `cancel` | `printerId`, `token` | |
| `gcode` | `printerId`, `line`, `token` | |
| `approvals.register` | `request: ApprovalRequest` | `{registered}` |
| `approvals.grant` | `requestId` | `ApprovalToken` |
| `approvals.deny` | `requestId` | `{denied}` |
| `snapshot` | `printerId` | `{contentType,dataBase64}` or null |
| `services.configure` | `pluginId`, `baseUrl`, `secretRef?` | |
| `services.list` | | `{pluginId, baseUrl, hasSecret}[]` |
| `services.remove` | `pluginId` | `{removed}` |
| `callTool` | `pluginId`, `tool`, `input`, `token?` | tool result |
| `secrets.set/has/delete` | `name`, `value?` | |

`llm.*` answers `not_supported` until `sx-llm` is wired in.

### Filament slot maps

`opts.slotMap` on `start`, `print.local`, `files.start`, queue items and agent work maps a filament to a printer slot. Keys are 0 based filament indexes: `"0"` is the first filament (the G-code's `T0`, which people see as filament 1). Values are slot ids as the printer reports them, such as `"A3"`, or `"1"` for the external spool. Clients that number filaments from 1 convert once, when they build the start options; nothing in the hub or the drivers converts.

Only a printer that will follow the map accepts one. Today that is a Bambu Lab printer starting a `.gcode.3mf` (`project_file` with `ams_mapping`, as Bambu Studio sends it). A Bambu `.gcode` start, and every other driver, answers `not_supported` for a start with a non-empty map before the token is used, because the printer would feed filament as its G-code says and the card would have shown slots it does not use. A start without a map goes through as before.

Fleets are optional user groups: a printer can be in any number of them, names are unique ignoring case, and deleting a fleet never removes printers (removing a printer takes it out of its fleets). Printer registrations, fleets and service settings are saved in `hub.json` and come back after a restart.

## LAN listener for phones (opt-in)

A paired client can turn on a second listener so a phone on the same network can reach the app: `pair.listen {enabled: true, port?}` (default 47616, 0 picks a free port) binds `0.0.0.0` and accepts WebSocket upgrades on `/pair` only. It is off by default and turns itself off when the client that enabled it disconnects, so a closed app never leaves the port open.

The listener is a byte pipe. The bridge does not read, log or interpret what a phone sends; all pairing cryptography stays in the app. It serves nothing else: no printer methods, no secrets, no pairing code. A frame that looks like a printer request is forwarded as opaque text and never answered.

- Phone to app: an event `{"event":"pair","conn":"c1","frame":"..."}` on the paired localhost socket, and `{"event":"pair.closed","conn":"c1"}` when the phone leaves or is closed.
- App to phone: `pair.send {conn, frame}` and `pair.close {conn}` (both `not_found` for an unknown `conn`).
- Limits: text frames only, at most 1.5 MB in either direction (a binary or oversize frame ends that connection); 64 connections at once and 30 new connections per address per minute (`PairLimits`); a handshake must finish in 10 seconds. Connections that carry an `Origin` header outside the allow-list are refused, so a web page in a browser on the network cannot reach the port; phones send no `Origin`.
- While the listener is on, it is announced as `_slicerx._tcp` over mDNS (see below), so a phone can find it without the QR code's addresses.

| Method | Params | Result |
| --- | --- | --- |
| `pair.listen` | `enabled`, `port?` | `{listening, port?, addresses?, advertised?}`; `advertised` says whether the mDNS announcement is running; `addresses` lists this machine's private IPv4 addresses and link-local IPv6 addresses (`fe80::1%en0`) for the phone's QR code, with loopback and tunnel interfaces left out |
| `pair.send` | `conn`, `frame` | `{sent}` |
| `pair.close` | `conn` | `{closed}` |

### mDNS advertising

With the listener on, the bridge announces `SlicerX-xxxx._slicerx._tcp.local` on UDP 5353 with the listener's port, this machine's private IPv4 addresses and the text record `v=1`. The instance name and the `sx-xxxxxxxx.local` host name are random per start, so the announcement says nothing about the user or the computer, and it never contains a pairing code or key. It is a hint about where to connect; a phone still has to complete the pairing handshake. It sends two announcements at start (one second apart), answers queries for `_slicerx._tcp` and for the instance and host names (at most 20 replies a second), and sends a goodbye when the listener stops or its owner leaves. The socket shares port 5353 with the system's own responder (`SO_REUSEPORT`), joins the multicast group on each private interface address, and needs no elevated rights.

`sx-link --no-mdns` turns off advertising and the mDNS part of `discover`. Advertising is best effort: with no private IPv4 address, or a system that refuses the group, `pair.listen` still succeeds with `advertised: false`.

### Test runs on loopback

`sx-link --loopback` keeps every socket on `127.0.0.1`: the phone listener, printer discovery and probing, and direct video, with mDNS off (`LinkConfig::loopback()` in Rust). Nothing listens on the network, so a fresh test build never makes the OS firewall ask, and `discover` finds only printers on this machine, such as the mock printers. The tests that start sx-link (`SX_LINK_BIN`) pass it, and the Rust tests build their hubs on `LinkConfig::loopback()`. To run those Node tests against the real network on purpose, for example to see `discover` find the printers on your LAN, set `SX_TEST_LAN=1`: sx-link then starts without `--loopback`, and the firewall may ask once for that binary.

## Remote access (opt-in)

With remote access on, the hub answers paired phones and remote agents through the hosted relay (`packages/connect/relay`), with the app closed. It speaks the pairing session protocol of `packages/pair` itself (`src/pair_session.rs`: X25519, HKDF-SHA256, XChaCha20-Poly1305, Ed25519; pinned to the TypeScript side by `packages/pair/test/vectors.json`). The relay sees routes and sealed frames only. App role only:

| Method | Params | Result |
| --- | --- | --- |
| `remote.configure` | `enabled`, `relay?` (a `wss://` URL; `ws://` only to this machine), `host?` (the app's pair `PublicIdentity`, which phones pinned), `hostDh?` (that identity's static X25519 secret, base64url; session keys mix it in, and turning remote access on needs one that matches `host.dhPub`) | the status below |
| `remote.status` | none | `{enabled, relay, connected, sessions, pairings, lastError, quota}`; `quota` is the relay's last `quota` answer |
| `remote.token` | `token` (the signed-in account's access token) or `null` | the status, with `signedIn`. The hub keeps the token in the secret store, signs in to the relay with it so the account's limits and monthly cap apply, and never returns or logs it. The app sends each refreshed token; `null` reconnects on the anonymous tier. A token the relay refuses leaves the hub on the anonymous tier. |
| `remote.quota` | none | asks the relay for a fresh quota; the status as it stands |
| `remote.pairings.put` | `pairingId`, `deviceKey`, `kind` (`phone` or `agent`), `peer` (`PublicIdentity`), `rights?` `{request, approve}` | `{saved}`. The device key goes to the secret store (the keychain on macOS), the rest to `remote.json`. Agents never get `approve`. |
| `remote.pairings.remove` | `pairingId` | `{removed}`; open sessions of that pairing end |
| `remote.pairings.list` | none | the records, without keys |

Over a session the hub serves the pair protocol's methods (`packages/pair/src/rpc.ts`) that make sense with the app closed: `host.info`, `printers.list`, `fleets.list`, `printers.status`, `printers.watch` and `printers.unwatch` (`printer` events), `printers.snapshot`, `camera.grab`, `approvals.list` and `approvals.decide` (phones with the approve right, decisions signed with the phone's identity key and checked against the card's hash), `jobs.control` for pause and cancel (a card a person answers; the hub runs it and sends `job` updates) and `pairing.revoke`. Everything else, including `print.local`, `bed.confirmClear`, resume, uploads, starts, secrets, printer setup, clients and settings, answers `not_supported`. Phones see only cards whose work the hub runs itself (remote pause and cancel, agent work) and queued or scheduled plates; cards whose token goes back to the app are answered in the app.

Live camera over remote access, phones only (agents get stills): `camera.rtc {printerId, sdp}` answers a complete WebRTC offer (no trickle) and sends the camera peer to peer, H.264 as RTP without transcoding and JPEG cameras over the data channel, for up to 30 minutes; four such streams at once per hub. When no direct path works, `camera.open` sends sealed JPEG `camera.frame` events through the relay instead: one a second, at most 640 pixels wide, ten minutes a stream. One live stream per session; `camera.close` ends either. `remote.configure {stun: "host:port"}` lets the hub learn its public address for direct video; `LinkConfig::rtc_bind` picks the address it binds (default: the default route's).

The relay's quota reaches the app in `remote.status` (`quota`) and as `remote.quota` events: on connect, every five minutes and after `remote.quota`.

`clients.create {name, role: "agent", remote: true}` also makes a remote pairing for that agent and returns `remote: {pairingId, deviceKey, relay, host, hubKey}` once. Revoking the client ends the pairing.

The hub subscribes each pairing's host route, accepts at most two sessions per pairing and 64 in all, and reconnects to the relay with backoff up to a minute. With remote access on, the app's own pair host should not also answer the same routes on the relay.

## Phone alerts

When the watcher sees a print finish (`print_done`), fail or get canceled (`print_failed`), pause or report an error (`attention`), or the hub raises a card (`approval`), it posts one message per registered phone that wants that kind to Expo's push service (`LinkConfig.push_url`, default `https://exp.host/--/api/v2/push/send`; empty turns sending off). The title and body are fixed text that names no file, model or printer, since the push passes through Expo and Apple or Google. `data` is `{kind, printerId?, requestId?}` so a tap opens the right screen; the phone loads everything else over the paired channel. A phone Expo reports as `DeviceNotRegistered` is dropped. If the Expo project turns on push security, store its access token with `secrets.set` under `sx-link-expo-access-token`.

## Cloud inbox (optional)

`sx-link --inbox-url https://cloud.example` lets a cloud service deliver sliced G-code to a printer. Off unless the flag is given. The bridge only makes outbound HTTPS requests (plain http is accepted for loopback, for tests) and opens no inbound port for it. The bearer token (`sxk_...`, scope `cloud_slice`) is read from the keychain entry `sx-link-inbox-token`, set through `secrets.set`; it is never a command line argument and never leaves the bridge.

The bridge registers itself (`POST /v1/devices`, id kept in the keychain), keeps the cloud's copy of its printers current (`PUT /v1/devices/{id}/printers`, `localId` is the bridge's printer id) and long polls `GET /v1/devices/{id}/deliveries?wait=25`. For each offered delivery it checks every field before it trusts any of it:

- file name: at most 100 characters of `A-Z a-z 0-9 . _ -`, no leading dot, ending in `.gcode`, `.gcode.3mf` or `.bgcode`. Other names are refused, not rewritten, because the name is part of what the user approves.
- `sha256` is 64 hex characters, `bytes` is between 1 and 256 MB, `printerLocalId` is a printer registered on this bridge, and `gcodePath` is exactly `/v1/devices/{bridge device id}/deliveries/{delivery id}/gcode`.
- the download uses the same token, stops at the announced size, and its SHA-256 must match.

A failed check is reported to the cloud as `failed` with a short message. A good delivery is held in memory (dropped after 30 minutes unapproved), reported as `downloaded` and `awaiting_approval`, and announced to paired clients as an `inbox` event:

```json
{ "event": "inbox", "data": { "deliveryId": "...", "jobId": "...", "printerId": "bay-4", "fileName": "lantern.gcode", "sha256": "...", "bytes": 3000, "stats": { "timeS": 5400, "filamentG": 21.5 }, "state": "awaiting_approval" } }
```

The bridge cannot approve anything. The app shows the delivery, raises the normal approval (`printer.upload` with `{printerId, name, sha256}` and `printer.start` with `{printerId, name, opts}`), and then calls `upload` with `deliveryId` in place of `file`, and `start` with the returned file. A refused token leaves the delivery waiting. After a good upload the cloud sees `approved` and `uploaded`, and after a good start `printing`. `inbox.decline` reports `declined`. The cloud never sees or supplies a token and cannot start a print.

| Method | Params | Result |
| --- | --- | --- |
| `inbox.list` | | pending deliveries (same shape as the event data) |
| `inbox.decline` | `deliveryId` | `{declined}` |
| `upload` | `printerId`, `deliveryId`, `token` | `RemoteFile` |

## Status

Working and tested (`tests/link.rs`, and the TS client suite in `../link-client`).
