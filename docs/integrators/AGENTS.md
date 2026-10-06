# SlicerX integrator kit: instructions for coding agents

## Start here

When the ask is vague ("make me a slicer in my app"), ask which of these they mean before you write anything:

- A: their own branded slicer app, which their app opens with a model file. It is an edition (Path A). The license difference: the edition is AGPL as a whole, so they publish its source.
- B: slicing built into the app they already have (Path B). It embeds the viewport and runs `slicerx-mcp` next to the app. The license difference: the viewport and embed packages are Apache-2.0 and can stay closed, but `slicerx-mcp` runs as its own process and its source is offered.

If they don't know, recommend A for a desktop app that wants the full slicer, and B when all they need is a preview and a slice button. Then follow that path's interview.

You are a coding agent helping a developer build SlicerX into their app. This file is your starting point. Read it top to bottom before you write code, then follow the steps in order. It works the same for any agent; nothing here depends on one vendor.

SlicerX is a 3D printing slicer. There are three ways to put it in a product:

- Make your own edition (white-label): build the whole SlicerX app under the integrator's own name, logo and colors from one configuration file. This is the main path when the product is a slicer, and it needs no SlicerX account. The result is a separate app with its own installer; another app of theirs can launch it with a file, but it does not run inside that app's window. See "Path A" below.
- Embed and drive pieces: add SlicerX parts to an app that already exists. Steps 1 to 6 cover it. Most of the two bullets that follow belong to this path.
- Hand files to an installed SlicerX: open a model in a copy of the SlicerX app the user installed. See "Path C" below.

The embed path works in two ways, and most apps use both:

- Drive it: the app starts the SlicerX MCP server (`@slicerx/mcp`) as a child process and calls its tools to slice models, read projects and list profiles. No window is needed.
- Build it in: `@slicerx/embed` gives the app the SlicerX 3D viewport, the print settings panel and the pre-alpha agreement as React components or custom elements.

The default path is local. Everything runs on the user's machine from the app's own files: the viewport, the MCP server and the `sx` engine need no SlicerX account, no token and no network. Build that first. Cloud slicing and locked projects (`.sxlock`) are optional and covered only in the last section; do not bring them up unless the user does.

The other files in this folder:

- [quickstart.md](quickstart.md): the reference for every tool, option, result field and error code.
- [llms.txt](llms.txt): an index of these files for tools that read `llms.txt`.

The same files ship inside the npm packages, at `node_modules/@slicerx/mcp/AGENTS.md` and `node_modules/@slicerx/embed/AGENTS.md`, with the quickstart folded into `llms-full.txt` next to them.

## Status: pre-alpha

SlicerX is pre-alpha. Tell the user this once, early, in plain words:

- Expect bugs and breaking changes between versions. Pin exact versions.
- An app that shows SlicerX parts to its users must show the pre-alpha agreement first (step 5 covers it).
- Bugs in SlicerX go to the bug-reports channel of the SlicerX Discord: https://discord.com/channels/1555048815881355324/1556010155802628228

## Rules that never change

Follow these whatever the user asks. If a request conflicts with one, say so and do not write the code.

1. An AI client never approves a print start, a resume, a raw G-code line or a printer adjustment (temperature, filament load). Those need a person to approve them in SlicerX or on a paired phone. Never call `slicerx_approve` to approve anything on the user's behalf, and never write app code that auto-approves. The server refuses it anyway, and a policy file cannot loosen it.
2. Never put an `sxk_` token (only the optional cloud features use them), a printer access code or any other secret in source code, a config file, a command line or a log. Tokens go in the system keychain or in environment variables the user sets.
3. Give the server only the folders the user picked (`--allow-dir`). Never pass the home folder or `/`.
4. Keep the "Made possible by SlicerX" credit (with a link to https://slicerx.app/support) wherever the product shows third-party credits, such as an About screen, and in its docs. An app with no such place ships the line in a NOTICE or credits file. Keep the `NOTICE` and `LICENSE-APACHE` files too.
5. Never call the product SlicerX and never use the SlicerX logo as its own. Printer maker names and logos belong to their owners.

## What you must do

This is what the files in this repository say, not legal advice. `NOTICE`, `docs/licensing.md` and `REUSE.toml` have the full terms.

1. Keep the credit. Show "Made possible by SlicerX", linked to https://slicerx.app/support, on your About screen and in your docs. An edition config shows it for you and cannot drop it. Ready-made badges, a Support SlicerX button, copy and screenshots are in `credit-kit/` (see its README).
2. Path A, your own edition. The bundled printer profiles, printer pictures and Bambu certificates are AGPL-3.0-or-later, so an edition that ships them is an AGPL combined work as a whole. Publish its source (your fork: the SlicerX repository plus your config and brand files) and set `legal.sourceUrl` to it. Another app of yours, such as LayerMate, stays your own when it only launches the edition as a separate program and links none of its code.
3. Path B, embedding. `@slicerx/viewport` and `@slicerx/embed` are Apache-2.0 and can go into closed code. `@slicerx/mcp` carries AGPL profile data, so run it as its own process (the `slicerx-mcp` server) and offer its source. Do not bundle it into closed code.
4. Names. Use your own product name and logo. "SlicerX", its logo and the Nocturne artwork are trademarks (TRADEMARK.md).

## Choose a path

Ask which one fits, with a default: they want their own slicer app, so Path A. If they only add a viewport, slicing or settings to an app they already have, use Path B (steps 1 to 6). If they only want to open files in the SlicerX app the user installed, use Path C. Say which you chose and why in one line.

Settle this before anything else when the user asks for "the slicer inside my app": Path A builds a separate app that their app launches (with a file path as the argument, as in Path C), and it cannot be put inside another app's window. Path B is the only way to show SlicerX parts inside their own window, and it gives the viewport, the settings panel and slicing, not the whole slicer. Tell the user both in two lines and let them choose.

## Path A: make your own edition

An edition is the SlicerX app rebuilt as the integrator's product: a separate desktop app (and optionally a browser build) with its own name, installer and identifier. Their own app launches it; it does not run inside their app. They write one configuration file and build the apps from it; they do not edit SlicerX code for the name, colors or identifiers. `docs/integrating.md` in the clone is the long guide; the schema is `packages/edition-config/schema/edition-config.schema.json`.

Path A needs a clone of the SlicerX repository, not the kit's `.tgz` files. Ask the user for the path of their clone (a fork), or have them make one:

```sh
git clone https://github.com/slicerx-oss/slicerx.git my-slicer
cd my-slicer
git remote rename origin upstream   # SlicerX releases come from here (step 7)
git remote add origin <their own repository URL>
```

Check `git remote -v` shows `upstream`. Run every command below from the root of the clone.

A local-only product needs no account, no cloud and no backend. Leave those features off and the app never asks for a sign-in.

Prerequisites. Check each one and tell the user what is missing before you build:

- Rust: the toolchain pinned in `rust-toolchain.toml`, with the `wasm32-unknown-unknown` target and the standard library source. Inside the clone, `rustup toolchain install` installs exactly that.
- Node 24 or later.
- pnpm 10. The clone pins the exact version in `package.json` (`packageManager`), so run `pnpm` inside the clone. Outside it, corepack may fetch a different pnpm; ignore that version.
- The platform's Tauri dependencies (`docs/install.md`, `apps/desktop/README.md`).
- `wasm-opt` from binaryen 133, which shrinks the WebAssembly engine. Install it with `sh scripts/install-binaryen.sh <dir>`, which checks the download's SHA-256 and prints the folder to add to `PATH`. Without it, `SX_WASM_OPT=0` builds the engine unshrunk: it works for a trial build, but the module is larger and can fail the browser build's 1024 KB download budget (one test build came to 1071 KB gzip). Ship builds made with `wasm-opt`.

1. Make the edition folder and the config. Add `editions/<id>/edition.config.ts`, starting from the example below (SlicerX's own `editions/slicerx/edition.config.ts` is the same shape, but the checker refuses its name, logo and `app.slicerx.*` identifiers in any other edition). Put the brand artwork next to it in `editions/<id>/brand/`.

```ts
import { defineEditionConfig } from '../../packages/edition-config/src/index.ts'

export default defineEditionConfig({
  id: 'acmelayer',
  brand: {
    name: 'Acme Layer',
    shortName: 'Acme',
    tagline: 'Slicing for your Acme library',
    logo: { mark: 'brand/acme-mark.svg', appIcon: 'brand/acme-icon.png' },
    theme: { base: 'nocturne', tokens: { colors: { purple: '#e8590c' }, fonts: { display: 'Inter' } } },
  },
  apps: {
    desktop: { identifier: 'com.acme.layer', productName: 'Acme Layer' },
    deepLinkScheme: 'acmelayer',
  },
  backend: { supabase: null, cloudApi: null, relay: null },
  features: { store: false, feed: false, creators: false, cloudSlicing: false, phonePairing: false, pilot: false },
  ai: { provider: 'none' },
  release: { stage: 'pre-alpha', bugReportsUrl: 'https://acme.example/support' },
  legal: {
    sourceUrl: 'https://git.acme.example/layer/tree/{commit}',
    attribution: { text: 'Made possible by SlicerX', url: 'https://slicerx.app/support' },
    license: 'Apache-2.0; stock printer profiles AGPL-3.0-or-later',
    trademarkNotice: 'Acme Layer is built on SlicerX. SlicerX is a trademark of its owners and is not affiliated with Acme.',
  },
})
```

   What each part does:
   - `brand`: the name shown in title bars and About, and the theme. Colors and fonts go in `theme.tokens`; the color roles are the ones in step 6. Keep `#rrggbb` for colors the 3D scene uses.
   - `apps.desktop`: the product name and the reverse-DNS identifier (`com.acme.layer`, never `app.slicerx.*`). `deepLinkScheme` is the custom URL scheme the app registers.
   - `backend` null and the `features` off: no accounts, no model library or feed, no cloud slicing, no phone pairing. The sign-in screens belong to the library feature, so with `store` off they never show. `pilot: false` removes the AI assistant, and the checker lets `ai.provider` be `'none'` only when it is off.
   - `legal.sourceUrl`: always set it, even for a local-only app. The app ships the AGPL stock profiles, About links to the source of the build, and without this field it links to SlicerX's repository instead of the integrator's. `{commit}` is replaced with the build's commit.
   - `legal.attribution`: leave it out. About then shows "Made possible by SlicerX", linked to https://slicerx.app/support. The check accepts only that text and link, so the credit cannot be removed or reworded.
   - `release.bugReportsUrl`: where the integrator's users report bugs. Without it, and without a backend of its own, Report a bug and crash reports are off; an edition never links to the SlicerX Discord. `bugs.upstream` (default false, leave it off unless the user asks) also copies crash reports, and only those, to SlicerX with the edition id in the title.
   - `release.stage`: `pre-alpha`, `alpha`, `beta` or `stable`. `pre-alpha` makes the first-run agreement required and locks the crash report setting on (reports upload only to the edition's own backend, so a local-only edition uploads none). The other stages do neither. SlicerX itself is pre-alpha, so use `pre-alpha` until the integrator has tested their build and decides otherwise; do not pick `stable` on your own.
   - Logos: `brand.logo.mark` (and `wordmark`) may be SVG or PNG, as files next to the config. `brand.logo.appIcon` is the square source for the app icons: a PNG of 1024 by 1024 px, or an SVG. A logo up to 8 KB is inlined in the build; a bigger one ships as a file.
   - Fonts: `theme.tokens.fonts` takes family names (`display`, `body`, `mono`). The base ships Hanken Grotesk, Inter, IBM Plex Sans, IBM Plex Mono, JetBrains Mono and Unbounded; any other family needs its files in `theme.tokens.fontFiles` (name the family as the user does, with spaces if they use them, not as the file is named), one entry per file, next to the config. The build bundles them, so they load with no network. Every family gets a sans-serif (or monospace) fallback, and `check` warns about a family nothing ships:

```ts
theme: {
  base: 'nocturne',
  tokens: {
    colors: { purple: '#e8590c' },
    fonts: { display: 'Sora', body: 'Manrope' },
    fontFiles: [
      { family: 'Sora', src: 'fonts/Sora-Variable.woff2', weight: '100 800' },
      { family: 'Manrope', src: 'fonts/Manrope-Variable.woff2', weight: '200 800' },
    ],
  },
},
```

     Ask the user for the font files (woff2 is best; woff, ttf and otf work) and check that the font's license allows bundling it in an app. Open fonts such as the SIL Open Font License ones from Google Fonts do.
   - The assistant (mimir) with a local model: set `features.pilot: true`, `ai.provider: 'openai-compatible'` and `ai.baseUrl: 'http://127.0.0.1:11434/v1'` (Ollama's address; LM Studio's is `http://127.0.0.1:1234/v1`). For a server on another computer (llama.cpp, LocalAI, vLLM, Ollama) use its home-network address, such as `http://192.168.1.50:8080/v1`; a server that needs a key gets it in Settings > mimir, where it is kept in the keychain, never in the edition config. Do not guess a model name. In the built app, Settings > mimir > Set up local AI checks the computer, recommends a model, downloads it with the user's confirmation, tests it and switches mimir to it.
2. Check it: `node packages/edition-config/src/cli.ts check editions/<id>/edition.config.ts`. A mistake names the field and the reason. Fix every one.
3. Build it. From the root of the clone, with the prerequisites above:

```sh
pnpm install --frozen-lockfile
pnpm edition:build editions/<id>/edition.config.ts --target desktop
```

   `--target web` builds the browser app into `apps/web/dist` instead. `edition:build` checks the config, builds the WebAssembly engine, then builds the app, and passes the config file to every step itself, so no environment variable has to be set first. `--skip-wasm` reuses an engine already built; `--dry-run` prints the steps. Set `SX_WASM_OPT=0` in front of it only for a trial build without `wasm-opt`.

   For the desktop target it writes the product name, window title, publisher, copyright, description, file type names, identifier and deep link scheme from the config to `apps/desktop/src-tauri/gen/edition.conf.json`, and makes the app icons from `brand.logo.appIcon` in `apps/desktop/src-tauri/gen/icons`, then runs `tauri build` with that file. The Vite build reads the same config for the name, theme, fonts and feature switches. The `.github/workflows/desktop-release.yml` workflow is the full recipe for the macOS (universal dmg), Windows (x64 NSIS and MSI) and Linux (AppImage and deb) installers, including the WebAssembly and CAD module builds and `apps/desktop/release/prepare-sidecars.mjs`. Copy it into the fork and set `SLICERX_CONFIG` to the config path there.
4. The engine comes with the app. The desktop app has the `sx-core` slicer compiled in and slices on every core natively; there is no separate `sx` binary to bundle. The release script bundles the MCP server into the app as `mcp/slicerx-mcp.mjs` (a resource, run with Node) and the print watch only when a model file is supplied. The browser build (`apps/web`) slices in WebAssembly. The Cargo features `store`, `pilot`, `connect` and `cloud` of `slicerx-desktop` gate the optional crates (`apps/desktop/README.md`).
5. Sign it with the integrator's own certificates. The workflow reads `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` for macOS signing and notarization, and `WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD` for Windows. They are repository secrets, and signing is skipped when they are absent. `apps/desktop/release/windows-sign.md` and `macos-sign.sh` document the rest. Never put certificates or passwords in the config or the repository. The updater is off, so users get a new version by installing it.
6. Hand files to it from the integrator's own app: launch the installed edition's executable with the model's path as the argument. A second launch hands the file to the running app. Path C has the details and what has not been tried on an installed copy yet. Wire this as soon as the config passes `check`, before the long desktop build, so a failed or slow build never leaves it undone: make the host app's "open in slicer" command a setting with a sensible default per OS (on macOS `open -a "<productName>" <model>`; on Windows and Linux the installed executable, whose exact path you fill in from the build output), and note in your summary which default still needs the real path.
7. Update by pulling new SlicerX releases. Fetch the `upstream` remote, merge or rebase its release tags into the fork, re-run `check`, and rebuild. The integrator's changes live in `editions/<id>/` and the release workflow, so merges stay small.

### What a config rebrands, and what it leaves

The config sets the window title, the installer's publisher, copyright and description, the file type names ("Acme Layer 3MF file", "Locked Acme Layer project"), the app icons (made from `brand.logo.appIcon` at build), the app bar logo and About mark (`brand.logo.mark` or `wordmark`), the menus, the text in the app, the Help and download links (`links`), the "Open in" link scheme, and the MCP server name AI clients list. Tell the user what stays:

- `.sx3mf` and `.sxlock` are SlicerX's file formats and keep their extensions everywhere.
- About always shows "Made possible by SlicerX", linked to https://slicerx.app/support. An edition can restyle it in CSS but not reword, relink or remove it.
- A few messages from base kit packages still name SlicerX: printer catalog notes in the setup's model list, the preset import report and some printer bridge errors.

### Obligations when white-labeling

This is a summary of the files in the repository, not legal advice. Read `NOTICE`, `docs/licensing.md` and `REUSE.toml`, and have a lawyer read them for a commercial product.

- Anyone may fork, rebrand and sell an edition. The SlicerX code is Apache-2.0. Keep `LICENSE-APACHE` and `NOTICE`, keep each file's license header, and mark files you change, as Apache-2.0 section 4 asks.
- Credit: a small "Made possible by SlicerX" line with a link to https://slicerx.app/support in the About screen and in the product's docs. It does not belong in the main UI.
- Name and logo: "SlicerX", its logo and the Nocturne artwork are trademarks of the SlicerX project. The product must have its own name and logo. The config checker refuses the SlicerX name, the built-in SlicerX logo and `app.slicerx.*` identifiers in any edition whose id is not `slicerx`. Saying "built on SlicerX" is allowed. [TRADEMARK.md](../../TRADEMARK.md) has the rules.
- AGPL parts: `REUSE.toml` lists these as AGPL-3.0-or-later: the stock printer, filament and process profiles in `packages/profiles` (from OrcaSlicer and Bambu Studio), the printer pictures in `packages/profiles/printer-images`, and Bambu Lab's printer certificate authorities in `packages/connect/certs/bambu-ca.pem`. `NOTICE` and `docs/licensing.md` say that the app ships the profiles and that the app as distributed is therefore covered by the AGPL as a whole, and that a hosted build must offer its source (section 13). `legal.sourceUrl` is where the app links to the source of the exact build. Report this to the user as what those files say, and tell them to get legal advice before shipping commercially.
- Other licenses: the UltiMaker profiles in `packages/profiles/cura` are LGPL-3.0-or-later, and the STEP reader (Open CASCADE) is LGPL-2.1 with a source offer. Ship the license texts: the release build generates `THIRD_PARTY_LICENSES`, and `THIRD-PARTY.md` lists what is in it.
- Printer maker names and logos belong to their owners and are used only to identify printers.

## Path B: embed and drive pieces

Steps 1 to 6 are for an app that adds SlicerX parts to itself. If the user chose Path A or C, skip to "Before you finish" and use the checks that apply.

Two things come first. Install `@slicerx/mcp` (step 1), then register it as one of your own tools (step 2). Probing it with the SDK is not enough: until the client lists its tools, you cannot slice, check profiles or test printers yourself while you build.

## Step 1: get the packages

Install from npm, pinned to the exact version:

```sh
npm install @slicerx/mcp@0.1.0
npm install @slicerx/embed@0.1.0 react@19 react-dom@19 three@0.186   # for any UI part
```

Install only what the plan needs: `@slicerx/mcp` for slicing and profiles, `@slicerx/embed` (which brings `@slicerx/viewport`) for any UI part. `@slicerx/embed` and `@slicerx/viewport` take React 19 and three.js 0.186 as peer dependencies, so install them in the app. With pnpm, use `pnpm add` with the same names.

When the user wants a SlicerX build that is not released yet, they can pack the same packages from a clone instead: `cd /path/to/slicerx && pnpm install && node scripts/pack-integrator-kit.mjs /path/to/kit`, then install the `.tgz` files it lists (the script prints the exact `npm install` line).

Licenses, as `docs/licensing.md` states them: `@slicerx/embed`, `@slicerx/viewport` and `@slicerx/slicer` contain no profile data and are Apache-2.0. `@slicerx/mcp` bundles the stock profiles and is `Apache-2.0 AND AGPL-3.0-or-later AND LGPL-3.0-or-later`. Tell the user this when the plan uses `@slicerx/mcp`, and that it is not legal advice.

Slicing for real needs the `sx` engine binary, which the app ships next to itself. Download it from the latest engine release (https://github.com/slicerx-oss/slicerx/releases, tags `engine-v*`): the archive for the platform (`slicerx-engine-<version>-macos-universal.tar.gz`, `-linux-x64.tar.gz` or `-windows-x64.zip`) has it in `bin/`, and `SHA256SUMS.txt` has the checksums to verify. The binaries are not signed yet; on macOS run `xattr -d com.apple.quarantine bin/*` after a browser download. A clone builds it with `cargo build -p sx-cli --release` (`target/release/sx`, or `sx.exe` on Windows). Ask the user where theirs is. It runs locally and needs no account. Without it the server falls back to a stub that only estimates STL files.

The server needs Node 24 or later. Check with `node --version`.

## Step 2: connect the SlicerX MCP server to yourself

Do this right after step 1, before the interview, without asking: it changes nothing outside the project. Register the server as your own tool with your client's add command, for example `claude mcp add --scope project slicerx -- node node_modules/@slicerx/mcp/dist/cli.js --allow-dir /abs/models --printers off`, run through the shell. Prefer the add command over writing `.mcp.json` yourself: some clients treat that file as protected and stop to ask. Then confirm the client lists the `slicerx_*` tools; if it needs a restart to load them, say so and carry on with the command-line check below. With the server connected you can list real profile ids, try a slice and build a theme with a contrast check. It is separate from the server the app starts at run time (step 4).

Register it at project scope (a config file in the project, such as `.mcp.json`, `.cursor/mcp.json` or `.vscode/mcp.json`), never in the user's global settings unless they ask. When your client has a command for it (`claude mcp add`, `codex mcp add`), run the command instead of writing the file: clients often protect their own config files from direct edits. Most clients load a new server only in the next session; register it now, run the command-line check below, and use the tools once they appear.

The server command is the same for every client. After step 1 it is installed in the project:

```sh
node node_modules/@slicerx/mcp/dist/cli.js --allow-dir /absolute/path/to/test/models --printers off
```

This step runs before the interview, so install only `@slicerx/mcp` now: in the app folder, run `npm init -y` when there is no `package.json`, then `npm install @slicerx/mcp@0.1.0`, and make an empty `data/models` folder to allow. The interview then adds what the plan needs. Do not skip this because no plan exists yet.

Add `--sx-bin /absolute/path/to/sx` when the user has the engine. Use absolute paths in client configs. Outside a project, `npx -y @slicerx/mcp@0.1.0` runs the same server as `node node_modules/@slicerx/mcp/dist/cli.js`.

Install it in the client you are running in:

| Client | How |
| --- | --- |
| Claude Code | `claude mcp add --scope project slicerx -- node /abs/app/node_modules/@slicerx/mcp/dist/cli.js --allow-dir /abs/models --printers off` writes `.mcp.json` in the project. The tools appear in the next session. |
| Claude Desktop | Settings, Developer, Edit Config. Add the server under `mcpServers` in `claude_desktop_config.json` (the JSON below), then restart Claude Desktop. |
| Cursor | The same `mcpServers` JSON in `.cursor/mcp.json` (this project) or `~/.cursor/mcp.json` (all projects). |
| VS Code | `.vscode/mcp.json` with `{ "servers": { "slicerx": { "type": "stdio", "command": "node", "args": [...] } } }`, or run MCP: Add Server from the command palette. |
| Codex CLI | `codex mcp add slicerx -- node /abs/app/node_modules/@slicerx/mcp/dist/cli.js --allow-dir /abs/models --printers off`, or a `[mcp_servers.slicerx]` table with `command` and `args` in `~/.codex/config.toml`. |
| ChatGPT, Grok and other hosted assistants | They reach MCP servers only by an HTTPS URL, so a server on the user's machine needs a tunnel or reverse proxy the user controls. Run it with `--http`, set `SLICERX_MCP_TOKEN` in the environment and pass `--allowed-host <public name>`. Then add the URL in the assistant's connector or MCP settings. Keep printers `off` on any server reachable from outside. |
| Any other stdio client | Run the command above. |
| Any other HTTP client | `node node_modules/@slicerx/mcp/dist/cli.js --http --port 3977 --allow-dir /abs/models --printers off`. The endpoint is `http://127.0.0.1:3977/mcp`. Every request needs `Authorization: Bearer <token>`; the token is written to `~/.config/slicerx/mcp-http-token` at each launch, or fixed with `SLICERX_MCP_TOKEN`. |

The `mcpServers` JSON for Claude Desktop and Cursor:

```json
{
  "mcpServers": {
    "slicerx": {
      "command": "node",
      "args": ["/abs/app/node_modules/@slicerx/mcp/dist/cli.js", "--allow-dir", "/abs/models", "--printers", "off"]
    }
  }
}
```

Check the connection before you go on:

0. Confirm your client lists the `slicerx_*` tools (in Claude Code, `claude mcp list` shows `slicerx` as connected). A server that only your own code reached through the SDK does not count as registered.
1. Run `node node_modules/@slicerx/mcp/dist/cli.js --version`. It prints `0.1.0`. Always run this one, even when the tools are not loaded yet.
2. Call `slicerx_estimate_file` with `{ "model": "sample:cube-20" }`. A working server returns `time_s` above 0 and `layer_count` above 0. `engine: "stub"` means the server did not find `sx`; that is fine for development but not for slicing that people print.
3. Call `slicerx_list_profiles` with `{ "section": "printer", "query": "A1", "limit": 5 }` and expect profile ids such as `machine:bambu-a1`.

If the client cannot start the server, the usual causes are Node older than 24, a relative path in the config, or a client that needs a restart to load new servers. If you cannot install the server in your client, say so and continue; the integration does not depend on it.

## Step 3: interview the user

Ask before you write code. Ask the questions together in one message, and offer a default for each so the user can answer in a few words. Assume the local path: the app slices its own local files with no SlicerX account, and an edition ships with the store, feed, cloud slicing and phone pairing off. Do not ask about accounts, tokens, cloud slicing, the vault or `.sxlock` unless the user brings up cloud, sharing or locked files. If they do, see "Optional: cloud and locked projects" at the end. Do not ask what the project already tells you: read `package.json` and the source tree first and only confirm what you found.

0. Which path: your own edition of the SlicerX app under your name (Path A, the default for a slicer product), SlicerX parts inside an app you already have (Path B), or opening files in an installed SlicerX (Path C)? For Path A ask for the path of their SlicerX clone, the product name, an id, the reverse-DNS app identifier, the brand colors, the logo files (SVG or PNG), the font files for any brand font, the support link and the repository URL where the source will be published; the rest of this interview is for Path B.
1. Which parts of SlicerX do you want? Offer this list:
   - viewport: the 3D view of a model or of the sliced toolpaths
   - slicing: turn a model or a 3MF plate into G-code or a `.gcode.3mf`, with time and filament per slot
   - printers and sending: show printer state and send a sliced plate to a printer
   - profiles and presets: pick printers, filaments and processes, use the user's own Bambu Studio or OrcaSlicer presets, or show the settings panel
   - mimir: the SlicerX assistant's skills (orient, arrange, cut, plan settings, diagnose a failed print)
   - the full app: the whole SlicerX window inside their app
2. What is the app built with? Framework (React, Vue, Svelte, plain HTML), shell (Electron, Tauri, web only, Node service), language (TypeScript or JavaScript) and package manager.
3. What is the brand? Accent color, background colors, fonts, light, dark or both, and whether the app already has CSS variables or a theme object to match.
4. Where do models and presets live? A folder the user picks, an app library folder, uploads?
5. Do you have the `sx` engine? (Needed for real slicing.)

### A plan for each answer

Write the plan back to the user in a few lines and wait for a yes before you build.

| They want | Plan |
| --- | --- |
| viewport | `Viewport` from `@slicerx/embed` (React) or `<sx-viewport>` (anything else). Show toolpaths from a slice with `preview: true`, or an STL with `src` or `decodeStl`. Recipe A. |
| slicing | Start `@slicerx/mcp` from the main process or a Node service and call `slicerx_slice_file`. Recipe B. Never from the browser: the server reads files and runs `sx`. |
| viewport and slicing | Both, wired together: slice with `preview: true`, read `preview_path` in the main process, pass the bytes to the renderer. Recipes A and B. |
| printers and sending | Two choices. If the app already talks to printers, it sends the `.gcode.3mf` or G-code from a slice itself, and SlicerX stays out of it. Otherwise run the server with `--printers link` and SlicerX's printer bridge `sx-link`; `slicerx_printer_queue` asks the person to approve each start in SlicerX or on their phone. The app cannot approve starts. Recipe E. |
| profiles and presets | `slicerx_list_profiles` and `slicerx_get_profile` for pickers, `profile_files` for the user's own presets, `filaments` for a preset per slot, `SettingsPanel` for an editor whose `overrides` go straight into a slice. Recipe C. |
| mimir | Over MCP: `slicerx_plan_settings`, `slicerx_diagnose`, `slicerx_calibrate`, the knowledge tools and the project tools (`slicerx_project_open`, `slicerx_orient`, `slicerx_arrange`, `slicerx_cut`, `slicerx_slice`). The app calls them like any other tool, or hands the server to the app's own AI assistant. There is no mimir chat UI to embed. |
| local AI | `LocalAiSetup` from `@slicerx/embed` for people (recommendation, size and license, a confirmed Ollama download, a tool call check; `onReady` hands over the model and its base URL), or over MCP `slicerx_local_ai_check`, `slicerx_local_ai_setup` and `slicerx_local_ai_status`. Recipe F. |
| the full app | Not available as a package yet. Say so plainly. Offer the closest path today: the viewport, the settings panel and slicing together (recipes A to C), which cover the plate view, the settings and the slice. |

Every plan that shows a SlicerX part to people also includes the agreement (step 5) and theming (step 6).

## Step 4: build it

Start with the local path: Recipe A for the viewport, Recipe B for slicing, Recipe C for profiles and presets. None of them needs an account or a token.

### Recipe A: the viewport (React)

```tsx
import { EmbedTheme, Viewport, injectStyles } from '@slicerx/embed'

injectStyles() // once, before the first render

export function PlatePreview({ sxpv }: { sxpv: ArrayBuffer | null }) {
  return (
    <EmbedTheme theme={brandTheme /* step 6 */}>
      <Viewport preview={sxpv} colorMode="tool" toolColors={['#F4EE2A', '#00AE42']} view="iso" onError={reportSlicerXCrash} style={{ height: 480 }} />
    </EmbedTheme>
  )
}
```

`colorMode` is `feature`, `tool` (filament per slot, in the `toolColors` you pass, slot 1 first), `speed`, `flow` or `layerTime`. `layer` limits the top visible layer. The viewport needs WebGL2; `onError` fires when it cannot start.

Without React:

```html
<sx-viewport theme="dark" color-mode="tool" view="iso" style="display:block;height:480px"></sx-viewport>
<script type="module">
  import { defineSlicerXElements } from '@slicerx/embed'
  defineSlicerXElements()
  const vp = document.querySelector('sx-viewport')
  vp.preview = sxpvBytes // an ArrayBuffer
  vp.addEventListener('error', (e) => reportSlicerXCrash(new Error(e.detail)))
</script>
```

In Vue, Svelte or Angular, use the custom elements and tell the framework that `sx-` tags are custom elements (Vue: `compilerOptions.isCustomElement`; Angular: `CUSTOM_ELEMENTS_SCHEMA`).

### Recipe B: slicing over MCP

Run this in the Electron main process, a Node service, or any Node 24 process. Copy it as is; it is the code the sample app runs.

```ts
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

const cli = createRequire(import.meta.url).resolve('@slicerx/mcp/cli')
const transport = new StdioClientTransport({
  command: process.execPath, // in Electron: see below
  args: [cli, '--engine', 'sx', '--sx-bin', sxPath, '--allow-dir', libraryDir, '--out-dir', outDir, '--printers', 'off', '--no-urls'],
})
const slicerx = new Client({ name: 'my-app', version: '1.0.0' })
await slicerx.connect(transport)

const result = await slicerx.callTool(
  {
    name: 'slicerx_slice_file',
    arguments: {
      model: '/library/part.3mf',
      plate: 1,
      profiles: ['machine:bambu-a1', 'process:standard'],
      filaments: [
        { slot: 1, profile: 'stock-filament:BBL/Bambu PLA Basic @BBL A1', color: '#F4EE2A' },
        { slot: 2, file: '/library/presets/My PETG.json', color: '#00AE42' },
      ],
      output: 'gcode.3mf',
      preview: true,
    },
  },
  CallToolResultSchema,
  { onprogress: (p) => showProgress(p.progress, p.message), timeout: 10 * 60_000 },
)
if (result.isError) {
  const { code, message } = (result.structuredContent as { error: { code: string; message: string } }).error
  // branch on code (see Error codes), show message
} else {
  const s = result.structuredContent as { time_s: number; filament_g: number; filaments: { slot: number; filament_g: number; filament_mm: number }[]; gcode_3mf_path?: string; preview_path?: string }
}
```

- `@modelcontextprotocol/sdk` is a dependency of the app: `npm install @modelcontextprotocol/sdk@1.31.0`.
- In Electron, `process.execPath` is Electron itself. Use it with `env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }` only when that Electron's Node is 24 or later (check `process.versions.node` in the main process). Otherwise bundle a Node 24 runtime and use its path as `command`.
- In a CommonJS main process, `require.resolve('@slicerx/mcp/cli')` gives the same path.
- `slicerx_inspect_project` lists a 3MF's plates and filament slots first. Slice one plate per call.
- Send the renderer the bytes of `preview_path` (for the viewport) and the numbers. Never give the renderer file paths it can read itself.

### Recipe C: profiles, presets and the settings panel

- Profile ids come from `slicerx_list_profiles` (`section`: `printer`, `process` or `filament`; `query` filters by text). The makers' own filament presets have `source: "stock"` and name the printer, so query `PETG HF @BBL A1` rather than `PETG`. Store ids, not names.
- The user's own presets: pass paths in `profile_files` (`.json`, `.bbscfg`, `.bbsflmt`, `.orca_printer`, `.orca_filament`, `.zip`). They need to be inside an `--allow-dir` folder.
- A preset per filament slot: `filaments: [{ slot, profile | file, color }]`. Each entry sets only its slot. Use it for an AMS or any multi-material plate.
- The settings panel:
  ```tsx
  <SettingsPanel mode="easy" onChange={({ overrides }) => setOverrides(overrides)} />
  ```
  Pass `overrides` as is to `slicerx_slice_file`.

### Recipe E: printers

If the app has its own printer connection, send `gcode_3mf_path` (Bambu Lab) or `gcode_path` (others) through it. Otherwise start the server with `--printers link` next to a running `sx-link`, list printers with `slicerx_printer_list` and queue with `slicerx_printer_queue`. The answer is `approval_required` or `needs_person`: show the user that SlicerX or their phone is asking them to confirm, and wait. Do not build an approve button that calls `slicerx_approve` with `approve: true`.

### Recipe F: local AI

For people, render the piece and keep what it hands back:

```tsx
import { LocalAiSetup, createTheme } from '@slicerx/embed'

// The same tokens as your edition config's brand.theme.tokens.
<LocalAiSetup theme={createTheme({ name: 'harbor', colors: { purple: '#0a7ea4' } })} allowedModels={['qwen-2.5-7b', 'qwen-2.5-14b']} onReady={({ model, baseUrl }) => saveModel(model, baseUrl)} />
```

In Electron or Tauri, pass `hardware` (a native read of the GPU memory) and `net` (requests from the main process), since a page can neither see the graphics memory nor reach Ollama without `OLLAMA_ORIGINS`. Over MCP, call `slicerx_local_ai_check` first and show the user its recommendation, size and license. `slicerx_local_ai_setup` always returns `approval_required`: show the request, and call `slicerx_approve` only with the user's yes. It sends progress notifications while it downloads. Never start a download without that yes, and never install Ollama for the user: give them the download page.

## Step 5: the pre-alpha agreement, crash reports and the bug link

Every app that shows SlicerX parts to people shows the agreement before they first use those parts, and again when its version goes up.

```tsx
import { Agreement, agreementNeeded, RELEASE } from '@slicerx/embed'

const [mustAgree, setMustAgree] = useState(() => agreementNeeded())
return mustAgree ? <Agreement appName="My App" onAccept={(record) => { setMustAgree(false); saveToServer(record) }} /> : <SlicerXParts />
```

- `agreementNeeded()` is true in a pre-alpha release until the current `AGREEMENT_VERSION` is accepted. `acceptAgreement` (called by the component) stores `{ version, acceptedAt }` in `localStorage` under `slicerx.embed.agreement`. Pass `storage` to keep it somewhere else, such as the app's settings file in Electron.
- `RELEASE` is `{ stage, bugReportsUrl }` for the SlicerX parts. Show `RELEASE.stage` in the app's About box and put `RELEASE.bugReportsUrl` in its Help menu as "Report a SlicerX bug".
- Without React: `<sx-agreement app-name="My App">` fires `accept` with the record.
- Crash reports: pass `onError` to `Viewport` (or listen for `error` on `<sx-viewport>`) and send the error to the app's own crash reporting, tagged with the SlicerX release. Remove tokens, keys, addresses and user names before anything leaves the machine. The agreement tells people crash reports may be sent.

## Step 6: theming

Every SlicerX UI part takes the host app's brand. Themes are typed objects made with `createTheme` from `@slicerx/embed`. The parts read CSS variables, so nothing in the host page is touched.

| Part | Takes a theme from | Notes |
| --- | --- | --- |
| `Viewport` | the surrounding `EmbedTheme`, plus `sceneTheme` | The scene follows the theme: the accent marks the selection, a light theme gets a light studio, and `theme.scene` sets the backdrop, plate and grid. `sceneTheme` sets any scene, toolpath or heat ramp color. |
| `SettingsPanel` | the surrounding `EmbedTheme` | Surfaces, text, accent, fonts and radii. |
| `Agreement` | the surrounding `EmbedTheme` | Same. |
| `<sx-viewport>`, `<sx-settings-panel>`, `<sx-agreement>` | `theme` attribute (`dark` or `light`) or `theme` property (a full theme) | `sceneTheme` property on `<sx-viewport>`. |
| `.gcode.3mf` plate picture | none | The engine draws it. |

The color roles. Keep them when you recolor, even though some names are historical:

| Key | Role |
| --- | --- |
| `ink0` to `ink4` | Surfaces, from the page background to raised controls |
| `line`, `lineSoft` | Borders of controls, and dividers |
| `fg`, `muted`, `dim` | Text: content, labels, captions |
| `purple` | The accent: selection, focus, primary buttons. Put the brand's main color here. |
| `pink` | The second accent |
| `cyan`, `green`, `orange`, `red`, `yellow` | Live data, ok, attention, error, highlight |
| `onGrad` | Text on the accent and the gradient |

A worked example, a green brand on a dark app:

```ts
import { createTheme, nocturne } from '@slicerx/embed'

export const brandDark = createTheme({
  name: 'acme-dark',
  scheme: 'dark',
  colors: {
    ink0: '#0d1310', ink1: '#121a16', ink2: '#17211c', ink3: '#1d2a23', ink4: '#24342b',
    line: '#2f4338', lineSoft: '#24342b', fg: '#e8f3ec', muted: '#a7bdb0', dim: '#86a092',
    purple: '#2fbf71', pink: '#7ad3a0', onGrad: '#04140b',
  },
  gradient: { from: '#2fbf71', to: '#1e8f53', angle: '120deg' },
  fonts: { body: 'Inter, system-ui, sans-serif', display: 'Inter, system-ui, sans-serif' },
  radius: { md: '6px', lg: '10px' },
  scene: { top: '#17211c', bottom: '#070b09', glow: '#1d2a23', plate: '#2f4338', grid: '#4f7a62', edge: '#020403' },
}, nocturne)
```

Light and dark: make a second theme on `nocturneLight` (`createTheme({ ... }, nocturneLight)`) and pick one by the app's own setting or `matchMedia('(prefers-color-scheme: dark)')`. Changing the `theme` prop of `EmbedTheme` re-themes at once.

Matching a host that already has CSS variables: read them once at start and build the theme from them.

```ts
const css = getComputedStyle(document.documentElement)
const v = (name: string) => css.getPropertyValue(name).trim()
const theme = createTheme({ colors: { purple: v('--brand-primary'), ink0: v('--bg'), ink1: v('--surface'), fg: v('--text') } }, nocturne)
```

Colors must be `#rrggbb` for the 3D scene; other formats work for the UI parts only.

Check contrast: with the MCP server connected, call `slicerx_theme_create` with `{ "base": "nocturne", "overrides": { ...the same object... } }`. It returns a WCAG contrast check; fix every failing pair. Without React, `themeToCss(theme, '[data-my-scope]')` returns a stylesheet.

Use the gradient for at most one hero moment per screen. Controls, including the primary button, use the solid accent.

## Error codes

A refused tool call has `isError: true` and `structuredContent.error` with a stable `code` and a `message` to show. Branch on the code:

| Code | What to do |
| --- | --- |
| `invalid_input`, `invalid_settings` | A bug in the arguments; the message names the field. |
| `file_not_found`, `path_not_allowed` | Ask the user to pick the file again; add its folder to `--allow-dir` only if the user chose it. |
| `unsupported_format`, `invalid_model` | Tell the user the file cannot be read. |
| `no_such_plate` | Re-read the plates with `slicerx_inspect_project`. |
| `unknown_profile` | Re-list profiles; the id changed or was mistyped. |
| `engine_unavailable` | `sx` is missing or the stub engine was asked for G-code. |
| `slice_failed`, `preflight_blocked` | Show the message. `preflight_blocked` means the engine's safety checks refused a setting or custom G-code. |
| `project_gcode_review` | The project's printer G-code is not the printer's stock text. Show `details.changes` (the diff and each flagged line with its reason) to the person. If they want the printer profile's G-code, call again with `project_gcode: "profile"`. Never choose the project's G-code for them: no tool can, and the person does it in SlicerX. |
| `sequence_clearance` | The plate prints by object and the toolhead or gantry would hit a finished object. Show the message (it names the objects); move them apart, print the tall one last, or print by layer. |
| `not_configured`, `auth_failed`, `not_invited`, `quota_exceeded`, `rate_limited`, `service_error` | Optional account and cloud features only. A local slice never returns them. |
| `sxlock_<reason>` | Optional locked projects; `@slicerx/embed/sxlock` throws `SxlockError` with the same reason as `code`. |
| `internal_error` | Report it on the SlicerX Discord. |

[quickstart.md](quickstart.md#error-codes) has every code.

## Path C: hand files to an installed SlicerX

For a product that does not build or embed SlicerX and only opens models in the app the user installed. This is the weakest integration: the product does not get the engine, the viewport or the MCP server, and cannot read results. No signed SlicerX installers are published yet (`apps/desktop/release/downloads.json` is empty until a release exists); the release workflow builds them. What the repository establishes today:

- Installers: a universal macOS dmg, Windows x64 NSIS and MSI, Linux AppImage and deb (`apps/desktop/README.md`). The repository sets no install folder, so each platform uses Tauri's installer default: SlicerX.app in `/Applications` on macOS, the installer's per-user or per-machine program folder on Windows, and `/usr` for the deb. Check these on a real install before relying on a path.
- Opening a file: the app registers `.3mf`, `.stl`, `.obj`, `.amf`, `.step`, `.stp`, `.sx3mf`, `.sxlock` and `.gcode`. A second launch with a file path as an argument hands the file to the running app (single instance), so launching the app's executable with a file path opens it (the argument handling is in `apps/desktop/src-tauri/src/main.rs`; the exact command lines have not been tried on an installed copy). `slicerx://open?url=https://...` opens a model from an https link after the user confirms; other schemes and hosts are refused.
- The MCP server ships inside the macOS app as `SlicerX.app/Contents/Resources/mcp/slicerx-mcp.mjs`, run with `node`, and `--version` prints its version. The Windows and Linux resource folders are not documented in the repository.
- There is no `sx` binary in the installed app, and no command that prints the app's version. On macOS read `CFBundleShortVersionString` from `SlicerX.app/Contents/Info.plist`.
- If SlicerX is not installed, send the user to https://slicerx.app/#download. Do not assume it exists: check for the app, and fall back to opening the file in the system's default program.

What would have to change for an installed-app integration to match Path B: ship `sx` and a version command with the installer, document the resource folder on Windows and Linux, and register a documented way to ask the app to slice and return a result.

## Optional: cloud and locked projects

Only when the user asks for cloud slicing, sharing or locked files. These are the only features that need a SlicerX account, an `sxk_` token and the network. Everything above works without them.

Questions to add to the interview in that case: which of the two they want, whether their users have SlicerX accounts, and where the token will live (the system keychain or an environment variable the user sets).

| They want | Plan |
| --- | --- |
| locked projects | `@slicerx/embed/sxlock` in any JavaScript runtime, or the `slicerx_sxlock_*` tools. Needs an `sxk_` token with `sxlock_open`, `sxlock_seal` or both, from the user's SlicerX account. Recipe D. |
| cloud slicing | `slicerx_cloud_slice` and `slicerx_cloud_jobs`, with a token that has the `cloud_slice` scope and the server started with `--cloud-api <url>`. [quickstart.md](quickstart.md#token-scopes) lists the scopes and where the server reads each token. |

### Recipe D: locked projects (needs an account token)

```ts
import { openSxlock, readSxlockHeader, sealSxlock, tokenKeys, SxlockError, SXLOCK_MESSAGES } from '@slicerx/embed/sxlock'

const keys = tokenKeys({ supabaseUrl, anonKey, token }) // token: the user's sxk_ token, from the keychain
try {
  const sx3mf = await openSxlock(lockedBytes, keys) // needs the network every time
} catch (e) {
  if (e instanceof SxlockError) show(SXLOCK_MESSAGES[e.code]) // wrong_account, offline, revoked, missing_scope, ...
}
```

Write an opened `.sx3mf` only where the app alone reads it (mode 0600) and the server may read it, slice it, and delete it. The server reads files inside its `--allow-dir` folders and its own `--out-dir`. With the server instead of the library, `slicerx_sxlock_open` writes the opened `.sx3mf` into `--out-dir` and returns its `path`, which `slicerx_slice_file` takes as `model` as is. The SlicerX team gives integrators `supabaseUrl` and `anonKey`; the token comes from the user's SlicerX account settings, with only the scopes the app needs.

## Before you finish

Check each of these and tell the user the result:

- The SlicerX MCP server is registered for the project, and `--version` ran.
- Path A: `check` passes with no font warnings, `pnpm edition:build` finishes, the build installs and opens under the product's own name with its accent, logo and fonts, About shows the credit, the source link and the trademark notice, and you listed the rebranding gaps for the user. Path B: the app builds and its type check passes.
- Every SlicerX part sits inside `EmbedTheme` (or has its `theme` set) and shows the brand accent and surfaces.
- The agreement shows before the first SlicerX part, and accepting it stores the version.
- The MCP server runs only in a main process or service, with `--allow-dir` limited to the user's folders.
- No token or secret is in the code, configs or logs. A local-only app has none.
- Nothing approves printer starts, resumes, G-code or adjustments.
- `@slicerx/*` versions are pinned exactly.

A complete working example is `examples/integrator-sample` in the SlicerX repository: an app called Spoolhouse that does all of the above, with its own brand.
