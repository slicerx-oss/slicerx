# Partner route

A partner route is a sealed byte stream between your desktop app and your own app on the user's phone, carried by SlicerX's hosted relay. Your desktop app opens it through SlicerX's printer bridge (`sx-link`) with its [partner app key](partner-app-key.md), and your phone app reaches it through its pairing with the bridge, from anywhere. Use it for your own protocol, such as sending a photo from the phone for your desktop app to work on.

The route carries bytes only. Nothing sent on it reaches a bridge method, a printer or an approval card, and neither the bridge nor the relay reads what you send. For printers, keep using the methods your partner key already has.

## What you need

- A partner app key, made by the user in SlicerX (see [partner-app-key.md](partner-app-key.md)).
- Your phone app paired with the user's bridge as a partner phone, under the same app name as your key.
- Remote access turned on in SlicerX, with the user signed in to their SlicerX account. Partner routes belong to an account, so a bridge that is not signed in can't open one.

## Desktop side

Your desktop app calls these on the bridge's control socket, after pairing with its partner key:

| Method | Params | Answer |
| --- | --- | --- |
| `relay.partnerRoute.open` | `app` (your key's name), `pairingId` (only when more than one of your phones is paired) | `{ routeId, app, pairingId, state: "open" }`, once the relay has accepted the route |
| `relay.partnerRoute.send` | `routeId`, `data` (standard base64, at most 262,144 bytes before encoding) | `{ sent }`, the byte count |
| `relay.partnerRoute.close` | `routeId` | `{ closed }` |
| `relay.partnerRoute.list` | none | `{ routes, caps }`, your own routes only |

Events on the same connection:

- `partnerRoute.data` `{ routeId, data }`: bytes from the phone, in standard base64.
- `partnerRoute.closed` `{ routeId, reason }`: the route is gone. Open a new one if you still need it.

Only the connection that opened a route sends on it and hears its bytes. When that connection closes, the route closes too. `app` must be your key's own name; any other is refused with `forbidden`. `send` answers `not_connected` while your phone has no session with the bridge, and `busy` while the route is still opening.

With `@slicerx/link-client` the same calls are `host.partnerRoutes.open(app)`, `send(routeId, bytes)`, `close(routeId)`, `list()`, `onData(cb)` and `onClosed(cb)`.

## Phone side

Your phone app keeps its pair session with the bridge open, as it does for printers. Over that session:

1. It hears the event `partnerRoute.opened` `{ routeId, app, up, down }` when your desktop opens a route. `up` and `down` are relay routes (`pr:` and 43 base64url characters). Treat them as secrets: anyone who knows one can send to it while it is open.
2. It subscribes to `down` on its relay connection (`{"op":"sub","route":<down>}`).
3. It sends bytes on `up` and reads the bridge's bytes on `down`, each sealed in the route's byte channel (below).
4. It hears `partnerRoute.closed` `{ routeId, reason }` when the route ends. The relay also sends `{"op":"partner.closed","route":<down>,"reason"}` on `down`.

`partnerRoute.list` (no params) over the session returns the open routes for your app with their `up` and `down`, for a phone that reconnects. After the bridge's own relay connection comes back, it sends `partnerRoute.opened` again, and your phone subscribes to `down` again.

### The byte channel

Each route has its own keys inside the pair session, so its frames never open as session messages, and the session's never open on the route:

- For each of the session's two keys (to the bridge, to the phone), the route key is HKDF-SHA256 with the session key as input, the route id's 16 bytes (`routeId` is base64url without padding) as salt, info `sx-pair/v1 partner route`, and 32 bytes of output.
- Frames are the session's data frames, `{ "k": "data", "s": <session id>, "c": <counter>, "x": <ciphertext> }`, sealed exactly as session messages are (XChaCha20-Poly1305, the same nonce layout and associated data), with the route key and the route's own counter, which starts at 0 in each direction. The plaintext is your bytes as they are, not JSON.
- A frame is accepted only with a counter higher than the last one, as in the session.

The test vector, pinned on the bridge side: session key 32 bytes of `0x07`, route id 16 bytes of `0x09`, route key `dedc1af3d85a59eba92c9a693f45a1cdf0236601f4a1aca1ca6993662bacdcd2`.

The bridge opens each frame to hand it to your desktop app, and it never parses, keeps or logs what is inside. If your bytes must stay unreadable to the bridge too, encrypt them between your desktop and your phone before you send them.

## Limits

The relay caps partner routes for each SlicerX account. The defaults are strict, since a route is a general tunnel:

| Cap | Default | When it is reached |
| --- | --- | --- |
| Routes open at once per account | 4 | `open` is refused with `rate_limited` |
| Bytes per route per UTC day, both directions | 50 MB | the route closes with `route_cap` |
| Bytes per account per UTC day, all its routes | 200 MB | every route of the account closes with `account_cap`, and none opens until the next UTC day |
| Idle time | 5 minutes | a route that carries nothing that long closes with `idle` |

The bridge also keeps at most 4 routes open in all, and a chunk is at most 256 KB. When the relay refuses a frame for a cap, the route closes and the frame is not retried. Close a route you no longer use, since an idle one counts against the routes open until it times out. `relay.partnerRoute.list` returns the caps in force as `caps`, with this account's routes and bytes today in `caps.relay` once the bridge has heard the relay's quota.

`partnerRoute.closed` reasons: `closed` (your app closed it), `closed_by_owner` (the user closed it in SlicerX), `desktop_gone`, `unpaired`, `remote_off`, `idle`, `route_cap`, `account_cap`, `signed_out`, `relay_closed`, `relay_refused` and `relay_timeout`.

## What the user sees

The user sees every open route in SlicerX, Settings, Printer bridge, Devices: your app's name, the phone, how long it has been open and the bytes in and out, with End route, which closes it at once. Removing your phone's pairing or your key ends its routes too. The bridge and the relay keep sizes and times only, never your bytes. AI agents connected to the bridge can read the same list (`slicerx_partner_routes`), and none of them can open or close a route.
