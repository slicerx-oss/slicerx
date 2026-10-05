# Installing SlicerX

SlicerX is pre-alpha and has no released binaries or published packages yet. Everything on this page builds from a clone of the repository; the API for each surface is in [embedding.md](embedding.md). To ship your own product on SlicerX, see [integrating.md](integrating.md).

| Surface | Install | State |
| --- | --- | --- |
| Browser app | `pnpm dev` from a clone | Working |
| Desktop app | `pnpm dev:desktop` from a clone | In progress; runs on macOS, Windows and Linux builds not yet proven |
| `sx` CLI | `cargo build -p sx-cli --release` | Working |
| Rust crate `sx-core` | path or git dependency | Working, unpublished |
| npm package `@slicerx/slicer` | workspace package; `npm install @slicerx/slicer` once published | Working, unpublished |
| C ABI `libslicerx` | `cargo build -p sx-ffi --release` | Working, unpublished |
| Viewport `@slicerx/viewport` | workspace package | Working |
| Embeddable UI `@slicerx/embed` | workspace package | Working, unpublished |
| MCP server `@slicerx/mcp` | `pnpm --filter @slicerx/mcp build`; `npx -y @slicerx/mcp@0.1.0` once published | Working |
| Claude Code plugin | `/plugin marketplace add slicerx-oss/slicerx` | Working with a local server until the MCP package is published |
| Printer connectors | `sx-link` bridge, or built into the desktop app | In progress |
| Print watch | `sx-watch` beside the desktop app | In progress; not yet tested on a real printer |
| Remote access | self-hosted relay (`sx-relay`) | Not deployed; you host it yourself |

## Requirements

- Node 24 or newer (the repository pins it in `.nvmrc`).
- pnpm 10 (`corepack enable` picks the version in `package.json`).
- Rust 1.98.1, pinned in `rust-toolchain.toml` with clippy, rustfmt, the standard library source (the browser engine builds its own) and the `wasm32-unknown-unknown` target. Inside the clone, `rustup toolchain install` installs exactly that.
- binaryen 133 for the browser engine (`wasm-opt` on the PATH): `brew install binaryen`, or `sh scripts/install-binaryen.sh <dir>`, which prints the directory to add.
- macOS, Linux or Windows. The desktop app also needs the Tauri v2 prerequisites: the Xcode command line tools on macOS, WebView2 on Windows, WebKitGTK 4.1 on Linux.

```sh
git clone https://github.com/slicerx-oss/slicerx.git
cd slicerx
pnpm install
```

## Browser app

```sh
pnpm dev
```

Opens the browser build (`apps/web`) on http://localhost:5173: Model (Prepare in the Bambu and Orca styles), Preview, Library, Printers (with five simulated printers), mimir and the Feed from sample data. The app slices automatically after each edit (Settings, Slicing turns that off), and Print opens the Print sheet with the file, the printer and the preflight result. Slicing runs in the browser on the WebAssembly worker pool; build the module once with `pnpm --filter @slicerx/slicer build:wasm`.

`SX_FEATURES` picks the optional features at build time, as a comma list of `store`, `pilot`, `connect` and `cloud`. Unset means all of them; an empty value builds the base app only.

## Desktop app

```sh
pnpm dev:desktop
```

Runs the Tauri v2 app in `apps/desktop` with `tauri dev`. The window, native slicing and native file dialogs work; printers, the AI transport and approvals use the same TypeScript pieces as the browser for now. It has been tried on macOS only. Signed releases for macOS, Windows and Linux are planned.

## First run and printer setup

On a fresh install the browser and desktop apps open a four step setup: Welcome, Look and feel, Printer and Done. Every step can be skipped, and Escape leaves setup after asking. "Skip, use defaults" keeps the SlicerX look, adds no printer and opens the demo plate.

- Look and feel: pick SlicerX, Bambu Studio style, PrusaSlicer style or OrcaSlicer style. The choice applies at once and changes the mouse controls, shortcuts and layout, never your print settings. Adjust controls sets the theme and what each mouse button does.
- Printer: pick the brand and model (or enter the bed size by hand), the nozzle, and how SlicerX reaches the printer. Test connection reaches the printer, signs in, and reads its state and temperatures without changing anything on it. You can continue without a test; the printer is then marked Not verified. Access codes and API keys go to the system keychain only. The browser build has no keychain, so there a code is used for the test and not saved.
- mimir can help on both steps from the Ask mimir button (Ctrl+/). It suggests changes as cards that apply only when you press Apply, and it never sees or types codes.

To come back later, open Settings > Look and feel, use Add printer in Printers, or type "look and feel" in the command bar (Cmd+K). The guide for each connection type is under [Printers](#printers).

## sx CLI

```sh
cargo build -p sx-cli --release
```

The binary is `target/release/sx`. Copy it onto your `PATH` if you want to call it as `sx`.

```sh
sx slice packages/core/bench/models/x-mark.stl --config config.json -o x-mark.gcode --preview x-mark.sxpv
```

- `x-mark.stl`: the model, here the SlicerX reference model: binary or ASCII STL, or a Bambu Lab or OrcaSlicer 3MF project (`--plate N` picks the plate). OBJ is planned.
- `--config config.json`: a JSON object with OrcaSlicer setting names, such as `{"layer_height": 0.16, "wall_loops": 3, "sparse_infill_density": 20, "gcode_flavor": "klipper"}`. Missing keys keep the core's defaults, and keys the core does not implement yet are ignored. Without `--config` the defaults apply.
- `-o x-mark.gcode`: where to write the G-code. Without it, nothing is written.
- `--preview x-mark.sxpv`: the SXPV preview buffer, for the viewport.

`sx slice` writes only G-code to stdout (or to the file given with `-o`); its summary line (layers, slice time, G-code bytes, estimated print time, filament length per slot, tool changes) and warnings go to stderr. `sx slice --request req.json --out-dir out/` takes a JSON request instead and prints a result JSON (see [embedding.md](embedding.md#cli)); `sx schema request` and `sx schema result` print their JSON Schemas. Exit codes: 0 success, 1 slicing failed, 2 usage error, 3 invalid input.

`sx bench --config packages/core/bench/configs/reference-0.20.json` runs the slicing benchmark (see `packages/core/bench/README.md`).

## Rust crate

`sx-core` is not on crates.io yet. Depend on it from a clone or from git:

```toml
[dependencies]
sx-core = { path = "../slicerx/packages/core" }
# or
sx-core = { git = "https://github.com/slicerx-oss/slicerx", package = "sx-core" }
```

The crate has no file system, network or async code. Its default `parallel` feature spreads layers across threads with rayon; build with `default-features = false` for `wasm32-unknown-unknown`. [embedding.md](embedding.md#rust-crate) has an example.

## npm package

`@slicerx/slicer` (in `packages/core/web`) ships the WebAssembly build of `sx-core`, the worker that runs it, and TypeScript types. It needs a browser with Web Workers and WebAssembly; it does not need `SharedArrayBuffer` or cross-origin isolation. In the workspace:

```sh
pnpm --filter @slicerx/slicer build:wasm    # the module, pkg/sx_wasm.wasm
pnpm --filter @slicerx/slicer build         # dist/ with the worker, ready for pnpm pack
```

Once published: `npm install @slicerx/slicer`.

## C ABI

`sx-ffi` in `packages/core/ffi` builds `libslicerx` as a shared and a static library, with the header `packages/core/ffi/include/slicerx.h` generated by cbindgen:

```sh
cargo build -p sx-ffi --release
# target/release/libslicerx.{so,dylib,dll} and libslicerx.a
```

## Viewport and embeddable UI

The framework-free viewport is the workspace package `@slicerx/viewport` (`packages/ui/viewport`). Run its demo page with `pnpm --filter @slicerx/viewport dev` (port 5190).

`@slicerx/embed` wraps the viewport and the settings panel as React components and custom elements. Run its demo with `pnpm --filter @slicerx/embed dev` (port 5191). It is not yet published to npm.

## Printers

SlicerX connects to printers on your local network: Bambu Lab in LAN mode, Klipper through Moonraker, Creality, Snapmaker, PrusaLink, OctoPrint, Duet (RepRapFirmware) and the Elegoo Centauri Carbon, plus Spoolman for filament inventory and Home Assistant for plugs, lights and fans. Each guide covers what to set up on the printer and what an integrator needs to know:

- [Overview and capabilities](../packages/connect/docs/README.md)
- [Bambu Lab LAN](../packages/connect/docs/bambu-lan.md), [Moonraker](../packages/connect/docs/moonraker.md), [Creality](../packages/connect/docs/creality.md), [Snapmaker](../packages/connect/docs/snapmaker.md), [PrusaLink](../packages/connect/docs/prusalink.md), [OctoPrint](../packages/connect/docs/octoprint.md), [Duet](../packages/connect/docs/duet.md), [Elegoo](../packages/connect/docs/elegoo.md)
- [Spoolman](../packages/connect/docs/spoolman.md), [Home Assistant](../packages/connect/docs/home-assistant.md)

Each guide ends with an "Untested on hardware" section that says what has not yet been checked on a physical printer.

The browser app, the desktop app (for now) and the MCP server reach printers through `sx-link`, a small bridge that runs on your computer, binds only to 127.0.0.1 and pairs with a code it prints at startup. Build it with `cargo build -p sx-link --release`. Printer credentials go into the operating system keychain.

## MCP server

```sh
pnpm --filter @slicerx/mcp build
cargo build -p sx-cli --release    # optional; without it the server estimates from the mesh
```

Then register `node /path/to/slicerx/packages/mcp/dist/cli.js` with your MCP client. Before you connect real printers, write a permission policy (`~/.config/slicerx/mcp-policy.json`) that says which actions run, which ask you first and which are off. [packages/mcp/README.md](../packages/mcp/README.md) has the policy format and the setup for Claude Desktop, Claude Code, Cursor, other stdio clients and streamable HTTP.

Once `@slicerx/mcp` is published, `npx -y @slicerx/mcp@0.1.0` runs it without a clone. Claude Code users can install the plugin instead, which bundles the server with skills and commands: see [packages/claude-plugin](../packages/claude-plugin/README.md).

## Connect your AI agent, print watch and remote access

These three are in progress. They need the desktop app and a printer on your network.

- Connect your AI agent: Settings, mimir. One click installs the SlicerX MCP server and skills for Claude Desktop, Claude Code, ChatGPT, Codex or Cursor, and gives each its own agent code. An agent can watch, slice and queue, but only a person approves starting a print, by a tap in the app or on a paired phone.
- Print watch: `sx-watch` runs the SigLIP2 detector on your computer against the printer camera. The model file (`sx-watch-siglip2.onnx`, 177 MB) is not in git and goes beside the `sx-watch` binary. Auto-pause is off by default for each printer. On Linux the camera decoder is Cisco's OpenH264, which SlicerX downloads on first use and checks against a pinned hash. macOS uses the system decoder.
- Remote access: a self-hosted relay, not deployed. The code is in `packages/connect/relay` (see its README for the host setup and the `relay-token` function). Until you run a relay, a phone pairs only on your home network.

## Licensing for embedders

The surfaces above are Apache-2.0: you can link or bundle them into software under any license. The stock printer profiles (`packages/profiles`) are AGPL-3.0-or-later, and a build that includes them, such as the SlicerX app, is subject to the AGPL. [licensing.md](licensing.md) explains which parts use them. SlicerX ships no OrcaSlicer, Bambu Studio or PrusaSlicer code; [THIRD-PARTY.md](../THIRD-PARTY.md) lists what does ship. This is general guidance, not legal advice; see [licensing.md](licensing.md) and [NOTICE](../NOTICE).
