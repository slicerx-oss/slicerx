# Prepare in the viewport, slice with sx

This is Path B with the engine itself in place of the MCP server for slicing. Your app shows the plate in the SlicerX viewport, where people place parts with the Prepare tools. Its main process then turns the plate into a slice request and runs the `sx` engine on it. The preview goes back into the viewport.

Use it when your app already has its own window, its own models and its own idea of a job, and you want the slice itself under your control: one process call, one JSON request, one JSON result. Use the MCP server ([AGENTS.md](AGENTS.md), Recipe B) when you would rather SlicerX layer the settings, review a project's G-code and write `.gcode.3mf` files for you.

What you take on with `sx` directly:

- Settings. `sx` takes one flat config of OrcaSlicer keys. You layer the printer, process and filament settings yourself (step 3).
- Custom G-code. `sx` trusts the stock text of the printer the config names; anything else blocks the slice until a person approves it (step 4).
- File formats. `sx` writes G-code (`.gcode`, or `.bgcode` when the config asks for it) and the SXPV preview. It does not write `.gcode.3mf`. A Bambu Lab printer with an AMS needs the `.gcode.3mf` and its slot map, which the MCP server builds.
- Printers. You send the file yourself, or through SlicerX's printer bridge with a partner app key (step 6).

## What you need

- `sx` from an [engine release](https://github.com/slicerx-oss/slicerx/releases): the archive for your platform has `sx`, `sx-geom` and `sx-link` in `bin/`. Ship `sx` with your app and run it from your main process.
- `@slicerx/embed` from the kit, for the viewport and the theme ([AGENTS.md](AGENTS.md), Step 1).
- The pre-alpha agreement before the pieces are first used ([AGENTS.md](AGENTS.md), Step 5).

## 1. Show the plate and let people place parts

Decode each model with `decodeStl` and keep its `offset`: the decoder centers an STL in X and Y and sets it down on Z 0, and the offset is what it took off. Build the plate from the decoded parts, and turn on the Prepare tools:

```tsx
import { EmbedTheme, Viewport, decodeStl, type DecodedModel } from '@slicerx/embed'
import type { ViewportPlate } from '@slicerx/viewport'

const bed = { widthMm: 256, depthMm: 256, heightMm: 256 }
const center = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, bed.widthMm / 2, bed.depthMm / 2, 0, 1]

function toPlate(models: { id: string; file: string; model: DecodedModel; transform?: number[] }[]): ViewportPlate {
  return {
    bed,
    objects: models.map(({ id, model, transform }) => ({
      id,
      name: model.name,
      transform: transform ?? center,
      parts: model.parts.map((p, i) => ({ name: p.name, positions: p.positions, indices: p.indices, color: model.colors[i] ?? '#ebebe6' })),
    })),
  }
}

<EmbedTheme theme={brand}>
  <Viewport
    plate={plate}
    tools
    onTransform={({ id, transform, final }) => final && setTransform(id, transform)}
    preview={sxpv}
  />
</EmbedTheme>
```

`tools` puts select, move (with X, Y and Z arrows), rotate, scale, arrange and drop to bed over the view, with the keys M, R, S and A. Store each transform when `final` is true and pass the plate back with it, so the next render keeps where the person put things. Without React, `<sx-viewport tools>` fires the same `transform` event.

The viewport draws the bed you pass. Use the printer's bed size from its settings (`printable_area` and `printable_height`) so the plate and the slice agree.

## 2. Turn the plate into a slice request

The transforms the viewport reports place the decoded model. `sx` reads the model file itself, at its own coordinates, so put the decoder's offset back with `fileTransform`:

```ts
import { fileTransform } from '@slicerx/embed'

const request = {
  schemaVersion: 1,
  plate: {
    bed,
    objects: models.map(({ id, file, model, transform }) => ({ id, mesh: file, transform: fileTransform(transform ?? center, model.offset) })),
  },
  config,                                              // step 3
  options: { emitGcode: true, emitPreview: true },
}
```

`mesh` is a path to the STL, or a key of a `meshes` object that maps keys to paths. Paths are relative to the request file, or to the working directory when the request comes on stdin. A whole 3MF project slices as `project.3mf#2` for plate 2, with the transforms the project saved; the viewport has no 3MF decoder yet, so show such a project by its preview.

## 3. Settings

`config` is one object of OrcaSlicer keys (`layer_height`, `wall_loops`, `sparse_infill_density` and so on). Keys you leave out take the engine's defaults. `sx schema request` prints the request's JSON Schema.

If your app keeps its own printer and filament settings, use them. Otherwise read SlicerX's from the MCP server, which carries the profile data in its own process: `slicerx_get_profile` returns a profile's `config` with its `inherits` chain resolved. Merge in the order the server itself uses:

1. the process: `process:slicerx-default` is a fresh SlicerX plate (Standard, 0.20 mm), or one of `process:draft`, `standard`, `fine`, `extra_fine` and `strong`
2. the printer: `machine:<model>`, such as `machine:bambu-a1`
3. the filament: `stock-filament:<vendor>/<preset>`, such as `stock-filament:BBL/Bambu PLA Basic @BBL A1`
4. the person's own changes, such as the overrides from `SettingsPanel`

```ts
const config = { ...process.config, ...printer.config, ...filament.config, ...overrides }
```

Never copy credentials or `post_process` into a config from a project or preset file.

## 4. Slice and estimate

Run `sx` from the main process, never from the window, and hand the window only bytes and numbers:

```ts
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

function slice(request: object, outDir: string): Promise<SliceResult> {
  return new Promise((resolve, reject) => {
    const sx = spawn(sxPath, ['slice', '--request', '-', '--out-dir', outDir])
    let out = ''
    let err = ''
    sx.stdout.on('data', (d) => (out += d))
    sx.stderr.on('data', (d) => (err += d))
    sx.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new SliceError(code ?? 1, err.trim()))))
    sx.stdin.end(JSON.stringify(request))
  })
}

const result = await slice(request, jobDir)
const sxpv = await readFile(result.files.preview)          // to the viewport's preview
```

The result has `layerCount`, `stats` (`timeS`, and `filamentMm` and `filamentG` per slot, slot 1 first) and `warnings`, and with `--out-dir` the written files under `files` (`gcode` and `preview`). For an estimate only, set `emitGcode` and `emitPreview` to false and read `stats`.

Exit codes: 0 sliced, 1 the slice failed, 2 a usage error, 3 invalid input. Show the message from stderr in plain words:

- Paths that cross on the bed exit with 3, naming what crosses (two objects, an object and the prime tower, an exclusion area) and on which layers. Ask the person to arrange the plate (the Arrange button, or `arrange()` on the viewport handle) and slice again. `--allow-collisions` slices anyway, for a person who chose that.
- Custom G-code that is not the stock text of the printer the config names exits with 1: `blocked by the safety preflight: custom G-code: line N: ...`. The printer profile's own G-code from `slicerx_get_profile` is stock text and slices as it is. For G-code from anywhere else, such as a project or preset file, show the person the flagged lines, and only after their yes send the request again with `"options": { "trustedGcode": true }`. Never set it for them. Some lines, such as a factory reset, block even then. [embedding.md](../embedding.md#project-g-code) has the details.

## 5. Show the result

Pass the SXPV bytes to the viewport's `preview` and the view switches to toolpaths; `layer` sets the top layer shown. Show the time and grams from `stats`. Pass `preview={null}` to go back to Prepare.

## 6. Send it to a printer

If your app already talks to printers, send `files.gcode` through its own connection.

Otherwise send it through SlicerX's printer bridge (`sx-link`) with a partner app key. The person makes the key in SlicerX and pastes it into your app; [partner-app-key.md](partner-app-key.md) covers making it, keeping it and revoking it. Read the bridge's public key from `hub-key.pub` in its state folder. The bridge's pairing code is for a person's own AI agent, never for an app.

With the key your app:

- asks to print. The card shows up in SlicerX and on the person's phone, headed "Asked by <your app>, a partner app", and nothing prints until they approve it there. The file rides with the card, and the bridge uploads and starts it once they say yes.
- pauses and cancels on its own, since those only stop a print.
- reads printers and their status (`list`, `status`, `subscribe`) and camera stills.

It cannot approve a print, resume one, send G-code, change a running print or touch the person's settings, keys or printers. The bridge answers those with `forbidden`.

The bridge speaks JSON over a WebSocket on `ws://127.0.0.1:47615` (the [protocol](../../packages/connect/link/README.md#protocol)). This is the whole client, for Node 22 or later or Electron's main process, with nothing to install:

```ts
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'

/** JSON with every object's keys sorted, as the bridge hashes parameters. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

type Bridge = { call: <T>(method: string, params?: object) => Promise<T>; on: (event: string, cb: (data: any) => void) => void; close: () => void }

/** Opens the bridge with a partner app key: checks the hub's signed hello against hub-key.pub, then pairs. */
async function openBridge(url: string, key: string, hubKey: string): Promise<Bridge> {
  const ws = new WebSocket(url)
  await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = () => fail(new Error('SlicerX printer bridge is not running')))))
  let next = 1
  const waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>()
  const listeners = new Map<string, ((data: any) => void)[]>()
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data))
    if (msg.event) return listeners.get(msg.event)?.forEach((cb) => cb(msg.data))
    const w = waiting.get(msg.id)
    waiting.delete(msg.id)
    if (msg.error) w?.fail(Object.assign(new Error(msg.error.message), { code: msg.error.code }))
    else w?.ok(msg.result)
  }
  const call = <T,>(method: string, params: object = {}) =>
    new Promise<T>((ok, fail) => {
      const id = next++
      waiting.set(id, { ok, fail })
      ws.send(JSON.stringify({ id, method, params }))
    })
  // the hub signs our nonce, its own and the port: a program that cannot is not SlicerX's bridge
  const nonce = randomBytes(32)
  const port = Number(new URL(url).port)
  const hello = await call<{ hubKey: string; hubNonce: string; port: number; sig: string }>('hello', { nonce: nonce.toString('base64') })
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hubKey, 'base64')])
  const signed = Buffer.concat([Buffer.from('sx-link hello v2\n'), nonce, Buffer.from(hello.hubNonce, 'base64'), Buffer.from([port >> 8, port & 0xff])])
  if (hello.hubKey !== hubKey || hello.port !== port || !verify(null, signed, createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(hello.sig, 'base64'))) {
    ws.close()
    throw new Error('The program on the bridge port is not the SlicerX printer bridge. The key was not sent.')
  }
  await call('pair', { clientKey: key })
  return { call, on: (event, cb) => listeners.set(event, [...(listeners.get(event) ?? []), cb]), close: () => ws.close() }
}

/** Asks to print a file sx wrote. Resolves once the person answered in SlicerX and the bridge ran it (or not). */
async function askToPrint(bridge: Bridge, printerId: string, name: string, data: Uint8Array, lines: string[]) {
  const fileSha = sha256(data)
  const request = {
    id: randomUUID(),
    sessionId: 'printbay',
    tool: 'printbay.print',
    permission: 'start',
    title: `Print ${name}?`,
    lines,
    printerId,
    paramsHash: sha256(canonical({ printerId, name })),
    // the card's actions are exactly what the bridge will run: upload this file, then start it
    actions: [
      { action: 'printer.upload', target: printerId, paramsHash: sha256(canonical({ printerId, name, sha256: fileSha })) },
      { action: 'printer.start', target: printerId, paramsHash: sha256(canonical({ printerId, name, opts: {}, sha256: fileSha })) },
    ],
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  }
  const work = { kind: 'print', printerId, file: { name, kind: name.endsWith('.bgcode') ? 'bgcode' : 'gcode', sha256: fileSha, dataBase64: Buffer.from(data).toString('base64') } }
  const done = new Promise<{ ok: boolean; code?: string; message?: string }>((resolve) => bridge.on('approval.done', (d) => d.requestId === request.id && resolve(d)))
  await bridge.call('approvals.register', { request, work })
  return done
}

/** Pauses or cancels a print straight away: a partner app approves its own stop card. */
async function stop(bridge: Bridge, printerId: string, action: 'pause' | 'cancel') {
  const request = {
    id: randomUUID(),
    sessionId: 'printbay',
    tool: `printbay.${action}`,
    permission: 'start',
    title: `${action === 'pause' ? 'Pause' : 'Cancel'} the print?`,
    lines: [],
    printerId,
    paramsHash: sha256(canonical({ printerId })),
    actions: [{ action: `printer.${action}`, target: printerId, paramsHash: sha256(canonical({ printerId })) }],
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  }
  await bridge.call('approvals.register', { request })
  const token = await bridge.call('approvals.grant', { requestId: request.id })
  await bridge.call(action, { printerId, token })
}
```

```ts
const bridge = await openBridge('ws://127.0.0.1:47615', partnerKey, hubKey)
const printers = await bridge.call<{ id: string; name: string }[]>('list')
const done = await askToPrint(bridge, printerId, 'part.gcode', await readFile(result.files.gcode), [`${minutes} min, ${grams} g`])
if (!done.ok) show(done.message)  // the person said no, the card expired, or the printer refused
```

`askToPrint` resolves once the person has answered and the bridge has run the print, or not: a denial, an expired card (30 minutes), or the printer's own refusal come back with `ok: false`, a `code` and a message to show. `bed_check` means the person has to confirm the bed is clear in SlicerX. A card's actions have to match the work exactly (the printer, the file's name and SHA-256, and the start options), or the bridge refuses the card.

`sx` writes plain G-code, so a Bambu Lab printer prints it without an AMS slot map, from the filaments its G-code names. A multi-color Bambu Lab plate needs a `.gcode.3mf` with its slot map, which the MCP server makes.

Whichever route, a person approves every print start in SlicerX or on their phone. Your app never approves one.

## Licenses

`sx`, `@slicerx/viewport` and `@slicerx/embed` are Apache-2.0 and can ship in closed code; keep their license and notice files. `sx` does not use the stock printer profiles, which are AGPL-3.0-or-later. Profile data read through the MCP server stays in that server's process, which runs on its own as Path B describes. The settings values your app receives and saves are data for its slices.

## Before you finish

- The viewport shows the plate with `tools`, and a move, turn or arrange survives the next render.
- A slice of the plate lands where the viewport shows it: `fileTransform` on every object.
- `sx` runs from the main process, and the window gets bytes and numbers, never paths.
- Collisions and blocked G-code reach the person as plain messages, and `trustedGcode` is set only after a person said yes.
- No print start is approved by your app, and the partner key lives in the system's secure storage, never in a file or a log.
