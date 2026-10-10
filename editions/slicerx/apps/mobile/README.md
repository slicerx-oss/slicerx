# SlicerX for phones

The SlicerX phone app for iOS and Android, built with Expo (React Native) and expo-router. It reuses the TypeScript packages that run in React Native: contracts, the mimir runtime, the store and auth client, settings, the cloud client, pairing and the fleet simulator. Screens are native and are not shared with the desktop app.

Setup of accounts, keys and redirect URLs is in [SETUP.md](SETUP.md).

## Run it

```sh
pnpm --filter @slicerx/mobile typecheck
pnpm --filter @slicerx/mobile test
pnpm --filter @slicerx/mobile config     # the resolved Expo config
```

Native builds and simulators need Xcode or the Android SDK. `scripts/` can run them on a separate build Mac over ssh (see [BUILDING.md](BUILDING.md)):

```sh
npx expo prebuild --clean
npx expo run:ios
```

## Layout

| Path | What |
| --- | --- |
| `app/` | expo-router routes. Thin files that map data hooks onto screen props |
| `src/screens/` | Screens, props-driven, no data access |
| `src/components/` | Theme (Subban from `@slicerx/ui/theme`), icons, primitives, mimir chat parts |
| `src/data/` | Provider, TanStack Query hooks, mimir and send-print hooks |
| `src/state/` | The zustand store (alerts, preferences, policy) and approvals |
| `src/host/` | The phone host: printers, approvals, store and auth, cloud slicer |
| `src/cloud/`, `src/notify/`, `src/pilot/`, `src/config/` | Cloud slicing job, alerts and notifications, offline mimir replies, edition config |
| `src/pair/` | Pairing hooks and the paired computer's printers |
| `ios/`, `android/`, `e2e/`, `scripts/` | Native projects, end-to-end tests, build scripts |

## How it fits together

- `app.config.ts` resolves the edition config, so a fork rebrands the app by editing that config.
- `src/polyfills.ts` loads first. It adds `crypto.subtle` (SHA-256 and HMAC-SHA-256 on expo-crypto), which the approval broker and parameter hashing need on Hermes.
- `src/data/provider.tsx` creates the host once and runs the background work: the printer status stream, alerts and notifications, and sign-in callbacks.
- Printer actions confirm on the screen with one tap in a sheet that states exactly what will happen. The approval token is minted only after that and is bound to the exact host calls it lists.
- mimir answers offline (`src/pilot/demo-client.ts`) until a paired computer or the SlicerX service carries model traffic. The approval gate runs in both modes.
- Slicing goes to the cloud slicer (`@slicerx/cloud`) when `SLICERX_CLOUD_API_URL` is set. Without it, a local stand-in estimates time and filament.

## Paired channel shapes

`@slicerx/pair` carries these; `src/pair/lazy.ts` gives the app one stable camera object and one push registrar per paired computer, resolved from the connection on first use (`host.info.camera` and `host.info.push` say whether the hub offers them). `src/host/switchable.ts` exposes the current source's camera as `printers.camera()`.

Camera (`src/camera/feed.ts`):
- `camera.open {printerId, quality: low|medium|high|auto}` returns `{stream, quality}`. The computer always turns H.264 key frames into JPEG for phones (`jpegOnly`).
- Events: `camera.frame {stream, capturedAt, key, kind: "jpeg", dataB64}` (standard base64, 2, 5 or 10 fps at low, medium, high), `camera.stats {stream, fps, kbps, dropped, quality}`, `camera.ended {stream, reason?: ended|codec|closed}`.
- `camera.quality {stream, quality}`, `camera.close {stream}`, `camera.grab {printerId}` for one still.
- `feedsFor(printers)` opens the paired stream when `printers.camera()` exists and falls back to stills polled from `snapshotUri` (2 s, 1 s, 0.5 s) when the host refuses (`not_supported`), has no camera, or the source is the demo fleet.

Remote video (`src/camera/rtc.ts`, `src/camera/webrtc.ts`): away from home (`conn.via === 'relay'`) `feedsFor` tries `camera.rtc` first. The phone sends one complete WebRTC offer (receive-only video line plus a data channel, all candidates gathered, 4 s limit) and applies the hub's answer. H.264 cameras arrive as a video track drawn by `RTCView`; JPEG cameras arrive as binary messages on the data channel. The hub ends a direct stream after 30 minutes. If the peers do not connect within 10 s, or the hub answers `not_supported`, or the app has no native module, it uses `camera.open` through the relay (sealed JPEG, 1 fps, 640 px wide, 10 minutes), then stills. Feeds report `capMs` and `useFeed` opens the next stream 5 s before the cap. `react-native-webrtc` is a native module (dev build only; Expo Go and web use the JPEG path). It is loaded lazily, and no config plugin is used because the plugin adds microphone permissions a receive-only viewer does not need.

Push (`src/notify/push.ts`):
- `push.register {token, platform, prefs}` and `push.unregister {token}`. Revoking the pairing removes the token on the computer.
- The hub sends fixed text (`PUSH_TEXT`) with data `{kind: print_done|print_failed|attention|approval, printerId?, requestId?}`. Nothing in the text names a file, a model or a printer.

Approval cards for agent requests (`src/data/verified-card.ts`): when mimir on the computer or an MCP client asks, the phone does not show the request's title or lines. It builds the card from the actions the hub verified (action, printer, hash of the exact parameters) and names the printer from the printer list. A phone's own job and a click on the computer keep their text. When the card carries the hub's `work` summary (`print` with file name, size and sha256, `gcode` line, `adjust` change, `resume`, `pause`, `cancel`), `src/data/work-card.ts` words the card from it, after recomputing the hashes of the card's actions from the summary. A mismatch, a printer that differs from the card's, or a kind this phone does not know shows a warning and no Approve (Deny stays).

The hub (sx-link over the relay) sends the summary next to the request, not inside it, so the hash the phone signs covers the request unchanged: `approval.request` and each `approvals.list` entry are `{request, source: "host", work?}` (`WorkSummary` in `@slicerx/pair`). `src/data/computer-approvals.tsx` merges `view.work` into the request it passes to `checkWork`, for display only; `approve` and `deny` still sign `view.request`. Exact shapes, each hashed as the card's actions hash them:
- `{kind: "print", printerId, file: {name, sizeBytes, sha256}, opts}`: `printer.upload` hashes `{printerId, name, sha256}`, `printer.start` hashes `{printerId, name, opts, sha256}` (`opts` is `{}` when the agent gave none). `sizeBytes` is the hub's count of the bytes it holds; the hash binds name and content.
- `{kind: "gcode", printerId, line}` (one line, at most 2000 characters): `printer.gcode` hashes `{printerId, line}`.
- `{kind: "adjust", printerId, change}`: `printer.adjust` hashes `{printerId, change}`.
- `{kind: "resume" | "pause" | "cancel", printerId}`: `printer.<kind>` hashes `{printerId}`.

A card answered somewhere else closes (`src/data/answered.ts`): the computer sends `approval.resolved {requestId, decision: approve|deny|expired, by, via?}`, where sx-link sets `via` to `app`, `phone`, `partner` or `agent` and `by` to a partner app's name (else the `via` word), and the desktop app's own host sends only `by`. The card shows a short note ("Approved in SlicerX.", "LayerMate answered it.", "LayerMate withdrew it.") for 4 s, then closes. This phone's own answer gets no note. While a card is open, `approvals.list` is read every 10 s and a card the computer no longer lists closes too.

The hub enforces the same rule as `relayBlock`: over the relay `approvals.decide` approves only pause and cancel cards and answers `not_supported` for anything else; a `bedClear` sent over the relay is ignored. Deny works for every card.

Also from the hub over the relay: `remote.quota {}` returns the hub's relay quota `{tier, used, cap, resetsAt, connections, maxConnections}` or null, and the `remote.quota` event repeats it on connect and every five minutes. `host.info.stun` is the STUN server (`host:port`) next to the relay; use it for `camera.rtc` instead of a third party's. `client.unpair` returns `{removedOnHost}`: when the computer could not be told, the host stays listed with `pendingRemoval: true` (show "Removal pending"), cannot be connected to, and `client.retryRemovals()` sends the removal later (`hosts()` also retries once a minute). The account relay takes a relay token, not the Supabase session: use `relayTokenSource({backend: {url, anonKey}, session})` from `@slicerx/pair` as the `token` of `connectRelay`.

Over the relay (`conn.via === 'relay'`) the card offers Approve only for pause and stop (`relayBlock` in `src/data/verified-card.ts`); everything else says "Approve this at home or in SlicerX". The bed question therefore never goes over the relay. The printer page now passes the bed answer through to the decision (it was dropped there before). Starting a print still asks the bed question as a real switch.

mimir chat renders the tool display kind `image` (`ChatImage` in `src/components/pilot/blocks.tsx`): raster `data:` URLs only, shown in the transcript without opening the tool row.
