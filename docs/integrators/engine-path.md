# Prepare in the viewport, slice with sx

This is Path B with the engine itself in place of the MCP server for slicing. Your app shows the plate in the SlicerX viewport, where people place parts with the Prepare tools. Its main process then turns the plate into a slice request and runs the `sx` engine on it. The preview goes back into the viewport.

Use it when your app already has its own window, its own models and its own idea of a job, and you want the slice itself under your control: one process call, one JSON request, one JSON result. Use the MCP server ([AGENTS.md](AGENTS.md), Recipe B) when you would rather SlicerX layer the settings, review a project's G-code, write `.gcode.3mf` files and send plates to printers for you.

What you take on with `sx` directly:

- Settings. `sx` takes one flat config of OrcaSlicer keys. You layer the printer, process and filament settings yourself (step 3).
- Custom G-code. `sx` trusts the stock text of the printer the config names; anything else blocks the slice until a person approves it (step 4).
- File formats. `sx` writes G-code (`.gcode`, or `.bgcode` when the config asks for it) and the SXPV preview. It does not write `.gcode.3mf`. A Bambu Lab printer with an AMS needs the `.gcode.3mf` and its slot map, which the MCP server builds.
- Printers. Sending a file that `sx` wrote to a printer through SlicerX's printer bridge is not available to other apps yet; see step 6.

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

Sending a file that `sx` wrote through SlicerX's printer bridge (`sx-link`) is not open to other apps yet: the bridge pairs only with SlicerX's own clients. A partner app key for the bridge is in progress, and this step will describe it when it ships. Until then, the MCP server's `slicerx_printer_queue` sends plates that the server sliced itself (Recipe E in [AGENTS.md](AGENTS.md)).

Whichever route, a person approves every print start in SlicerX or on their phone. Your app never approves one.

## Licenses

`sx`, `@slicerx/viewport` and `@slicerx/embed` are Apache-2.0 and can ship in closed code; keep their license and notice files. `sx` does not use the stock printer profiles, which are AGPL-3.0-or-later. Profile data read through the MCP server stays in that server's process, which runs on its own as Path B describes. The settings values your app receives and saves are data for its slices.

## Before you finish

- The viewport shows the plate with `tools`, and a move, turn or arrange survives the next render.
- A slice of the plate lands where the viewport shows it: `fileTransform` on every object.
- `sx` runs from the main process, and the window gets bytes and numbers, never paths.
- Collisions and blocked G-code reach the person as plain messages, and `trustedGcode` is set only after a person said yes.
- No print start is approved by your app.
