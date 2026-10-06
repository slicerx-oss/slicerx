<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="docs/readme-assets/banner.png">
    <img alt="SlicerX, a slicer for the gods. The AI-ready slicer, free and open source: Rust core, WebAssembly, every printer, MCP server. Two ravens, huginn and muninn, spar inside a ring of runes." src="docs/readme-assets/banner.gif" width="100%">
  </picture>
</p>

<p align="center">
  <a href="docs/licensing.md"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-bd93f9"></a>
  <a href="https://github.com/slicerx-oss/slicerx/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/slicerx-oss/slicerx/actions/workflows/ci.yml/badge.svg"></a>
  <!-- Add https://img.shields.io/npm/v/@slicerx/slicer and https://img.shields.io/crates/v/sx-core once the packages are published. -->
</p>

<h3 align="center">A Rust-based open source slicer for builders and makers.</h3>
<p align="center"><b>The AI-ready slicer</b></p>

SlicerX is a free, fully open source slicer for FFF 3D printers, built to be driven by other software as much as by people. An AI assistant can plan settings, slice, and send a job to a printer through its MCP server, under a permission policy the user controls. A web page can slice in the browser with the WebAssembly core, and a print farm tool can call the CLI or link the Rust crate. The slicing core is written in Rust, compiles to native code and WebAssembly, and uses the setting names OrcaSlicer, Bambu Studio and PrusaSlicer share, so existing profiles carry over. It contains no code from those projects. The base kit is Apache-2.0, so you can build it into your own product, open or closed, as long as you keep the "Made possible by SlicerX" credit.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/readme-assets/slicerx-title-clear.png">
    <img alt="The SlicerX wordmark, with the X built up from printed layers" src="docs/readme-assets/slicerx-title.gif" width="560">
  </picture>
</p>

> [!NOTE]
> SlicerX is pre-alpha. The engine continues work its author began in 2021; this app and repository started in September 2026, and several surfaces below are still being built. [Project status](#project-status) says what runs today.

## The base kit

Everything below is the base kit, under Apache-2.0: what you need to slice, set up and drive printers from your own software.

| Surface | What you get | State |
| --- | --- | --- |
| [MCP server](packages/mcp/README.md) `@slicerx/mcp` | mimir's tools for any MCP client: slice, estimate, plan and check settings, orient, cut, split, repair, hollow, emboss, calibration models, resume plan, arrange, queue, printer control, knowledge base and docs as resources | `npx @slicerx/mcp` |
| [npm package](docs/embedding.md#npm-package) `@slicerx/slicer` | The WebAssembly core in a Web Worker pool, for slicing in the browser | `npm install @slicerx/slicer` |
| [CLI](docs/embedding.md#cli) `sx` | Model and settings in, G-code and a preview buffer out, as a separate process | [Engine release](https://github.com/slicerx-oss/slicerx/releases) (with `sx-geom` and `sx-link`) |
| [Rust crate](docs/embedding.md#rust-crate) `sx-core` | The slicing core as a library, with no file system, network or async runtime inside | `cargo add sx-core` |
| [C ABI](docs/embedding.md#c-abi) `libslicerx` | JSON in, G-code and preview bytes out, for C, C++, Swift, C# or Go | [Engine release](https://github.com/slicerx-oss/slicerx/releases) (library and header) |
| [Viewport and UI parts](docs/embedding.md#viewport) | The three.js plate and toolpath viewport, and the settings panel as React components or custom elements | `npm install @slicerx/viewport` or `@slicerx/embed` |
| [Theming](docs/embedding.md#theming-and-branding) | Your colors, fonts, gradient, logo, icons, and the 3D viewport's scene colors | Working |
| [Printer connectors](packages/connect/docs/README.md) | Bambu Lab LAN, Klipper through Moonraker, Creality, Snapmaker, PrusaLink, OctoPrint, Duet, Elegoo, plus Spoolman and Home Assistant | In progress |

Settings everywhere use the shared slicer key names, so existing profiles and knowledge carry over. To ship a full product of your own on top of the base kit (your brand, features, printers and AI provider, set in one configuration file), start with the [integrator quickstart](docs/quickstart.md), then [docs/integrating.md](docs/integrating.md).

## mimir and the MCP server

mimir is the assistant built into SlicerX. It plans jobs (printers, plates, settings, slicing, the queue) and cites the knowledge base for every setting it changes. It runs on the model you choose: your ChatGPT plan, an OpenAI or Anthropic key, or a local model through Ollama, LM Studio and similar. Keys stay in your system keychain.

The MCP server gives other AI tools the same tools under your rules. Reading is always allowed. Changing a project, queueing, heating or moving a printer, and spending money follow a policy you set (Allow, Ask first or Off), and each approval is signed, single-use and logged.

```sh
claude mcp add slicerx -- npx -y @slicerx/mcp --allow-dir ~/prints
```

Other clients, the policy file and the tool list are in [packages/mcp/README.md](packages/mcp/README.md). Claude Code users can also install the [SlicerX plugin](packages/claude-plugin/README.md) with `/plugin marketplace add slicerx-oss/slicerx`.

## Features

### The gods

Each name marks something SlicerX does its own way, or better than the slicers it learned from.

| | |
|---|---|
| **mimir** | The assistant. It answers questions, reads your printer's camera, and suggests fixes you approve. |
| **huginn and muninn** | mimir's two model tiers: huginn takes a quick look, muninn thinks deep. mimir picks per job. |
| **aegis** | Variable-width walls, the default. Thin features print solid, with far fewer width changes than Arachne. |
| **sleipnir** | Adaptive layer height: thin layers on curves and slopes, thick on straight walls. |
| **atlas** | A prime tower that places and sizes itself. |
| **norn** | Edit from Preview: click a toolpath, change the setting behind it, and see before and after. |
| **heimdall** | Preview playback that runs the print as the machine will, tool changes and all. |

### Working today

- A native Rust slicing core (`sx-core`): Arachne, classic and aegis walls, the common infill patterns, tree and normal supports, brim, raft, seams, fuzzy skin and multi-material. It writes G-code for Marlin 2, Klipper and RepRapFirmware, and reads STL, OBJ, AMF and Bambu Lab or OrcaSlicer 3MF projects. The 508-layer reference plate slices in 17.1 ms (median of 15 runs on an 11-core Apple M3 Pro).
- The same core in the browser through WebAssembly, with G-code identical to the native build.
- The `sx` command line tool, and a C ABI (`libslicerx` and `slicerx.h`).
- More than 700 settings with units, limits and help text, profile import, validation, and an Easy mode. Printer, filament and process presets ship with the app.
- The MCP server with mimir's tools, the sx-geom mesh tools, and a permission policy with approvals and an action log.
- The browser and desktop app: Prepare, Preview, Library, Printers and mimir, with calibration by need and the Print sheet, where your click is the approval.
- CAD tools: STEP import, sketches with typed sizes, push and pull, fillet and chamfer, dimensions that stay on the model, and an editable history.
- A print knowledge base with cited sources.

In progress, working in tests and not yet proven on real hardware:

- Print watch: a local detector (SigLIP2 plus frame-change signals, run on your machine) looks at the printer camera during a print. Three suspicious frames out of five send a push with no image content. Auto-pause is off by default per printer and needs mimir's confirmation of one frame. Ask mimir "how is my print going?" for a fresh capture and its reading. The model file ships beside the `sx-watch` binary.
- Connect your AI agent: Settings, mimir, with one-click setup of the SlicerX MCP server and skills for Claude Desktop, Claude Code, ChatGPT, Codex and Cursor, each with its own agent code. An agent can watch, slice and queue. Only a person starts a print.
- Remote access: a self-hosted relay, not deployed. The code and the phone pairing (QR code, no account needed) exist and are tested against mock printers. Nothing runs on a public server today, and you would host the relay yourself. The relay carries sealed bytes (WebRTC between your phone and your computer, with a 1 fps fallback).
- Printer connectors against real hardware, and the desktop app (runs on macOS; Windows and Linux builds are set up in CI and not yet proven). Printer setup guides for each supported printer are in [packages/connect/docs](packages/connect/docs/README.md).

Planned: a free, moderated model library that anyone can upload to, with creator pages that link out to their own sites, published npm and crates.io packages, mobile apps and hosted cloud slicing.

## Quick start

You need Node 24 or newer, pnpm 10 and Rust 1.98.1. In a fresh clone:

```sh
pnpm install
cargo build -p sx-cli --release
```

Slice from the command line:

```sh
target/release/sx slice packages/core/bench/models/x-mark.stl --config config.json -o x-mark.gcode
```

`config.json` holds OrcaSlicer keys, for example `{"layer_height": 0.2, "wall_loops": 3, "sparse_infill_density": 20}`.

Run the browser app on http://localhost:5173:

```sh
pnpm dev
```

The browser app slices on the WebAssembly worker pool. [docs/install.md](docs/install.md) covers every surface, including the Rust crate, the npm package and the desktop app, and links the printer setup guides.

## How it fits together

```mermaid
flowchart LR
  subgraph Clients["Your software"]
    AI["AI assistants<br/>(MCP)"]
    Web["Web pages<br/>(npm)"]
    Native["Native apps<br/>(crate, C ABI)"]
    Scripts["Scripts and farms<br/>(CLI)"]
  end
  subgraph SlicerX
    Pilot["mimir tools<br/>permission policy, approvals"]
    Core["Slicing core<br/>Rust, native and WebAssembly"]
    Settings["Settings and profiles<br/>OrcaSlicer keys"]
    KB["Knowledge base"]
    Connect["Printer connectors"]
    UI["App, viewport, UI parts<br/>themeable"]
  end
  Printers["Printers on your network"]

  AI --> Pilot
  Web --> Core
  Web --> UI
  Native --> Core
  Scripts --> Core
  Pilot --> Core
  Pilot --> Settings
  Pilot --> KB
  Pilot --> Connect
  UI --> Core
  UI --> Pilot
  Core --> Settings
  Connect --> Printers
```

The core takes bytes and returns bytes, which is why the same code runs natively, in WebAssembly and behind every surface above. Printer traffic stays on your network: connectors talk to printers directly, and credentials stay in the operating system keychain.

## For people who print

The SlicerX app, working in the browser and running on macOS as a desktop app so far, is built from the same base kit: Prepare, Preview, Library, Printers and mimir in one window with a command bar. It slices as you edit, sends a print through the Print sheet, picks calibration tests by what your spool and printer need, and can watch a print through the printer camera (in progress). The SlicerX edition, layered on top of the base kit, holds the code for accounts, cloud slicing and the free model library with creator pages. None of those services is hosted yet. All of it is open source and free to use. The base kit builds and runs without the edition.

## Project status

| Surface | State |
| --- | --- |
| Slicing core and `sx` CLI | Working: STL and 3MF, classic, Arachne and aegis walls, infill, supports, shells, brim, raft, seams, multi-material, G-code, preview buffer, JSON requests |
| WebAssembly worker pool | Working in Chrome; npm package not yet published |
| C ABI | Working; not yet published |
| Settings, profiles and knowledge base | Working |
| MCP server and Claude Code plugin | Working with simulated printers; real printers through `sx-link` as the connectors land |
| Browser app, viewport and embeddable UI | Working |
| Printer connectors | In progress; tested against mock printers, not yet on hardware |
| Print watch | In progress; detector and push built, not yet tested on a real printer |
| Connect your AI agent | In progress; install mechanics and panel built |
| Remote access | Self-hosted relay, not deployed; phone pairing built |
| Phone app | In progress |
| Desktop app | In progress; runs on macOS, Windows and Linux builds not yet proven |
| Theming | UI and viewport theming working |
| Open `.sx3mf` container format | Working |

<p align="center">
  <a href="docs/integrators/credit-kit">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset="docs/integrators/credit-kit/badges/made-possible-by-slicerx-medium-light.svg">
      <img alt="Made possible by SlicerX" src="docs/integrators/credit-kit/badges/made-possible-by-slicerx-medium-dark.svg" height="40">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://github.com/sponsors/Subydev"><img alt="Sponsor on GitHub" src="https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=githubsponsors&logoColor=white&style=for-the-badge"></a>
  <a href="https://buymeacoffee.com/xccyf47w7r"><img alt="Buy me a coffee" src="https://img.shields.io/badge/Buy_me_a_coffee-ffdd00?logo=buymeacoffee&logoColor=black&style=for-the-badge"></a>
</p>
