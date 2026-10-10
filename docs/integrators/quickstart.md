# Building SlicerX into your app

This guide is for apps that put SlicerX inside them, such as a model library or a print queue. If your product is a slicer, the main path is to make your own edition: copy the configuration, set your name, identifiers, theme and features, and build the desktop app from it. [AGENTS.md](AGENTS.md#path-a-make-your-own-edition) walks through it, including the license obligations and what a config rebrands, and `docs/integrating.md` has the long guide. The rest of this guide covers adding SlicerX pieces to an app you already have, which has two ways, and most apps use both.

- Drive it. Your app starts the SlicerX MCP server as a child process and calls its tools: slice a model with a printer, filament and process, get G-code or a `.gcode.3mf` with time and filament estimates, list profiles, and, if you want them, open locked projects. Nothing in SlicerX needs a window for this.
- Build it in. `@slicerx/embed` gives you the SlicerX 3D viewport and the print settings panel as React components or custom elements, plus optional locked-project (`.sxlock`) support with no UI at all.

[embedding.md](../embedding.md) covers the lower layers (the Rust crate, the `sx` CLI, the C ABI and the WebAssembly slicer). Read it if you want to call the engine directly instead.

Everything in this guide runs locally with no SlicerX account and no token, except the two features marked optional: cloud slicing and locked projects (see Token scopes).

## Before you start

Install the packages in your app, and get the `sx` engine from an [engine release](https://github.com/slicerx-oss/slicerx/releases) (the archive for your platform has it in `bin/`; `SHA256SUMS.txt` has the checksums):

```sh
npm install @slicerx/mcp@0.1.0 @slicerx/embed@0.1.0 react@19 react-dom@19 three@0.186
```

To try a build that is not released yet, run `node scripts/pack-integrator-kit.mjs /path/to/kit` in a clone and install the tarballs it lists, and build the engine with `cargo build -p sx-cli --release`. Your app also needs `@modelcontextprotocol/sdk` (1.31.0) to talk to the server, and React 19 for the React components. [AGENTS.md](AGENTS.md) walks a coding agent through the whole integration, and `examples/integrator-sample` is a working app that does everything in this guide.

Ship `sx` (or `sx.exe`) with your app and point the server at it. Without it the server falls back to a stub engine that only estimates STL files and writes G-code nobody can print.

## Drive SlicerX over MCP

Start the server over stdio from your app's main process (Electron's main process, a Node service, anything that can spawn a process):

```sh
node node_modules/@slicerx/mcp/dist/cli.js \
  --engine sx --sx-bin /path/to/sx \
  --allow-dir /path/to/the/user/library \
  --out-dir /path/to/your/app/data/slicerx \
  --printers off --no-urls
```

- `--allow-dir` limits which folders the server may read models and presets from. Give it only the folders your user picked. The server also reads its own `--out-dir`, so a project opened with `slicerx_sxlock_open` slices from there.
- `--out-dir` is where G-code, `.gcode.3mf` files and previews go. Each slice gets its own folder under `jobs/`. Move or copy what you keep; the folder is yours to clean up.
- `--printers off` hides the printer tools. Use `--printers link` if you want SlicerX's printer bridge (`sx-link`) to talk to printers. The default, `demo`, shows simulated printers.
- `--no-urls` stops the server from downloading models, which an app that hands it local files does not need.

### A minimal client

This uses the official MCP TypeScript SDK. The same calls work from any MCP client library.

```ts
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

// The server script inside the installed @slicerx/mcp package.
const cli = createRequire(import.meta.url).resolve('@slicerx/mcp/cli')
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, '--engine', 'sx', '--sx-bin', sxPath, '--allow-dir', libraryDir, '--out-dir', outDir, '--printers', 'off', '--no-urls'],
})
const slicerx = new Client({ name: 'my-app', version: '1.0.0' })
await slicerx.connect(transport)

// What is in this project file?
const info = await slicerx.callTool({ name: 'slicerx_inspect_project', arguments: { file: '/library/Benchy.3mf' } })
// info.structuredContent.plates: [{ index: 1, name: 'Body', objects: 1 }, ...]

// Slice plate 1 for an A1, PLA in slot 1 and the user's own PETG preset in slot 2, as a .gcode.3mf, with progress.
const result = await slicerx.callTool(
  {
    name: 'slicerx_slice_file',
    arguments: {
      model: '/library/Benchy.3mf',
      plate: 1,
      profiles: ['machine:bambu-a1', 'process:standard'],
      filaments: [
        { slot: 1, profile: 'stock-filament:BBL/Bambu PLA Basic @BBL A1', color: '#F4EE2A' },
        { slot: 2, file: '/library/presets/My PETG.json', color: '#00AE42' },
      ],
      overrides: { sparse_infill_density: 20 },
      output: 'gcode.3mf',
    },
  },
  CallToolResultSchema,
  { onprogress: (p) => console.log(p.progress, p.message), timeout: 10 * 60_000 },
)

if (result.isError) {
  const { code, message } = (result.structuredContent as { error: { code: string; message: string } }).error
  // branch on code, show message
} else {
  const s = result.structuredContent as {
    time_s: number
    filament_g: number
    filaments: { slot: number; filament_g: number; filament_mm: number }[]
    gcode_path: string
    gcode_3mf_path?: string
  }
}
```

A slice can take minutes on a large model, so raise the client's request timeout as above.

The server needs Node 24 or later. `process.execPath` is the Node running your app. In Electron it is Electron itself: use it with `ELECTRON_RUN_AS_NODE=1` in `env` when that Electron's Node (`process.versions.node`) is 24 or later; otherwise bundle a Node runtime and pass its path as `command`. In CommonJS, `require.resolve('@slicerx/mcp/cli')` finds the script.

An app written in Node can also host the server in its own process with `createContext` and `createSlicerxServer` from `@slicerx/mcp` and an in-memory transport. The package's tests do exactly that (`packages/mcp/test/helpers.ts`).

### The tools an integration uses

| Tool | What it does |
| --- | --- |
| `slicerx_slice_file` | Slices an STL, OBJ, 3MF or `.sx3mf` file, or one plate of a project. Writes G-code, and with `output: "gcode.3mf"` also a `.gcode.3mf`. With `preview: true` it writes the toolpath preview (SXPV) the embed viewport shows. |
| `slicerx_estimate_file` | The same inputs, numbers only: time, filament per slot, layers. Writes no G-code. |
| `slicerx_inspect_project` | A 3MF or `.sx3mf` project's plates, the presets it was saved with, its filament slots (type and color) and whether it carries print settings. |
| `slicerx_list_profiles`, `slicerx_get_profile` | Printer, process and filament profiles to pass as `profiles`. Filter by `section`, `source`, `vendor` or `query`. |
| `slicerx_printer_profile_search` | Finds a printer model by vendor or model text, with its nozzle sizes. |
| `slicerx_sxlock_inspect`, `slicerx_sxlock_open`, `slicerx_sxlock_export` | Locked projects: read the owner offline, open one to an `.sx3mf`, lock an `.sx3mf` for the account. |
| `slicerx_cloud_slice`, `slicerx_cloud_jobs` | Slice in a SlicerX cloud instead of on the user's machine, when one is configured. |
| `slicerx_local_ai_check`, `slicerx_local_ai_setup`, `slicerx_local_ai_status` | Set up local AI: what this computer can run and why, a download through Ollama after the user approves it, then a tool call and speed check; and what is installed. |

The full tool list, the permission policy and every option are in [packages/mcp/README.md](../../packages/mcp/README.md).

### Settings and profiles

A slice starts from SlicerX's defaults and applies, in this order:

1. The project file's own print settings, with `project_settings: true` (3MF and `.sx3mf` only). This is how you slice a Bambu Studio or OrcaSlicer project the way the user saved it.
2. `profiles`, in the order given. Ids come from `slicerx_list_profiles`:
   - `machine:<model>` for SlicerX printer profiles, such as `machine:bambu-a1` or `machine:prusa-mk4s`
   - `process:<tier>`: `draft`, `standard`, `fine`, `extra_fine` or `strong`
   - `stock-filament:<vendor>/<preset>` for the makers' own filament presets, such as `stock-filament:BBL/Bambu PLA Basic @BBL A1`
   - `filament:<material>` and `printer:<id>` for knowledge base materials and printers, and `intent:<goal>` for an Easy goal
3. `profile_files`: the user's own OrcaSlicer or Bambu Studio presets, as `.json` files or preset bundles (`.bbscfg`, `.bbsflmt`, `.orca_printer`, `.orca_filament`, `.zip`). Printer presets apply first, then process, then filament. A preset that inherits from a maker profile SlicerX ships gets that profile's values too.
4. `filaments`: a filament per slot, for multi-material plates. Each entry is `{ slot, profile }`, `{ slot, file }` (a filament preset file) or `{ slot, color }`, with an optional `color` (`#RRGGBB`) in each, and sets only its own slot. The `.gcode.3mf` then names each slot's type and color. Without it, a filament profile in `profiles` sets every slot.
5. `overrides`: OrcaSlicer setting keys and values, such as `{ "layer_height": 0.16 }`. `slicerx_find_settings` and `slicerx_explain_setting` look keys up.

Settings that run programs (`post_process`) and credentials (printer host passwords and API keys) are never read from project or preset files.

Custom G-code (start, end, layer change and filament change G-code) is trusted only when it is the text SlicerX ships for the selected profiles. G-code that comes from a profile SlicerX does not ship, a preset file or an override gets the engine's strict checks. Projects sliced through mimir's tools follow the same rule. A line those checks refuse, such as one that turns off the motors in the start G-code, stops the slice with `preflight_blocked`.

A project's own printer G-code (`project_settings: true`) is compared with the printer's stock text first: the template SlicerX ships for the printer model, or any version Bambu Studio or OrcaSlicer shipped for it. Line endings, trailing spaces and blank lines do not count. Stock text is used as it is, and `project_gcode` in the result says so ("The project's start G-code matches the stock Bambu Lab A1 start G-code."). The model is the `machine:` profile in `profiles`, or the printer the project was saved for. G-code that is not stock text stops the call with `project_gcode_review`. `structuredContent.error.details` then holds, per setting, the unified diff against the printer profile's G-code (`diff`), each flagged line with its reason (`flags`: `line`, `code`, `reason`, and `severity`, where `error` means it is never allowed and `warning` that it needs a person's yes) and whether a person may choose it (`approvable`). Show it to the person. Call again with `project_gcode: "profile"` to slice with the printer profile's G-code instead. No tool call can choose the project's own G-code; a person does that in SlicerX.

### What a slice returns

`structuredContent` of `slicerx_slice_file` and `slicerx_estimate_file`:

| Field | Meaning |
| --- | --- |
| `time_s`, `time_text` | Estimated print time |
| `filament_g`, `filament_mm` | Filament for the whole plate |
| `filaments` | Use per filament slot: `{ slot, filament_g, filament_mm }`, slot 1 first. Use it for spool tracking. |
| `layer_count`, `tool_changes` | Layers, and filament changes on multi-material plates |
| `plate` | The plate that was sliced, for a project |
| `gcode_path`, `gcode_sha256` | The G-code file and its SHA-256 |
| `gcode_3mf_path` | The `.gcode.3mf`, when you asked for one. It carries the plate picture the engine draws (512 by 512 and 128 by 128 pixels unless the settings name other `thumbnails` sizes). |
| `preview_path` | The SXPV toolpath preview, when you asked for one |
| `applied` | The settings layers that were applied, in order |
| `warnings` | Things the user should know, such as a model larger than the bed |

### Progress

Pass a progress token (in the TypeScript SDK, an `onprogress` callback) and the slice tools send `notifications/progress` with `progress` from 0 to 1 and a message for each stage: reading the model, resolving settings, slicing, writing the `.gcode.3mf`, done. Progress is per stage, not per layer. `slicerx_local_ai_setup` sends the download in bytes, then the check.

### Printers

The printer tools (`--printers link`) read printer state and can queue a sliced plate. Starting or resuming a print and sending G-code always need a person to approve it in SlicerX or on a paired phone. An app cannot approve that through MCP, and the user's policy file cannot loosen it. An app that runs its own printer connection can take the `.gcode.3mf` or G-code from a slice and send it itself.

## Build it in with @slicerx/embed

### Show a slice

Ask for `preview: true`, read the file at `preview_path` in the main process, and hand the bytes to the viewport:

```tsx
import { EmbedTheme, Viewport, injectStyles } from '@slicerx/embed'

injectStyles()

export function SlicePreview({ sxpv }: { sxpv: ArrayBuffer }) {
  return (
    <EmbedTheme theme="dark">
      <Viewport preview={sxpv} colorMode="feature" view="iso" />
    </EmbedTheme>
  )
}
```

Without React, use the custom element and set its `preview` property:

```html
<script type="module">
  import { defineSlicerXElements } from '@slicerx/embed'
  defineSlicerXElements()
  document.querySelector('sx-viewport').preview = sxpvBytes
</script>
<sx-viewport theme="dark" color-mode="feature"></sx-viewport>
```

The preview shows toolpaths, so it works for every input format.

### Prepare the plate

With `tools`, the viewport is a Prepare step: a toolbar over the view with select, move, rotate, scale, arrange and drop to bed, and the keys M, R, S and A. Pass the plate, and store each transform when a move ends, so the next `plate` you pass keeps it. Then write the transforms into the project you slice.

```tsx
<Viewport
  plate={plate}
  tools
  onTransform={({ id, transform, final }) => final && setPlate((p) => withTransform(p, id, transform))}
  onSelect={(ids) => setSelected(ids)}
/>
```

`tools` also takes a list, such as `['move', 'rotate', 'arrange']`. `tool` and `selection` make the active tool and the selection yours to control. Drop to bed sets the selection down, or every object when nothing is selected. Without React: `<sx-viewport tools>`, the `transform`, `select` and `tool` events, and the `arrange()` and `dropToBed()` methods.

The plate reveal (the outline traced and the grid laid) plays on the first plate. `reveal="each-plate"` plays it for every new plate, such as each job, and `playReveal()` plays it when you ask. `bedOutline="subtle"` draws a faint hairline bed outline for a calm theme, and `look="cad"` draws parts in a neutral gray with dark edges.

### Let the user change settings

`SettingsPanel` (or `<sx-settings-panel>`) is SlicerX's settings panel, in Easy or Advanced mode. Its change event carries `overrides` keyed by OrcaSlicer setting names, which you pass straight to `slicerx_slice_file` as `overrides`.

```tsx
<SettingsPanel mode="easy" onChange={({ overrides }) => setOverrides(overrides)} />
```

### Optional: locked projects without the server

This needs a SlicerX account token. Skip it for an app that slices local files.

`@slicerx/embed/sxlock` opens and makes `.sxlock` files in any JavaScript runtime with WebCrypto (Node 20 and later, Electron, browsers):

```ts
import { openSxlock, readSxlockHeader, sealSxlock, tokenKeys, SxlockError } from '@slicerx/embed/sxlock'

const keys = tokenKeys({ supabaseUrl, anonKey, token }) // an sxk_ token with sxlock_open, sxlock_seal or both
const header = readSxlockHeader(bytes)                  // owner and key id, offline
try {
  const sx3mf = await openSxlock(bytes, keys)          // then slice it with slicerx_slice_file
} catch (e) {
  if (e instanceof SxlockError) show(e.message)         // e.code: wrong_account, offline, revoked, ...
}
```

Write the opened `.sx3mf` somewhere only your app reads (mode 0600), slice it, and delete it when you are done. Opening needs the network every time, because only the account service hands out the key.

### Theme the pieces

`EmbedTheme` takes `dark`, `light` or a theme made with `createTheme` (exported by `@slicerx/embed`), and every piece inside it takes the theme: the settings panel, the agreement, and the viewport, whose 3D scene follows the theme's accent, its light or dark scheme and its `scene` colors. `sceneTheme` on `Viewport` sets any scene or toolpath color on top. The custom elements take a `theme` attribute (`dark` or `light`) or a `theme` property (a full theme). [AGENTS.md](AGENTS.md#step-6-theming) has the color roles and worked examples.

### The pre-alpha agreement

SlicerX is pre-alpha, and an app that shows SlicerX pieces shows the agreement before their first use:

```tsx
import { Agreement, agreementNeeded, RELEASE } from '@slicerx/embed'

const [mustAgree, setMustAgree] = useState(() => agreementNeeded())
if (mustAgree) return <Agreement appName="My App" onAccept={() => setMustAgree(false)} />
```

Accepting stores `{ version, acceptedAt }` (in `localStorage` unless you pass `storage`). It shows again when SlicerX raises the agreement version. `RELEASE` has the release `stage` and the `bugReportsUrl` for your Help menu. `<sx-agreement app-name="My App">` is the same without React and fires `accept`. Send errors from `Viewport`'s `onError` (or `<sx-viewport>`'s `error` event) to your crash reporting.

## Token scopes (optional)

A local slice needs no account and no token, and neither does the viewport or the settings panel. Tokens matter only for the account features. Users create `sxk_` API tokens in their SlicerX account, and each token carries the scopes it was given. Ask the user for a token with only the scopes your app uses.

| Scope | Lets the token | Used by |
| --- | --- | --- |
| `cloud_slice` | Upload meshes and run cloud slicing jobs | `slicerx_cloud_slice`, `slicerx_cloud_jobs`, the cloud API |
| `sxlock_open` | Get the key to open the account's own locked projects | `slicerx_sxlock_open`, `openSxlock` |
| `sxlock_seal` | Lock projects for the account | `slicerx_sxlock_export`, `sealSxlock` |
| `link` | The device and delivery routes of a printer bridge | `sx-link` |

`read`, `mcp` and `cli` exist on tokens, but no integrator API checks them yet. Do not ask for them.

The MCP server reads tokens at call time, from the system keychain or the environment, never from its command line:

| Feature | Keychain item (account `slicerx`) | Environment |
| --- | --- | --- |
| Cloud slicing | `slicerx-cloud` | `SLICERX_MCP_CLOUD_TOKEN` |
| Locked projects | `slicerx-sxlock` | `SLICERX_MCP_SXLOCK_TOKEN` |

Locked projects also need the account service: `SLICERX_MCP_SUPABASE_URL` and `SLICERX_MCP_SUPABASE_ANON_KEY`, or `SLICERX_CONFIG` naming a resolved edition config. Cloud slicing needs `--cloud-api <url>`.

## Error codes

A refused call has `isError: true`, text such as `Error: no_such_plate: Benchy.3mf has no plate 3. Plates: 1, 2.`, and `structuredContent.error` with `code` and `message`. Branch on the code; show the message.

| Code | Meaning |
| --- | --- |
| `invalid_input` | An argument is wrong or missing; the message says which |
| `file_not_found` | No file at that path |
| `path_not_allowed` | The file is outside the folders the server may read (`--allow-dir`) |
| `unsupported_format` | The file type is not one the tool takes |
| `invalid_model` | The file could not be read as a model or project, for example a damaged 3MF |
| `no_such_plate` | The project has no plate with that number; the message lists the plates |
| `download_failed` | A model URL could not be downloaded or is too large |
| `urls_disabled` | The server runs with `--no-urls` |
| `unknown_profile` | No profile with that id or name |
| `invalid_settings` | An override names an unknown setting or a value out of range |
| `engine_unavailable` | No slicing engine, or the stub engine was asked for something only `sx` does |
| `slice_failed` | The engine could not slice the model; the message has its reason |
| `preflight_blocked` | The engine's safety checks refused the settings or the custom G-code |
| `project_gcode_review` | The project carries printer G-code that is not the printer's stock text; `details` has the diff and the flagged lines |
| `sequence_clearance` | The plate prints by object, and objects sit closer than the printer's extruder clearance or one that prints before another is taller than the gantry or lid clears; the message names them |
| `collision` | Paths cross on the plate or enter a keep-out zone; `details.collisions` has the objects and layers. `allow_collisions: true` slices it anyway, when the person asks |
| `not_configured` | The feature needs a cloud API or an account service the server does not have |
| `auth_failed` | No token, or the service refused it |
| `not_invited` | The account is not on the cloud's invite list |
| `quota_exceeded` | A cloud upload or daily job limit was reached |
| `rate_limited` | Too many requests; try again later |
| `service_error` | The cloud or account service failed or could not be reached |
| `internal_error` | Anything else; please report it |
| `sxlock_<reason>` | A locked project could not be opened or made: `sxlock_wrong_account`, `sxlock_offline`, `sxlock_signed_out`, `sxlock_revoked`, `sxlock_unknown_key`, `sxlock_missing_scope`, `sxlock_rate_limited`, `sxlock_banned`, `sxlock_invalid`, `sxlock_not_sxlock`, `sxlock_unsupported`, `sxlock_damaged` |

`@slicerx/embed/sxlock` throws `SxlockError` with the same reasons as `code`, without the prefix, and `SXLOCK_MESSAGES` has a plain sentence for each.

## Project G-code with the engine directly

Over MCP, `project_gcode_review` covers a project's custom G-code. An app that calls `sx slice --request` itself does the same in three steps:

- The printer maker's stock text runs as is: when the settings name the printer (`printer_settings_id`, `inherits` or `printer_model`), `sx` trusts G-code that matches the maker's text for it, unchanged.
- Other text goes to the person: `reviewProjectGcode` from `@slicerx/settings` lists each change with its diff, flagged lines and reasons. After the person says yes, send `"options": { "trustedGcode": true }`.
- Lines with `approvable: false` (such as `M502`) block even then.

See [embedding.md](../embedding.md#project-g-code) for the details and an example.

## Not supported yet

- Saving an editable project. The server writes G-code and `.gcode.3mf` files, and locks an existing `.sx3mf`, but it does not write a new `.sx3mf` from a model.
- The `.gcode.3mf` holds the plate's G-code, picture, time, weight and filaments, but no model geometry. Printers print it; Bambu Studio cannot edit it.
- `project_settings` applies the project's print settings. Settings the file sets for a single object or part, and height range settings, are not applied.
- One plate per call. To slice every plate, read the plate list with `slicerx_inspect_project` and call `slicerx_slice_file` per plate.
- PrusaSlicer `.ini` files as `profile_files`.
- 3MF and OBJ files in `<sx-viewport src>`, which reads STL. Show a slice preview instead, which works for every format.
- Progress per layer.
- The stub engine slices STL files only.

## Licenses

The SlicerX code, `@slicerx/embed` included, is Apache-2.0. `@slicerx/mcp` also bundles the stock printer and filament profile data, which is AGPL-3.0-or-later (and LGPL-3.0-or-later for the UltiMaker data), so its package license says so. If you ship that data, your users are entitled to its source. [licensing.md](../licensing.md) has the details and says how to leave the profiles out.
