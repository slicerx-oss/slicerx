# @slicerx/pilot

mimir, the built-in agent. The TS runtime runs the same in the browser, the desktop app and the evals. It never sees an API key; model requests go through `Host.llm`, which adds the key.

Layout:

- `src/`: runtime (`runtime.ts`), permission gate (`gate.ts`), approval broker mirror (`permit/broker.ts`), provider layer (`provider/`: OpenAI Responses, Anthropic Messages and OpenAI-compatible chat completions adapters, SSE parser, scripted client), tools (`tools/`: kb, settings, web, printer, plugin, project, report, app commands), knowledge base and planners (`kb/`), intent parser (`intent.ts`), session logs (`session.ts`), Node transport and file session store (`node/`, not for the browser).
- `skills/`: one folder per tool. `skills/catalog.ts` lists the 16 skills the assistant offers (print check-ins, diagnosis, goals to settings and geometry, cited answers, setup help, farm batches) and the tools each runs with. Every other tool in `skills/` is a deterministic job the app runs through `src/functions.ts`; mimir is not offered those.
- `ui/`: the chat surface (React). `ui/dev/` is a dev harness (`npx vite ui/dev` from this folder) that runs the real runtime against fleet-sim.
- `evals/`: scenarios, harness (fleet-sim with audited tokens, in-memory project, stand-in slicer), scoring and the CLI. `results.jsonl` and `LOG.md` hold the hill-climb log.
- `llm/`: `sx-llm`, the Rust transport that adds the key. `permit/`: `sx-permit`, the Rust approval broker.

## Public API

```ts
createPilot({ host, config, policy?, commands?, project?, kb?, planner?, store?, machineRates?, client? }): Pilot
// host: { llm: LlmTransport, approvals: ApprovalHost, printers: PrinterHost, slicer?: SlicerHost, profiles? }
createKnowledgeBase(await import('@slicerx/pilot/kb.json'))   // about 730 KB, load on first use
createCombinedPlanner(kb)       // @slicerx/settings planSettings, gaps filled from knowledge/
createApprovalBroker()          // ApprovalHost + ApprovalVerifier for the web host and fleet-sim
createScriptedClient(steps)     // replay provider for demos and tests
defineSkill(spec), defineTool(spec)
SKILL_INFO, DEFAULT_CONFIG, parsePilotConfig(json)   // SKILL_INFO: name, title, description, example prompt
```

Deterministic checks run as plain functions, with no model and no key:

```ts
import { runAppFunction, preflight, APP_FUNCTIONS, appFunctionSpecs } from '@slicerx/pilot/functions'
await preflight({ printerId, plate }, { host, project, shared })   // gcode_inspect, printer_config_check, spool_fit
await runAppFunction('risk_report', { plate: 1 }, { host, project })  // { ok, summary, output, display, citations }
```

`APP_FUNCTIONS` names them all: the send preflight, `risk_report`, `overnight_readiness`, `spool_inventory`, `energy_estimate`, `printer_match`, `fleet_overview`, and the geometry and color operations. `display` renders with `DisplayView` from `@slicerx/pilot/ui`. The material switch diff is `planSettings` in `@slicerx/settings`.

For a docked panel, build on `usePilotRun` (`@slicerx/pilot/run`), `TranscriptView`, `Terminal` and `ApprovalCard` from `@slicerx/pilot/ui`, pass the current plate as the run's `context` (`PilotContext`: machine, printer, overrides, objects), and use `SKILL_INFO[].example` for suggestion chips.

```ts
import { PilotWorkspace } from '@slicerx/pilot/ui'   // import '@slicerx/pilot/ui/pilot.css' once in the app
import { createNodeTransport, createFileSessionStore } from '@slicerx/pilot/node'
```

Commands:

```
pnpm --filter @slicerx/pilot test
pnpm --filter @slicerx/pilot eval --mode replay
pnpm --filter @slicerx/pilot eval --mode live --scenario gate --runs 3 --max-requests 120 --log --change "what changed"
pnpm --filter @slicerx/pilot eval --mode live --scenario kb-suite     # print-expert prompts in knowledge/evals
pnpm --filter @slicerx/pilot kb:build                                  # after knowledge/ changes
```

Live mode reads the key at request time from `SLICERX_OPENAI_API_KEY`, `OPENAI_API_KEY`, then the macOS Keychain (service `slicerx-openai-api-key`, account `slicerx`). It never prints, logs or stores it, and only sends it to `api.openai.com`.

## Print check-ins

`check_print` answers "how's the print going?". It takes a fresh frame from `PrinterHost.snapshot` (JPEG, PNG or WebP, at most 5 MB), shows it in the transcript as an `image` display, and sends it to the model with the result (`ToolOutput.images`). The adapters pass it as `input_image` in a Responses function call output, as an image block in an Anthropic tool result, and as a user message after the tool messages for chat completions. Only the two newest frames stay in the model history.

The model proposes fixes with `print.adjust`, one change per call: part fan, speed factor, nozzle or bed temperature, or pause. Each shows an approval card with the reason. The limits in `skills/check_print/limits.ts` refuse a change before any card is shown:

- Only while the printer is printing, and never turning on a heater that is off.
- Nozzle at most 15 C per change and bed at most 10 C, inside the loaded material's range from the knowledge base. With mixed or unknown material, 10 C and 5 C. The nozzle always stays within 170 to 300 C and the bed at or below 120 C.
- Part fan 0 to 100 %, capped at the material's highest fan (ABS and ASA crack with strong cooling).
- Speed factor 50 to 150 %. Bambu Lab printers change speed by level, so speed is refused there.

Replay scenarios use frames drawn by `evals/frames/make-frames.ts` (diagrams, not photos). How well a model reads real frames needs live runs with photos.

The user-facing name comes from `ASSISTANT_NAME` in `src/name.ts`.

## Models

`src/models.ts` picks the model for each step. huginn (`config.models.huginn`) takes quick looks; muninn (`config.models.muninn`) handles diagnosis, tuning and planning. A run starts on huginn unless the request asks for deep thinking (`tierForPrompt`), and moves to muninn when it calls a tool in `MUNINN_TOOLS`. `config.modelChoice` pins one model when it is not `automatic`. On the ChatGPT plan the defaults are huginn `gpt-5.6-luna` and muninn `gpt-5.6-terra` (the owner's pick from the plan listing, in `pilot.config.example.json`). With `config.billing: 'key'` one model, `config.model` (`gpt-5.6-luna`, also an API model), does everything. Each tier falls back to `config.model`.

## How approvals work

A tool with a side effect declares an approval plan: a question, lines for the card, and every host call it will make (`printer.upload`, `printer.start`, `profile.write`, `plugin.call`, ...) with the exact parameters. The runtime hashes each call's parameters, registers the request with the host broker and shows the card. Only `resolveApproval` (the card's buttons) leads to `ApprovalHost.grant`; the model has no path to it. The host verifies the token for each call's action, target and parameter hash, once. Classes set to Allow in Permissions are granted by the runtime and shown as a permission line; `start` can only be Allow per printer. Tool output from files, printers and the web is wrapped as untrusted data for the model.

## Dependencies

- `zod` 4.6.5: tool input schemas, validated before a handler runs, exported as JSON Schema for the model.
- `@slicerx/contracts`, `@slicerx/settings`, `@slicerx/ui`: workspace packages.
- Dev: `vitest` 5.0.2 (tests), `jsdom` 30.1.1 and `@testing-library/react` 16.3.3 (UI tests), `tsx` 4.23.15 (eval CLI, KB build), `yaml` 2.9.1 (KB build, eval suite loader), `@types/*`. React 19.3.0 is a peer dependency.

## Status

- Runtime, gate, broker, OpenAI Responses adapter (streaming text, reasoning summaries, tool calls, hosted web search with citations), scripted provider: done, tested.
- Skills: 15 in `knowledge/skills.yaml`. mimir's tools are the ones those skills name, plus kb tools, `settings.plan` and `settings.apply`, `web.lookup`, `project.info`, printer tools, manifest plugin tools, `pilot.report` and app commands. 22 deterministic tools are app functions.
- Live settings evaluation: `switchMachine` emits the diff from `planSettings` plus knowledge fallbacks in under 10 ms.
- Chat surface in `ui/`; the app mounts `PilotWorkspace`.
- Evals: 49 replay scenarios (7 gate), 5 of them check-ins with stored frames, plus the 30 prompts in `knowledge/evals`. Scenarios for jobs that became app functions run without a model in the unit tests (`evals/functions.ts`). Results are in `evals/LOG.md`.
- Not done: the cut skill records a split without cutting the mesh (no core cut API yet); diagnose does not read camera snapshots (check_print does); a judge for the answer facts in `knowledge/evals` (they print with `--verbose` for a manual read).
