# Integrator kit eval

Checks that a coding agent pointed at the integrator kit, and nothing else, builds a working integration. The agent starts in an empty folder outside the repository with `slicerx-kit/` (the packed `@slicerx/viewport`, `@slicerx/embed` and `@slicerx/mcp`, plus `docs/integrators`). A scripted developer (`personas.mjs`) opens with a request, answers the interview the kit asks for, and says go ahead.

```sh
cargo build -p sx-cli --release
node scripts/devkit-eval/run.mjs                     # Claude Code, the filament tracker persona, Sonnet, 4 USD per turn
node scripts/devkit-eval/run.mjs --model opus --budget 8
node scripts/devkit-eval/run.mjs --kit /path/to/packed/kit --sx-bin /path/to/sx --out /path/to/results
node scripts/devkit-eval/run.mjs --persona whitelabel  # Path A: an edition in a clone of this repository
```

The `layermate` persona is Chris, who asks for "a slicer in my LayerMate" and does not know which path to take. The run copies a stand-in host app (`fixtures/layermate`, Node and HTML only) into the app folder. Chris answers the Start here question with "I'm not sure, what do you recommend?", then follows the recommendation with brand answers. Besides the Path A checks below it scores asking Path A or B before writing anything, recommending Path A for a desktop app, and hooking the host up: the stand-in's "Open in slicer" button runs `editionCommand` from `layermate.config.json` with the model's path as the last argument, which is the documented way to open a file in an installed edition.

`--dry-run` starts no agent and bills nothing. It sets up the app folder, renders the persona's turns and checks the wiring, including a launch of a fake slicer from the stand-in:

```sh
node scripts/devkit-eval/run.mjs --persona layermate --dry-run
```

The `engine` persona is Path B with the engine ([engine-path.md](../../docs/integrators/engine-path.md)): a print queue app whose developer wants a Prepare step in the viewport, runs `sx` itself rather than slicing over MCP, and prints through SlicerX's printer bridge with a partner app key. It gets `x-mark.stl` in `data/models` and is scored on that path:

- interviewed before writing code
- installed `@slicerx/embed` from the kit
- the viewport with its Prepare tools (`tools`)
- kept the transforms people make (`onTransform` or the `transform` event)
- put the decoder's offset back with `fileTransform`
- ran `sx slice --request` from a Node process, never the browser
- showed the preview and the time and grams
- asked to print through the bridge with the partner key: a print card with its work, after checking the hub's signed hello
- never approved a print, and kept the key out of the code
- sliced once to check it
- no parts the developer did not ask for (MCP slicing, locked projects, the settings panel)
- the pre-alpha agreement, the brand theme, the rules, and `npm run build`

The `whitelabel` persona makes its own edition (Path A). The run copies the developer's brand files into the app folder and clones this repository beside it with SlicerX as the `upstream` remote (`--clone <path>` uses an existing clone). The agent may also run `cargo`, `rustc`, `rustup`, `wasm-opt`, `sh scripts/install-binaryen.sh`, read-only git commands and the `SLICERX_CONFIG=` and `SX_WASM_OPT=` forms of the build there. `pnpm edition:build` needs none of the variable forms.

Each run bills the agent's account. Results go to a temporary folder (printed at the end): `score.json`, `transcript.jsonl` and the app the agent built. Servers the agent starts itself (such as `npm run dev`) keep running after the eval; stop them by PID.

## Score

One point each (`score.mjs`):

- connected the SlicerX MCP server for itself (a project MCP config, or the client's add command)
- checked that the server runs
- interviewed before writing code: the first answer asks about the parts, the stack and the brand, and no app code exists yet
- installed `@slicerx/embed` and `@slicerx/mcp` from the kit
- the viewport from `@slicerx/embed`
- slicing over MCP from a server process, not the browser
- no parts the developer did not ask for
- the pre-alpha agreement
- themed with the brand accent through `createTheme` and `EmbedTheme`
- kept the rules: no `slicerx_approve`, no token in code
- `npm run build` passes

A Path A persona is scored on the edition instead:

- interviewed before writing the config
- said the edition is a separate app that the host app launches
- the config passes `check` with no font warnings
- the config carries the brand name, identifier, accent, bundled font and a local model, with the store off and a source link
- the edition builds: the desktop Tauri config names the product, and the browser app builds from the config
- ran the documented build (`pnpm edition:build`, or `build:wasm` and `build:app`)
- the built app opens branded: `launch.mjs` serves it, opens it in headless Chromium, and checks the title, the accent, the font and that no SlicerX shows besides the credit
- kept the rules: nothing pushed and no secrets in the config

## Agents

`agents.mjs` has a runner per agent. `claude` (Claude Code, `claude -p`) is the one that has been run. Its tools are limited to files, npm, node and `claude mcp`; it has no web access, no git push, publish or deploy, and loads no settings, memory or MCP servers from the machine. Runners for `codex` (`codex exec --json`), `cursor` (`cursor-agent -p`) and `opencode` (`opencode run`) follow each CLI's documented non-interactive mode and need a first run to confirm; pick one with `--agent`. Grok and ChatGPT have no local coding CLI to script here.
