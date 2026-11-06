# Partner phone app

Your phone app can pair with a person's SlicerX the way the SlicerX phone app does. It then reads their printers, opens the live camera, asks to pause or stop a print and, if the person allows it, approves cards the way the SlicerX phone app does, except ones a partner app asked for. It works on the same Wi-Fi and away from home, through the SlicerX relay, with SlicerX itself closed. Every message is end-to-end encrypted between your phone and the person's computer. The relay only ever sees sealed frames.

You build this with the [`@slicerx/pair`](../../packages/pair/README.md) package. If your app also runs on the person's computer, the [partner app key](partner-app-key.md) covers that side.

## What a partner phone can do

By default a partner phone sees and asks, nothing more:

- It reads printers, fleets, status, printer events and camera stills, and opens the live camera.
- It can ask to pause or cancel a print. That raises a card in SlicerX and on the person's other phones.
- It registers its own push token for alerts (see Alerts below).

The person can allow two more things for that one phone, while pairing or later in Devices. Both start off:

- Approve: it approves or denies cards the way the SlicerX phone app does: pausing, stopping, skipping one object and, on a printer with remote start on, a start after a fresh plate check (`host.info` says `remoteStart` while your phone may approve). It also answers the questions mimir asks in the app. Each decision is signed with the phone's own key. It never approves a card that any partner app asked for, yours or another's: one from a partner app key, under any name, or from a partner phone, a pause or a stop included. SlicerX goes by who raised the card, never by the name an app gives. On the same Wi-Fi it also never approves a card that names no action. Those answer `forbidden`. It may deny any card it sees.
- Send prints and see the library: on the same Wi-Fi it uploads and slices files, sends prints (each one waits for the person's approval on the computer) and resumes a paused print. Away from home no phone sends prints.

It can't send G-code, change a running print, or touch the person's settings, keys, printers or other devices. Without the approve right, `mimir.questions`, `mimir.answer` and `approvals.decide` answer `forbidden`; without the send right, `library.list`, `upload.*`, `slice.start`, `jobs.send`, `jobs.start` and a resume answer `forbidden`. `conn.info.rights` says which the person allowed (`approve`, and `send` for a partner phone).

## The name is a label

Your app's name labels the pairing so the person can tell phones apart. It is not proof of who you are: any app can pair under any name the person types, and SlicerX cannot check it. The person decides what to trust, by what they allow the phone to do. Nothing in SlicerX trusts a partner phone more because of its name. In particular, a partner app key on the computer reaches a partner phone only when the person links the two in Devices (by key, never by matching names), for [partner routes](partner-route.md).

## Pairing

The person starts it in SlicerX:

1. Open Settings, Phone access and turn on Phone access on this network.
2. Open Settings, Printer bridge, Devices and press Pair a partner phone.
3. Type your app's name as your app shows it, and press Make a code.
4. In your app, scan the QR code or type the short code.
5. Both screens show six digits. The person checks they match, decides whether your app may approve cards and whether it may send prints, and confirms on both.

Your app pairs under its name. Give `createPairClient` the same name:

```ts
import { createPairClient } from '@slicerx/pair/client'

const client = createPairClient({
  identity,                 // ensureIdentity(store, env, 'Pixel 8', 'android')
  store,                    // your PairingStore, in the phone's secure storage
  relays: ['wss://relay.slicerx.app/v1'],
  defaultRelay: 'wss://relay.slicerx.app/v1',
  socket: (url) => new WebSocket(url),
  openRelay: (url) => connectRelay({ url, socket: (u) => new WebSocket(u) }),
  partner: 'Example Phone',     // your app's name, 1 to 64 characters, compared after NFKC, lower case and collapsed spaces
})

const flow = await client.pair(scannedOrTyped)
showDigits(await flow.sas)
flow.confirm()              // after the person says both screens match
const r = await flow.result // { ok: true, hosts: [{ partner: 'Example Phone', ... }] }
```

The name is bound into the pairing. Your hello proves you know it, and it goes into the transcript the six digits come from. A code made for one partner name doesn't pair an app under another name (letter case aside), a plain phone, or a partner app on a plain "Pair a phone" code. The relay never sees the name in clear, only that the hello comes from a partner app. A partner client pairs only by QR code or short code, never by account approval.

Use the relay and STUN addresses SlicerX gives you in the pairing. Don't swap in your own.

## Connecting

```ts
const conn = await client.connect(pairingId)   // the LAN first, then the relay
conn.info.partner        // 'Example Phone': the name SlicerX shows for you
conn.info.rights.approve // false until the person allows it
conn.info.rights.send    // false until the person allows it
await conn.printers()
const still = await conn.grab('bay-4')
const off = await conn.watch('bay-4', (e) => update(e))
await conn.control('bay-4', 'pause')           // a card the person answers
```

When the person turns the approve right on or off, the next `host.info` (every `connect`) shows it. Re-read it when you reconnect.

### Limits

Partner phones share the person's relay allowance with their own phones, so each partner app gets a daily cap: 256 MB per UTC day, shared by all its phones on that computer (not per phone) (counted by app name, so a new pairing does not start again, and the count survives a restart). It counts everything your phone sends and receives away from home: requests and replies, events, the camera, partner route bytes and direct video. Past it, a request answers `quota`, open streams stop, and new relay sessions are refused until the day turns. On the same Wi-Fi nothing counts. `PairError` code `quota` tells you which case you hit. Show the person a short note and keep working over the LAN. A person's SlicerX keeps at most 8 partner phones. Keep the camera to stills or the one-frame-a-second view unless the person is looking at it.

## Alerts

Your app gets pushes through your own push project. SlicerX never holds your APNs key, your FCM key or your Expo access token. Register through the pairing:

```ts
await conn.push.registerPartner({
  provider: 'expo',                          // or 'apns' / 'fcm' with gateway
  token: 'ExponentPushToken[...]',
  platform: 'android',
  prefs: { printDone: true, printFailed: true, attention: true, approvals: true },
})
```

- `expo`: the computer posts each alert to Expo's push service with your Expo token, on its own and with no access token. Expo delivers it through your Expo project with the credentials you gave Expo. Turning on Expo's enhanced push security would make these posts fail, because SlicerX never holds your access token. Use a gateway if you need that.
- `apns` or `fcm`: pass `gateway`, an `https://` address on a public host name that you run. The computer posts the alert there as JSON, `{ provider, platform, token, title, body, data }`, and your gateway sends it with your own key. The address must resolve to public addresses only. Redirects are not followed. Answer HTTP 410 for a token that is gone and SlicerX drops it. Accept only tokens your own app registered, and rate-limit what you deliver.

Every alert has fixed text that names no file, model or printer, for example "Print finished" and "A printer is done. Open SlicerX to see which." `data` carries only `kind` (`print_done`, `print_failed`, `attention` or `approval`): no printer id and no card id, since your push servers read it. Open your app, connect, and read the details over the sealed connection (`conn.approvals()` for cards). A phone without the approve right gets no approval alerts, and turning the right off in Devices stops them at once. Each partner phone gets at most 30 alerts in any hour. One registration per phone: registering again replaces the old token. A token another phone already registered is refused (`conflict`), never taken over, and the SlicerX phone app's own registration of a token replaces a partner's, so register only your own app's token. Register again on every connect, since tokens change. `conn.push.unregisterPartner()` stops alerts, and revoking the pairing removes the registration as well.

## Revoking

The person sees your app under Settings, Printer bridge, Devices, Partner phones, with the phone's name, whether it is connected, the approve and send switches, and which partner app key on the computer it is linked to. Revoke ends it at once. The computer stops answering your pairing, closes its sessions and drops your push registration. Your next `connect` fails. Call `client.unpair(pairingId)` to drop it on your side too.

## Checking it from a client

Clients read the same state back through the MCP server: `slicerx_partner_devices` lists partner phones (name, rights, connected, the linked key, relay bytes today, push provider), and `slicerx_push_status` lists push registrations without their tokens. On the hub, these are `partners.devices` and `push.status`.
