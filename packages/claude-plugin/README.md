# SlicerX plugin for Claude Code

SlicerX, the AI-ready slicer, as a Claude Code plugin. It bundles the SlicerX MCP server with skills and slash commands for the jobs people bring to a slicer: estimating and slicing a model, planning settings for a filament or printer, diagnosing a failed print, calibrating a new spool, connecting a printer, and theming an embedded SlicerX.

The MCP server inside is the same client-neutral server that ChatGPT, Cursor and other MCP clients use ([packages/mcp](../mcp/README.md)). This plugin adds the Claude Code packaging, the skills and the commands.

## Install

From this repository's marketplace:

```
/plugin marketplace add slicerx-oss/slicerx
/plugin install slicerx@slicerx
```

The plugin starts the SlicerX MCP server with `npx -y @slicerx/mcp@0.1.0`, so you need Node 24 or newer and npm on your `PATH`. npx downloads that exact version from npm the first time.

Until `@slicerx/mcp` is published, use the development copy, which runs a local build of the server instead:

```sh
pnpm install
pnpm --filter @slicerx/claude-plugin build      # writes packages/claude-plugin/.dev/
claude --plugin-dir /path/to/slicerx/packages/claude-plugin/.dev
```

## Settings

`claude plugin configure slicerx` shows and sets these values:

| Setting | What it does | Default |
| --- | --- | --- |
| Model folders | Folders SlicerX may read models from, separated by colons | any file you can read |
| SlicerX core (sx) path | The `sx` slicer binary. Without it, results are rough estimates from the mesh | `sx` on `PATH` |
| Printers | `demo` (five simulated printers), `link` (your printers through sx-link) or `off` | `demo` |
| sx-link pairing code | The code sx-link prints when it starts, for `link`. Stored in your system's secure credential store | none |
| Permission policy file | Your policy JSON | `~/.config/slicerx/mcp-policy.json` if present |

G-code, downloads and the action log go to the plugin's data folder.

## What the plugin runs, sends and fetches

- It runs one local process: the SlicerX MCP server (`@slicerx/mcp` 0.1.0 from npm, started by npx), which runs the `sx` slicer when you set its path.
- It reads the model files you name, inside your model folders when you set them, and downloads models from http(s) URLs you give it (up to 256 MB).
- With Printers set to `link`, it talks to `sx-link` on 127.0.0.1, which talks to your printers on your local network.
- It writes G-code, downloaded models, generated themes and an action log to the plugin's data folder, and saved profile changes to `~/.config/slicerx/profiles`.
- It sends nothing anywhere else: no SlicerX servers, no telemetry.

## Skills

| Skill | Use it for |
| --- | --- |
| `slice-model` | Estimate time and filament, or write G-code, for a model on a given printer and filament. Try it without a file on the built-in test models (`sample:cube-20`). |
| `plan-settings` | Settings to change for a new filament, printer, nozzle or goal, each with its reason and sources, plus a checked config patch. |
| `diagnose-print` | Walk the troubleshooting guide for a failure (stringing, warping, layer shift and more), using printer status and the camera when available. |
| `calibrate-spool` | Drying, then a temperature, flow, pressure advance and retraction plan for a new spool, with the setting each result goes into. |
| `set-up-printer` | Connect a Bambu Lab, Klipper, Creality, Snapmaker, Prusa, OctoPrint, Duet or Elegoo printer through sx-link, and explain the permission policy. |
| `theme-embed` | Build a brand theme for an embedded SlicerX, fix contrast, and hand over the stylesheet or theme object. |
| `integrate-app` | Build SlicerX into the developer's own app: install the packages, interview them about the parts, framework and brand, then slice over MCP, embed the viewport, show the pre-alpha agreement and theme it, following the integrator kit (`docs/integrators/AGENTS.md`). |

## Commands

| Command | What it does |
| --- | --- |
| `/slicerx:slice <path-or-url> [printer] [filament] [intent]` | Estimate, then slice on request |
| `/slicerx:plan <request>` | Plan settings for a request such as "PETG on a P1S, strong" |
| `/slicerx:printers` | Every printer with state, job, temperatures and filament, grouped by fleet |
| `/slicerx:approvals` | Pending approval requests and the permission policy |

## Permissions and safety

Anything that heats or moves a printer, sends a job or writes a saved profile follows your permission policy: Allow, Ask first or Off per class. Queueing and printer control default to Ask first. Ask first shows you an approval prompt, and each approval covers one action with the exact parameters shown, once, for five minutes. The plugin cannot change the policy. [packages/mcp/README.md](../mcp/README.md#permissions) has the policy format.

The plugin sends nothing to SlicerX servers and has no telemetry. Printer traffic stays on your network, and credentials stay in your operating system keychain.

## Evals

The suite in `evals/` has one case per skill plus an approval safety case (the assistant must not approve a printer action on the user's behalf). Cases run against the real MCP server, which is local and uses the simulated printers. Run them on the development copy, which starts the local build:

```sh
pnpm --filter @slicerx/claude-plugin build
claude plugin eval packages/claude-plugin/.dev --allow-real-servers --allow-tools 'mcp__plugin_slicerx_slicerx__*' ListMcpResourcesTool ReadMcpResourceTool --no-publish
```

Each run bills your account; keep `--runs` small while iterating.

Add `--model haiku --runs 1 --ablation none` for a quick, cheap check. The last full check on Haiku, one run each, scored 1.0 on six of seven cases. The calibration case missed the drying step once; the skill now opens with drying, and a rerun of that case passed its content grader. Results go to `.dev/evals/results/` (not committed).

## Development

```sh
pnpm --filter @slicerx/claude-plugin build     # .dev/ with a local server build
claude plugin validate packages/claude-plugin --strict
claude plugin validate .claude-plugin/marketplace.json --strict
```

`.dev/` is generated and git-ignored.

## Marketplace submission

The owner submits through the plugin directory form later; it needs a paid plan and a public repository. Where the plugin stands against the directory's rules:

- Manifest, skills, commands and the marketplace file pass `claude plugin validate --strict`. Done.
- README of at least 40 words that says everything the plugin runs, sends and fetches, a license, and an author. Done (Apache-2.0, `LICENSE-APACHE` and `NOTICE` in this folder).
- No secrets in the plugin; the sx-link pairing code is a `sensitive` user setting. Done.
- A local MCP server started with plain arguments, and any npx launcher pinned to an exact version. Done: `npx -y @slicerx/mcp@0.1.0`.
- Every file under 256 KiB, at most 512 files, and readable source. Done: the plugin holds only Markdown and JSON; the server comes from npm, where its bundle is readable and not minified.
- Tool annotations (read-only, destructive, title) on every MCP tool. Done.
- `@slicerx/mcp` 0.1.0 on npm, so the plugin works outside a clone. Done once it is published; until then, use `.dev/`.
- Gap: a tagged release of the public repository for the directory entry to pin.
- Gap: the homepage (slicerx.app) must resolve.
- Gap: run the eval suite on the default model with three runs per case (`claude plugin eval packages/claude-plugin/.dev --allow-real-servers ...` without `--runs 1`) before submitting.
- Gap: recorded mocks under `evals/mocks/slicerx/` would let reviewers run the suite without starting the server; today it needs `--allow-real-servers`.
- Real printers: approvals for printer actions go through sx-link's own broker, tested against sx-link and the mock printers. Physical printers are not yet tested.
