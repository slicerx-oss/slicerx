# Embedding SlicerX

Other apps can use SlicerX at several levels: the Rust crate, the `sx` CLI, the npm package, a C ABI, the viewport and settings panel, theming, and the MCP server for AI tools. This page shows the API of each one. [install.md](install.md) covers building and installing them. To ship a full product of your own built on SlicerX, with your brand, features and AI provider set in one configuration file, see [integrating.md](integrating.md). To put SlicerX inside an existing app (slice from it, show previews, open locked projects), start with [integrators/quickstart.md](integrators/quickstart.md).

Each surface is versioned on its own with semver, starts at 0.x, and keeps a `CHANGELOG.md` next to its code. Before 1.0 a breaking change bumps the minor version. The formats that cross these surfaces carry version numbers of their own (`schema_version` in JSON, a version field in the SXPV header), and readers reject versions they do not know.

| Surface | Use it when | State |
| --- | --- | --- |
| [Rust crate](#rust-crate) `sx-core` | Your app is in Rust, or you build a server or a tool around the slicer | `cargo add sx-core` |
| [CLI](#cli) `sx` | You want a separate process that reads a model and writes G-code | [Engine release](https://github.com/slicerx-oss/slicerx/releases) |
| [npm package](#npm-package) `@slicerx/slicer` | You slice in a browser | `npm install @slicerx/slicer` |
| [C ABI](#c-abi) `libslicerx` | Your app is in C, C++, Swift, C#, Go or another language with a C FFI | [Engine release](https://github.com/slicerx-oss/slicerx/releases) |
| [Viewport](#viewport) `@slicerx/viewport` | You want the 3D plate and toolpath preview in a web page | `npm install @slicerx/viewport three` |
| [UI parts](#ui-parts) `@slicerx/embed` | You want the viewport and settings panel as React components or custom elements | `npm install @slicerx/embed react react-dom three` |
| [Theming](#theming-and-branding) `@slicerx/ui` | Your product's colors, fonts, gradient, logo and icons on every SlicerX surface | Working |
| [MCP server](#mcp-server) `@slicerx/mcp` | An AI assistant should slice, plan settings, run mimir skills or control printers | `npx @slicerx/mcp` |

Settings everywhere use OrcaSlicer's key names (`layer_height`, `wall_loops`, `sparse_infill_density` and so on). `packages/settings/schema.json` lists all of them with type, unit, limits and help text. Units are millimeters, degrees Celsius, seconds and grams. Coordinates are Z up with the origin at the front left corner of the bed.

## Rust crate

```sh
cargo add sx-core
```

`sx_core::api` is the embedding surface and the only part of the crate covered by semver. It has two ways in. The default features are `parallel` (layers in parallel on rayon) and `import` (OBJ and AMF through `sx-geom`); a WebAssembly build turns both off with `default-features = false`.

The JSON way takes the same `SliceRequest` the CLI, the C ABI and the WebAssembly build use:

```rust
use std::sync::Arc;
use sx_core::api;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mesh = Arc::new(api::load_mesh(&std::fs::read("x-mark.stl")?, "x-mark.stl")?);
    let req: api::SliceRequest = serde_json::from_str(
        r#"{"plate":{"objects":[{"mesh":"x-mark"}]},"config":{"layer_height":0.2,"wall_loops":3}}"#,
    )?;
    let run = api::run_request(&req, &|_id: &str| Ok(mesh.clone()))?;
    println!("{} layers, {:.0} s", run.report.layer_count, run.report.stats.time_s);
    std::fs::write("x-mark.gcode", &run.gcode)?;
    std::fs::write("x-mark.sxpv", &run.preview)?; // preview buffer for the viewport
    Ok(())
}
```

The typed way is `load_mesh`, then `slice` or `slice_range` on a `Plate`, then `emit_gcode` and `preview_buffers`.

- `load_mesh(bytes, file_name)` reads binary and ASCII STL and 3MF; `load_3mf_plates` returns every plate of a Bambu Lab or OrcaSlicer project. OBJ is planned.
- The config uses OrcaSlicer keys. Missing keys keep the defaults, and out-of-range values are rejected.
- `slice_range` slices a range of layers, which is how the browser splits work across workers. Sharded and unsharded runs produce identical bytes, and every benchmark run checks it.
- G-code comes out for Marlin 2, Klipper and RepRapFirmware, with time, filament length and weight per slot, cost and tool changes.
- The preview buffer (SXPV) has 32 bytes per segment, drawn by the viewport with GPU instancing.
- Library code returns errors instead of panicking on bad input.

## CLI

Running `sx` as a separate process is the simplest way to use SlicerX from any language. Each [engine release](https://github.com/slicerx-oss/slicerx/releases) (tags `engine-v*`) has an archive per platform, `slicerx-engine-<version>-macos-universal.tar.gz`, `-linux-x64.tar.gz` and `-windows-x64.zip`, with `sx`, `sx-geom` and `sx-link` in `bin/`, and `SHA256SUMS.txt` next to them. The macOS binaries are signed and notarized; the Windows and Linux ones are not signed yet. To build them yourself, run `cargo build -p sx-cli --release`.

```sh
sx slice x-mark.stl --config config.json -o x-mark.gcode --preview x-mark.sxpv
sx slice --request request.json --out-dir out/      # or --request - to read stdin
sx schema request                                   # JSON Schema of the request; `sx schema result` for the result
```

A file slice takes OrcaSlicer keys in `config.json`, such as `{ "layer_height": 0.2, "wall_loops": 3, "gcode_flavor": "klipper" }`, and prints a one-line summary. For a 3MF project, `--plate N` picks the plate. The examples use `x-mark.stl`, the SlicerX reference model in `packages/core/bench/models` (Apache-2.0, with a two-color `x-mark-2color.3mf`).

A request slice reads a `SliceRequest`:

```json
{
  "schemaVersion": 1,
  "plate": { "objects": [{ "id": "a", "mesh": "x-mark", "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 60,40,0,1] }] },
  "config": { "layer_height": 0.2, "wall_loops": 3 },
  "options": { "emitGcode": true, "emitPreview": true },
  "meshes": { "x-mark": "x-mark.stl" }
}
```

It prints a result JSON with `schemaVersion`, `layerCount`, `stats` (`timeS`, and `filamentMm` and `filamentG` per slot), `warnings`, and, with `--out-dir`, the paths of `slice.gcode` and `slice.sxpv` under `files`. An object without a transform is centered on the bed. A `mesh` value is a key of `meshes` or a path relative to the request file, and `project.3mf#2` picks plate 2 of a project. Use `--request -` to pass the request on stdin. For an estimate only, set `"emitGcode": false` and `"emitPreview": false` and read `stats` from the result. Exit codes: 0 success, 1 slicing failed, 2 usage error, 3 invalid input.

### Project G-code

Custom G-code in `config` (start, end, layer change, filament change and the rest) is linted before it runs. Text from a project or another file is untrusted, so a line that changes the printer, such as `M500` (writes settings to its memory), blocks the slice with `blocked by the safety preflight: custom G-code: line N: ...` and exit code 1. Three cases:

- Stock text runs as is. When the settings name the printer (`printer_settings_id`, `inherits` or `printer_model`, as a Bambu Studio or OrcaSlicer project saves them, such as `Bambu Lab P1S`), `sx` compares each G-code setting with the versions the maker shipped for that printer, and an unchanged one is trusted. A Bambu project with its printer's stock start G-code slices without a question.
- Anything else goes to the person first. Review the project's G-code with `reviewProjectGcode` from `@slicerx/settings`: it returns each changed setting with a diff and the flagged lines and their reasons, and whether a person may approve it (`approvable`). Show that to the person. After their yes, send the request again with `"options": { "trustedGcode": true }`. Never set it for them, and never set it for text no one has seen.
- Lines no one can approve (such as `M502`, a factory reset) block even with `trustedGcode`, and in stock text too.

```ts
import { reviewProjectGcode } from '@slicerx/settings'
const review = reviewProjectGcode({ project: projectSettings, profile: printerProfileSettings, model: 'bambu-p1s' })
if (review.changes.length === 0) {
  // Stock text, or the printer profile's own text the app chose: nothing to ask.
  request.options = { ...request.options, trustedGcode: true }
} else if (review.changes.every((c) => c.approvable) && (await askThePerson(review.changes))) {
  request.options = { ...request.options, trustedGcode: true }
}
```

The C ABI and the WebAssembly build take the same `trustedGcode`; the stock check is in `sx` only.

## npm package

`@slicerx/slicer` runs the WebAssembly core in a pool of Web Workers. Each worker slices a range of layers, and the results are stitched into one G-code file and one preview, byte-identical to the native build. It needs no `SharedArrayBuffer` or cross-origin isolation.

```sh
npm install @slicerx/slicer
```

The package loads `dist/sx_wasm.wasm` and its worker script relative to its own module (`new URL(..., import.meta.url)`). Bundlers that follow that pattern, such as Vite and webpack 5, copy both into your build; for the Vite dev server, list `@slicerx/slicer` in `optimizeDeps.exclude`. Pass `wasmUrl` to serve the module from somewhere else.

```ts
import { createWebSlicer, readPreview, type PrintConfig } from '@slicerx/slicer'

const slicer = await createWebSlicer({ workers: 4 })
const mesh = await slicer.loadModel(await (await fetch('/models/x-mark.stl')).arrayBuffer(), 'x-mark.stl')
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 128, 128, 0, 1]
const bed = { widthMm: 256, depthMm: 256, heightMm: 250 }
const config = { layer_height: 0.2, wall_loops: 3 } as PrintConfig // keys left out keep their defaults
const result = await slicer.slice({ plate: { bed, objects: [{ id: 'a', name: 'x-mark', mesh: mesh.id, transform: identity }] }, config })
console.log(result.layerCount, result.stats.timeS, result.stats.filamentG)
const gcode = await slicer.exportGcode(result.id, { kind: 'blob' })
const preview = readPreview(await slicer.getPreview(result.id))
```

`createWebSlicer({ workers?, wasmUrl?, fake? })` returns a `SlicerHost`:

```ts
loadModel(data: ArrayBuffer, fileName: string): Promise<MeshHandle>
slice(req: SliceRequest, opts?: { onProgress?: (p: SliceProgress) => void; signal?: AbortSignal }): Promise<SliceResult>
getPreview(sliceId: string): Promise<ArrayBuffer>          // SXPV; parse with readPreview()
exportGcode(sliceId: string, target: GcodeTarget): Promise<GcodeExport>
release(id: string): void
```

Transforms are 4x4 column-major matrices in millimeters, so the last column above moves the object to the middle of a 256 mm bed. Meshes are referenced by id and content hash, so a re-slice after a settings change does not copy geometry into the workers again. `createWasmSlicer({ wasm, workers, shardsPerWorker, warmUp })` gives you control over where the module comes from and how work is split, and `{ fake: true }` returns a stand-in that answers with a synthetic preview, for tests. On the reference plate the pool's first slice takes 55.3 ms in Chrome (median of 9 fresh pages).

## C ABI

`libslicerx` exposes JSON in and out, opaque handles and byte buffers; no Rust type crosses the boundary. Each [engine release](https://github.com/slicerx-oss/slicerx/releases) ships it in the same archives as the CLI: `lib/libslicerx.dylib` (macOS, universal), `lib/libslicerx.so` (Linux x64) or `lib/slicerx.dll` with its import library `slicerx.dll.lib` (Windows x64), and `include/slicerx.h`. Its tests build a C program against it that slices the reference plate.

```c
#include "slicerx.h"

uint64_t mesh = sx_mesh_load(stl_bytes, stl_len, "x-mark.stl");       /* 0 on error */
/* request_json: a SliceRequest whose object "mesh" values are ids from sx_mesh_load */
SxResult *r = sx_slice(request_json);
if (!r) { fprintf(stderr, "%s\n", sx_last_error()); return 1; }
SxBuffer gcode = sx_result_gcode(r);
fwrite(gcode.ptr, 1, gcode.len, out);
sx_buffer_free(gcode);
sx_result_free(r);
sx_mesh_free(mesh);
```

The full set: `sx_abi_version`, `sx_mesh_load`, `sx_mesh_free`, `sx_slice`, `sx_result_json` (the same result JSON as the CLI), `sx_result_gcode`, `sx_result_preview` (SXPV), `sx_buffer_free`, `sx_result_free` and `sx_last_error` (per thread). Every call is thread-safe. `SX_ABI_VERSION` changes on any breaking change, and CI diffs the generated header. To build it yourself, run `cargo build -p sx-ffi --release`; the header is `packages/core/ffi/include/slicerx.h`.

## Viewport

`@slicerx/viewport` is a three.js viewport with no framework dependency. It owns its render loop and renders on demand, so a host calls methods on a handle instead of re-rendering it. Install it with `npm install @slicerx/viewport three` (three.js 0.186 is a peer dependency). It lives in `packages/ui/viewport`; run its demo with `pnpm --filter @slicerx/viewport dev` (port 5190).

```ts
import { createViewport, readPreview } from '@slicerx/viewport'

// bed, identity, positions and indices as in the npm example; sxpvBytes from getPreview() or sx --preview
const vp = createViewport(document.querySelector('canvas')!, { quality: 'balanced', label: 'Plate preview' })
vp.setPlate({ bed, objects: [{ id: 'a', name: 'x-mark', transform: identity, parts: [{ name: 'body', positions, indices, color: '#bd93f9' }] }] })

vp.setMode('preview')
vp.setPreview(readPreview(sxpvBytes))
vp.setLayerRange(0, 120)
vp.setColorMode('feature')
const off = vp.on('pick', (e) => console.log(e.objectId, e.point))
// later: off(); vp.dispose()
```

Options: `backend` (`auto`, `webgpu` or `webgl2`), `quality` (`high`, `balanced` or `low`), `maxPixelRatio`, `label` and `adaptive`. The handle also has `setTransforms`, `setRenderMode`, `setOverhangAngle`, `setSelection`, `arrange`, `view`, `setCamera`, `setMoveCut`, `setToolColors`, `setTravels`, `stats` and events for `select`, `transform`, `camera`, `error` and `degrade`. `packages/ui/viewport/src/types.ts` has the full types.

## UI parts

`@slicerx/embed` wraps the viewport and the settings panel for pages that want them without the rest of the app. Install it with `npm install @slicerx/embed react react-dom three`: React 19 and three.js 0.186 are peer dependencies, `@slicerx/viewport` comes with it, and the settings schema, design tokens and shared types are bundled in. Run its demo page with `pnpm --filter @slicerx/embed dev` (port 5191).

```tsx
import { Viewport, SettingsPanel } from '@slicerx/embed'

<Viewport preview={sxpvBytes} look="studio" colorMode="feature" layer={120} view="iso" onPick={(e) => console.log(e)} />
<SettingsPanel config={baseProfile} mode="easy" onChange={({ easy, overrides, config }) => save(config)} />
```

- `Viewport` props: `plate` (a `ViewportPlate`), `preview` (SXPV bytes or parsed `PreviewBuffers`), `look` (`studio`, `clay`, `xray`, `overhang`, `filament`), `colorMode` (`feature`, `tool`, `speed`, `flow`, `layerTime`), `layer` (top visible layer, 1-based), `view` (`iso`, `top`, `front`, `fit`), `toolColors` (filament color per slot), `toolFinishes` (how each slot's toolpaths shine: `matte`, `satin`, `glossy` or `silk`, which streaks along each bead the way a silk print does), `plateStyle` (`grid`, or a build plate surface under the print: `textured-pei`, `smooth-pei`, `cool`, `engineering`), `quality`, `onPick`, `onReady(viewport)` for the imperative handle, `label`, `className`, `style`.
- `SettingsPanel` props: `config` (the base profile, OrcaSlicer keys), `easy`, `mode` (`easy` or `advanced`), and `onChange({ easy, overrides, config })`.
- Helpers: `decodeStl(bytes, name)` and `decodeQuantized(json)` turn a file into viewport parts (also at `@slicerx/embed/mesh`), and `injectStyles()` adds the stylesheet when you do not import it.

Pages without React call `defineSlicerXElements()` once:

```html
<sx-viewport src="x-mark.stl" look="studio" color-mode="feature" view="iso"></sx-viewport>
<sx-settings-panel mode="easy"></sx-settings-panel>
<script type="module">
  import { defineSlicerXElements } from '@slicerx/embed'
  defineSlicerXElements()
  document.querySelector('sx-settings-panel').addEventListener('change', (e) => console.log(e.detail.config))
</script>
```

`<sx-viewport>` also takes the `plate` and `preview` properties (set SXPV bytes on `preview`), the `finish` attribute (one finish for every slot, or one per slot: `finish="satin silk"`) and `plate-style`, and fires `pick`. `<sx-settings-panel>` takes a `config` property and fires `change` with `{ easy, overrides, config }`. Each element renders in its own shadow root, so your page's styles do not leak in.

## Theming and branding

Every SlicerX surface you embed can carry your brand. The UI components read their colors, gradient, fonts, radii and spacing from CSS variables, and a typed theme object sets them. You can switch themes at runtime, scope a theme to one panel inside your page, replace icons, and put your logo where the SlicerX wordmark would be.

```tsx
import '@slicerx/ui/styles.css'
import { ThemeProvider, createTheme, subbanLight, themeToCss, resolveColor } from '@slicerx/ui'

const acme = createTheme({
  name: 'acme',
  colors: { purple: '#2f6df6', pink: '#e8457c', onGrad: '#ffffff' },
  gradient: { from: '#2f6df6', to: '#22c1c3', angle: '120deg' },
  fonts: {
    display: '"Space Grotesk", system-ui, sans-serif',
    body: '"Inter", system-ui, sans-serif',
    href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@600&display=swap',
  },
  radius: { md: '6px', lg: '10px' },
}, subbanLight) // start from the light theme

export function PrintPanel() {
  return (
    <ThemeProvider theme={acme} scope="scope" logo={<img src="/acme.svg" alt="Acme" height={18} />}>
      {/* SlicerX components here render in Acme's colors and fonts */}
    </ThemeProvider>
  )
}

// Without React: ship a static stylesheet, or pass concrete colors to a canvas.
const css = themeToCss(acme, '[data-sx-theme="acme"]')
const accent = resolveColor(acme, 'var(--purple)') // "#2f6df6"
```

`createTheme(overrides, base)` merges your overrides onto Subban, the dark default. `subbanLight` and `forge` (a complete rebrand to start from) are built in. Keep the color roles when you recolor: the accent marks selection and focus, cyan marks live data, green ok, orange attention and red errors. The gradient belongs to the layered X mark and at most one hero moment on a screen; controls, including the primary button, use the solid accent color. Without React, import the same functions from `@slicerx/ui/theme`. An AI assistant connected to the MCP server can build and check a theme with `slicerx_theme_create`, which reports any text and background pair below WCAG AA. The full reference is [packages/ui/THEMING.md](../packages/ui/THEMING.md).

The viewport takes a theme of its own for the 3D scene: background gradient, selection, live layer, travel, overhang, clay, plate and edge colors, a color per SXPV feature, a heat ramp of two to eight stops, and tool colors. Every field is optional. The full reference is [packages/ui/viewport/THEMING.md](../packages/ui/viewport/THEMING.md).

```ts
import { createViewport } from '@slicerx/viewport'
import { themeProblems } from '@slicerx/viewport/palette'

const theme = {
  scene: { bgTop: '#1b2430', bgBottom: '#0d1117', selection: '#e0af68' },
  heatRamp: ['#2b6cb0', '#f6e05e', '#dd6b20'],
  toolColors: ['#f7d959', '#1d1d21'],
}
console.log(themeProblems(theme)) // [] when every color is valid

const vp = createViewport(canvas, { theme })
vp.setTheme({ scene: { bgTop: '#ffffff' } }) // change at runtime
vp.setTheme() // back to the defaults
```

`setTheme` throws an `Error` listing each invalid color; `themeProblems` returns the same list without throwing. Clay, overhang and edge materials are shared by every viewport on the page, so a page has one theme for them. Camera and mouse controls are separate: `createViewport(canvas, { controls: 'bambu-studio' })` (also `slicerx`, `prusaslicer`, `orcaslicer`).

## MCP server

`@slicerx/mcp` gives AI assistants what mimir can do in the app: slice and estimate files, plan and check settings, open a project and run mimir's skills on it (orient, arrange, cut, slice), queue plates, control printers, and read the knowledge base and these guides as resources. Anything that changes a printer or a saved profile, or spends money, follows the user's permission policy (Allow, Ask first or Off per class of action) and runs only with a single-use approval token. It runs over stdio or streamable HTTP. Setup, the policy format and the tool list are in [packages/mcp/README.md](../packages/mcp/README.md).

## Licensing

The base kit, which is every surface on this page, is Apache-2.0.

- You can link the crate, the C ABI or the npm package into an app under any license, including closed source, and ship it, under either license.
- Keep the license and notice files with what you ship. The stock printer profiles (`packages/profiles`, read through `@slicerx/settings` and `sx-settings`) are AGPL-3.0-or-later; the engine, the CLI and the C ABI do not use them (`docs/licensing.md`).
- The base kit contains no code from OrcaSlicer, Bambu Studio or PrusaSlicer, including the wall generators (classic, Arachne and aegis) and the supports. Vendored libraries and other third-party material keep their own licenses and are listed in [THIRD-PARTY.md](../THIRD-PARTY.md).
- Embedding the base kit is different from building an edition: an edition is a whole product (accounts, cloud slicing, store, branded apps) and ships the AGPL-3.0-or-later stock profiles. [integrating.md](integrating.md) covers building one.
- The SlicerX name and logo are not covered by either license. Say "built with SlicerX" freely; ask before using the logo in a product.

This is general guidance, not legal advice. [LICENSE](../LICENSE) and [NOTICE](../NOTICE) are the authoritative texts.
