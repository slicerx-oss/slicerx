# @slicerx/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI tools (Claude, ChatGPT, Cursor and any other MCP client) what mimir, the assistant built into SlicerX, can do: slice and estimate, plan and check settings, orient, arrange and slice a project, queue jobs, control printers, and read the knowledge base and the integrator guides. Everything that changes a printer, a saved profile or spends money goes through the same permission policy and approvals mimir uses in the app.

It runs over stdio for desktop clients and over streamable HTTP for clients that connect to a URL.

## Tools

Reading is always allowed. The permission class of the other tools decides what the user's policy does with them.

| Tool | What it does | Class |
| --- | --- | --- |
| `slicerx_slice_file`, `slicerx_estimate_file` | Slice or estimate one model file (STL, OBJ, 3MF or `.sx3mf` by path or http(s) URL, or a built-in test model: `sample:cube-20`, `sample:tower-20x60`, `sample:plate-60x40x3`, or `sample:x-mark`, the SlicerX reference X), or one `plate` of a project, with profiles, the user's own preset files (`profile_files`), a filament per slot (`filaments`) and overrides, optionally starting from the project's own settings (`project_settings`). Returns time, grams, meters and layers in total and per filament slot, and the G-code path; `output: "gcode.3mf"` also writes a `.gcode.3mf` and `preview: true` the SXPV toolpath preview. | read (writes only to the output folder) |
| `slicerx_inspect_project` | A 3MF or `.sx3mf` project's plates, the presets it was saved with, its filament slots and whether it carries print settings, without slicing it. | read |
| `slicerx_list_profiles`, `slicerx_get_profile` | Printer, filament and process profiles, with OrcaSlicer `inherits` resolved, including the makers' own filament presets (`stock-filament:BBL/Bambu PLA Basic @BBL A1`). | read |
| `slicerx_plan_settings` | Settings to change for a filament, printer, nozzle and intent, each with before, after, a reason and sources, plus a `config_patch`. | read |
| `slicerx_explain_setting`, `slicerx_find_settings`, `slicerx_validate_config` | Look up, search and check the 700 or so OrcaSlicer settings. | read |
| `slicerx_knowledge_lookup` | Filament, printer, troubleshooting and workflow entries with sources. | read |
| `slicerx_project_open`, `slicerx_project_add_model`, `slicerx_project_show` | Start a project with a printer and filament, add STL models with copies, show it. | read |
| `slicerx_project_set_overrides` | Change settings for the project (never a saved profile). | slice |
| `slicerx_orient`, `slicerx_arrange`, `slicerx_cut`, `slicerx_slice` | mimir skills on the project: best rotation, pack plates, split to fit, slice every plate. | slice |
| `slicerx_geom_cut`, `slicerx_geom_split`, `slicerx_geom_repair`, `slicerx_geom_hollow`, `slicerx_geom_emboss`, `slicerx_geom_calibration_model`, `slicerx_geom_build`, `slicerx_geom_subtract` | Mesh tools from sx-geom, each taking a model path, URL or `sample:` name and writing new STL files under the output folder: cut with a plane and optional pin, dowel or dovetail connectors, split to fit a build volume, repair holes and normals, hollow with a wall thickness, emboss or deboss text, generate calibration prints (temperature tower, flow, pressure advance, retraction, max volumetric speed, tolerance, shrinkage, feature piece) with the settings to apply, build a model from boxes, cylinders and prisms, and drill holes and countersinks in an existing model. Present only when `sx-geom` is found. | slice |
| `slicerx_geom_faces`, `slicerx_geom_face_pick`, `slicerx_geom_edge_pick`, `slicerx_geom_sketch_check` | CAD lookups: list a model's flat faces (a point on each, its normal, the axis it faces, its area), pick a face for its sketch frame and outline, pick an edge for a fillet or chamfer (with the largest radius that fits, its tangent chain and the loop around the face), and check sketch loops before extruding. Reports only. | read |
| `slicerx_geom_extrude`, `slicerx_geom_revolve`, `slicerx_geom_push_pull`, `slicerx_geom_boolean`, `slicerx_geom_fillet`, `slicerx_geom_chamfer` | CAD modeling on the SlicerX engine: sketch (rectangle, circle, slot, polygon, text, free lines and arcs, or SVG) on the bed, any plane or a picked face and extrude it as a new body, joined or cut; revolve a sketch; push or pull a flat face; union, subtract or intersect models; round or bevel straight edges. Each writes a new STL under the output folder. Present only when `sx-geom` is found. | slice |
| `slicerx_geom_orient`, `slicerx_geom_layers_plan`, `slicerx_geom_resume_plan` | Rank print orientations by overhang, support volume and bed contact, plan variable layer heights (sleipnir), and plan resuming a failed print from a measured height or a layer number. Reports only. | read |
| `slicerx_cloud_slice` | Slice a model in the integrator's SlicerX cloud: uploads the STL by its SHA-256 (only when the cloud lacks it), queues a job with profiles and overrides, returns the job id. The job names no printer, so it never starts a print. Off until a cloud API is configured (see Cloud slicing); until then it answers that cloud slicing is not configured and sends nothing. | slice |
| `slicerx_cloud_jobs` | One cloud job's status, progress, result and G-code and preview links, or the recent jobs. Same configuration rule. | read |
| `slicerx_sxlock_inspect`, `slicerx_sxlock_open`, `slicerx_sxlock_export` | Locked projects (`.sxlock`): read a header offline, open one to an `.sx3mf` in the output folder, or lock an `.sx3mf` for the account. Open and export act for the account whose token the server holds, within its scopes. Off until an account service is configured (see Locked projects). | read, read, slice |
| `slicerx_estimate`, `slicerx_calibrate`, `slicerx_diagnose` | Totals and schedule, calibration plans, and failure diagnosis from printer status and the knowledge base. | read |
| `slicerx_kb_filament`, `slicerx_kb_printer`, `slicerx_kb_troubleshoot`, `slicerx_kb_workflow`, `slicerx_kb_search`, `slicerx_kb_intent` | mimir's knowledge tools, with citations. | read |
| `slicerx_settings_plan`, `slicerx_settings_apply` | mimir's settings planner, and applying values to the plate, the project or a saved profile. | read; slice or profile |
| `slicerx_printer_list`, `slicerx_printer_status`, `slicerx_printer_snapshot` | Printers, their state and temperatures, and a camera image. | read |
| `slicerx_list_fleets`, `slicerx_create_fleet`, `slicerx_rename_fleet`, `slicerx_update_fleet`, `slicerx_delete_fleet`, `slicerx_add_to_fleet`, `slicerx_remove_from_fleet` | Fleets: optional groups of printers the user names, such as "Workshop". A printer works without a fleet and can be in several. Editing a fleet changes no printer, so it needs no approval; each edit is logged. | none |
| `slicerx_printer_profile_search`, `slicerx_printer_discover` | Find a printer model in the catalog by vendor or model text (nozzle sizes included), and scan the local network for printers. The search works everywhere; the scan needs `--printers link`. | read |
| `slicerx_printer_add` | Add a printer with its model, nozzle and connection. The user is always asked first, and the approval card shows model, nozzle and address. Needs `--printers link`, because sx-link keeps the printer list. No access code or key passes through MCP: set it in the SlicerX app or sx-link's secret store. | printer_config |
| `slicerx_printer_queue` | Upload a sliced plate to a printer and start it. | queue |
| `slicerx_printer_pause`, `slicerx_printer_resume`, `slicerx_printer_cancel` | Control the running job. | start |
| `slicerx_printer_set_temperature`, `slicerx_printer_filament`, `slicerx_printer_gcode` | Set a nozzle, bed or chamber target, load or unload filament, send one G-code line. | start |
| `slicerx_theme_get`, `slicerx_theme_create` | Built-in themes, and a brand theme for an embedded SlicerX (colors, gradient, fonts, radii, spacing) with a WCAG contrast check and the stylesheet your page loads; `save: true` writes `<name>.json` and `<name>.css` to the output folder. | read; writes only to the output folder |
| `slicerx_local_ai_check` | Whether this computer can run mimir's model locally: graphics card and its memory, system memory, cores, one recommended model with the reason in plain words, its download size and license, and a running Ollama or LM Studio (else the Ollama download page). | read |
| `slicerx_local_ai_status` | Local models installed in Ollama and LM Studio, with license and tool use for the ones SlicerX knows, and the model `slicerx_local_ai_setup` last set up. | read |
| `slicerx_local_ai_setup` | Download the recommended model (or one by id or Ollama tag) through Ollama, then check one tool call and the speed. Always asks the user first, whatever the policy says, because it uses disk and network; the approval shows the size and license. Sends progress notifications. Off when the edition config (`SLICERX_CONFIG`) sets `features.localAi` to false; `ai.allowedLocalModels` limits the models. | profile, always asks |
| `slicerx_approve`, `slicerx_pending_approvals` | Resolve approval requests (see below). | |
| `slicerx_get_policy`, `slicerx_action_log` | Show the policy and the recent log. | read |

The mimir skill and tool names come from its registry, so new skills appear here as they ship. The skill catalog is readable at `slicerx://pilot/skills`.

Resources:

- `slicerx://docs/{id}`: the install, embedding and theming guides, this README, the guide to building your own CAD app on the engine (`build-on-the-engine`), and the printer and service guides (`printers/bambu-lan`, `printers/moonraker`, `printers/creality`, `printers/snapmaker`, `printers/prusalink`, `printers/octoprint`, `printers/duet`, `printers/elegoo`, `printers/spoolman`, `printers/home-assistant`), and the settings guide and reference (`settings/guide`, `settings/reference/index` and one file per group).
- `slicerx://settings/reference` (the index), `slicerx://settings/reference/{key}` (one setting), `slicerx://settings/schema` (JSON) and `slicerx://settings/catalog` (edit rules and bounds).
- `slicerx://knowledge/{kind}/{id}`: every knowledge entry as YAML with sources.
- `slicerx://pilot/skills`: the mimir skill catalog.

### Errors and progress

A refused call has `isError: true`, text of the form `Error: <code>: <message>`, and `structuredContent.error` with the same `code` and `message`. The codes are stable, so a client can branch on them: `invalid_input`, `file_not_found`, `path_not_allowed`, `unsupported_format`, `invalid_model`, `no_such_plate`, `download_failed`, `urls_disabled`, `unknown_profile`, `invalid_settings`, `engine_unavailable`, `slice_failed`, `preflight_blocked`, `sequence_clearance`, `not_configured`, `auth_failed`, `not_invited`, `quota_exceeded`, `rate_limited`, `service_error` and `internal_error`, and for locked projects `sxlock_` followed by the format's reason (`sxlock_wrong_account`, `sxlock_offline`, `sxlock_missing_scope` and the rest). `docs/integrators/quickstart.md` says what each means.

`slicerx_slice_file`, `slicerx_estimate_file` and `slicerx_local_ai_setup` send MCP progress notifications (`notifications/progress`, progress from 0 to 1 with a message per stage) when the request carries a `progressToken`.

## Permissions

The policy file gives each class of action one of three modes:

| Class | Covers | Default |
| --- | --- | --- |
| `slice` | Orient, arrange, cut, slice and change settings inside the project | Allow |
| `queue` | Upload a plate to a printer and start it | Ask first |
| `start` | Heat or move a printer: start, pause, resume, cancel, temperatures, filament, G-code | Ask first |
| `profile` | Write a saved printer, filament or process profile, or update Spoolman inventory | Ask first |

Write it as JSON at `~/.config/slicerx/mcp-policy.json`, or pass `--policy <file>`:

```json
{
  "classes": { "slice": "allow", "queue": "ask", "start": "ask", "profile": "ask" },
  "printers": { "bay-2": { "queue": "allow", "start": "allow" } }
}
```

- `allow` runs the call and logs it. `ask` asks the user first. `off` refuses.
- `start` cannot be `allow` for every printer at once; a class-wide `allow` is treated as `ask`. Allow it per printer under `printers`, for a machine you trust to run unattended.
- A per-printer entry can loosen `ask` to `allow`, but it cannot turn on a class that is `off`.
- Unknown or malformed entries fall back to the defaults. The server reads the file at startup, and no tool can change it, so a model cannot loosen its own permissions.

### How Ask first works

1. The tool builds an approval plan: a one-line question, details, and the exact host calls it needs, such as "upload this file with this SHA-256 to bay-2, then start it".
2. If the client supports MCP elicitation, the server asks the user directly, and the call runs only if they approve.
3. Otherwise the tool returns `status: "approval_required"` with a `request_id`, the question and the details. The client shows it to the user, and only on a yes calls `slicerx_approve` with `approve: true`. Requests expire after five minutes and work once.
4. On approval the server issues a signed token bound to those exact calls. The printer connector verifies the token before it sends anything, so a token for one printer, file or command fails for any other, and a second use fails.

Some actions only a person can approve, in SlicerX or on the phone: starting a print (including a queue-start or a scheduled start), resuming one, and sending G-code (which covers temperature and filament commands). For these the tool returns `status: "needs_person"`. In link mode the card goes to sx-link together with its work (the exact file and printer for a print, the line for G-code), the hub shows it in SlicerX and on the phone, and once a person approves it the hub runs the work itself; this server never holds that token. `slicerx_pending_approvals` shows `waiting_for_person`, then `done` or `failed` when the hub reports back. `slicerx_approve` can decline such a request but not approve it, elicitation is not used, and an Allow in the policy file does not lift the rule. Pause and cancel stop a printer, so they still follow your policy here.

MCP never confirms the build plate either. Only you can mark the plate clear, in SlicerX or on the phone. `slicerx_approve` ignores a `bed_clear` argument and says so in its result.

Without elicitation, approval depends on your client asking you before it calls `slicerx_approve`. Most clients ask before every tool call by default; do not add `slicerx_approve` to a client's auto-approve list.

### Action log

Every call is appended to `<out-dir>/actions.jsonl` (or `--log <file>`): time, tool, permission class, decision (`read`, `allowed`, `approved`, `denied`, `off`, `pending`, `expired`, `failed`), who decided (`policy`, `user` or `client`), the request id, the printer, a SHA-256 of the input, and the result summary. Tokens, file contents and credentials are never written. `slicerx_action_log` returns the recent entries.

## Engines

- `sx`: the SlicerX core through its CLI, as a separate process. The server finds `sx` through `--sx-bin`, `SLICERX_SX_BIN` or `PATH`. Build it with `cargo build -p sx-cli --release` (the binary is `target/release/sx`).
- `stub`: a rough estimate from mesh volume and surface area (STL only). Results say so, its G-code holds only comments, and printers refuse it.

The mesh tools use `sx-geom`, found through `--sx-geom-bin`, `SLICERX_SX_GEOM_BIN`, the folder of `sx`, or `PATH`. Build it with `cargo build -p sx-geom --release`. Without it the `slicerx_geom_*` tools are not offered.

`--engine auto` (the default) uses `sx` when it is found and the stub otherwise. Project plates are sliced as one combined model; the core centers it on the bed.

## Cloud slicing

Off by default: the server calls no network endpoint for it, and `slicerx_cloud_slice` and `slicerx_cloud_jobs` answer that cloud slicing is not configured. An integrator who runs the SlicerX cloud service (`features.cloudSlicing` with `backend.cloudApi` in the edition config, `docs/integrating.md`) turns it on by naming the API: `--cloud-api <url>`, `SLICERX_MCP_CLOUD_API`, `SLICERX_CLOUD_API_URL`, or `SLICERX_CONFIG` naming the resolved edition config with `cloudSlicing` on. The URL must be https (http only for localhost). Each call needs an API token with the `cloud_slice` scope, read at call time from the keychain item `slicerx-cloud` (account `slicerx`; `SLICERX_MCP_CLOUD_KEY_REF` names another `slicerx-cloud-*` item) or from `SLICERX_MCP_CLOUD_TOKEN`. The token is an `sxk_` token of an account on the cloud's invite list. The tools follow the API in the edition's cloud README: `GET /v1/access` first (an uninvited account, a used up daily job limit or a model over the upload limit stop there), then `GET` and `PUT /v1/meshes/{sha256}`, `POST /v1/jobs`, `GET /v1/jobs` and `GET /v1/jobs/{id}`. The service's `not_invited` (403), upload limit (413), daily job limit and rate limit (429) answers come back as plain tool errors. G-code and preview links expire 7 days after a job finishes. Submitting is in the `slice` class.

## Locked projects

A locked project (`.sxlock`, format in `packages/sx3mf/SPEC-sxlock.md`) is an `.sx3mf` encrypted for one SlicerX account, and only that account's service hands out its key. The server needs the edition's account service: `SLICERX_CONFIG` naming the resolved edition config (`backend.supabase`), or `SLICERX_MCP_SUPABASE_URL` with `SLICERX_MCP_SUPABASE_ANON_KEY`. Without it, `slicerx_sxlock_open` and `slicerx_sxlock_export` answer that locked projects are not configured and send nothing. Each call reads an API token at call time from the keychain item `slicerx-sxlock` (account `slicerx`; `SLICERX_MCP_SXLOCK_KEY_REF` names another `slicerx-sxlock-*` item) or from `SLICERX_MCP_SXLOCK_TOKEN`. The token's scopes decide what works: `sxlock_open` to open the account's own files, `sxlock_seal` to lock files for it. Give a token only the scope it needs. Opening needs the network every time, and opened projects are written to the output folder with mode 0600. `slicerx_sxlock_inspect` reads the owner and key id from a header and needs neither. Refusals (offline, another account, a revoked key, a missing scope, a damaged file) come back as tool errors with the reason in parentheses.

## Printers

- `--printers demo` (default): five simulated printers. Nothing reaches real hardware, and approvals work exactly as they do for real printers.
- `--printers link`: real printers through `sx-link`, the SlicerX bridge on this machine. Start `sx-link` and add your printers to it. The server reads the hub's agent code from the hub's state directory (`agent-code`, mode 0600; `sx-link code --agent` shows it), so no code goes on the command line where other users could read it. Use `--link-state-dir` for another directory, or set `SLICERX_MCP_LINK_CODE`. The agent code lets the server read printers and raise approval cards; a person answers anything that starts, resumes or sends G-code in the SlicerX app or on a paired phone. Setup for each printer is in the guides at `slicerx://docs/printers/...`. Approvals for printer actions are registered with and granted by sx-link's own broker, because sx-link verifies every token before it sends anything to a printer; project and profile approvals stay with the server's broker. Tested against sx-link and the mock printers; not yet on physical printers.
- `--printers off`: no printer tools.

## Install

With npm (once `@slicerx/mcp` is published), no clone needed:

```sh
npx -y @slicerx/mcp@0.1.0 --allow-dir ~/prints
```

From a clone:

```sh
pnpm install
pnpm --filter @slicerx/mcp build        # writes packages/mcp/dist/cli.js and packages/mcp/data/
cargo build -p sx-cli --release         # optional: the real slicer instead of the stub
```

The commands below use `/path/to/slicerx`; replace it with your clone.

### Claude Desktop

Settings, Developer, Edit Config, then add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "slicerx": {
      "command": "node",
      "args": [
        "/path/to/slicerx/packages/mcp/dist/cli.js",
        "--allow-dir", "/Users/you/prints",
        "--sx-bin", "/path/to/slicerx/target/release/sx"
      ]
    }
  }
}
```

Restart Claude Desktop. Clients that support elicitation show Ask first actions as an approval prompt; others get an approval request in the conversation.

### Claude Code

```sh
claude mcp add slicerx -- node /path/to/slicerx/packages/mcp/dist/cli.js --allow-dir ~/prints
```

Over HTTP instead, with the server already running (see below):

```sh
claude mcp add --transport http slicerx http://127.0.0.1:3977/mcp --header "Authorization: Bearer $SLICERX_MCP_TOKEN"
```

### Claude Code plugin

The SlicerX plugin for Claude Code bundles this server with skills and slash commands; see [packages/claude-plugin](../claude-plugin/README.md).

### Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project) takes the same `mcpServers` block as Claude Desktop.

### Other clients

Any client that launches a stdio server can run `node /path/to/slicerx/packages/mcp/dist/cli.js`. Clients that connect to a URL use streamable HTTP:

```sh
node packages/mcp/dist/cli.js --http --port 3977 --allow-dir ~/prints
# slicerx-mcp: bearer token written to ~/.config/slicerx/mcp-http-token (mode 0600, new at every launch)
```

The endpoint is `http://127.0.0.1:3977/mcp`. Every request needs `Authorization: Bearer <token>`, on loopback too, because any process or other user on the machine can reach 127.0.0.1. The server makes a new random token at every launch and writes it to a file only you can read (`--token-file` picks the path). For a fixed token, set `SLICERX_MCP_TOKEN` in the environment. A token is never accepted on the command line, since other users can read command lines.

Clients use MCP sessions. Each session sees and approves only the requests it raised, so one client cannot approve another's. ChatGPT and other hosted assistants connect only to remote HTTPS servers, so they cannot reach a loopback address; you need a reverse proxy or tunnel you control, with `SLICERX_MCP_TOKEN` set and `--allowed-host <public name>`. Keep printer classes on Ask first or Off for any server reachable from outside your machine.

## Connect your AI agent

The panel of that name (desktop and browser) installs this server into an agent with one click where the agent allows it. It calls `installSteps(client, input)` from `@slicerx/mcp` and shows or runs what comes back.

| Agent | One click | Also offered |
| --- | --- | --- |
| Claude Desktop | `bundle`: a `slicerx.mcpb` extension with the server files; opening it installs | the `claude_desktop_config.json` entry |
| Claude Code | `command`: `claude mcp add-json slicerx '<json>' --scope user` (the desktop app runs it; the browser shows it to copy) | the plugin in `packages/claude-plugin`, or a `.mcp.json` entry |
| Cursor | `deeplink`: `cursor://anysphere.cursor-deeplink/mcp/install?name=slicerx&config=<base64>` | the `~/.cursor/mcp.json` entry |
| Codex | `command`: `codex mcp add slicerx --env ... -- <server>` | the `~/.codex/config.toml` table |
| ChatGPT | waits: ChatGPT reaches only remote HTTPS servers, so it needs the camera relay and OAuth into SlicerX (after v1) | |

`input` is `{ server: { command, args }, hubKey, linkUrl? }`: how the agent starts this server (for example `node` and the path of `cli.js` inside the app) and the hub's public key, which is pinned.

No config ever holds a secret. Each agent gets its own hub credential, kept in the OS keychain under `agentKeyRef(client)` (`slicerx-agent-<client>`, account `slicerx`), and the config only names it (`SLICERX_MCP_LINK_KEY_REF`). The server reads it at start: `security` on macOS, `secret-tool` on Linux; Windows is not supported yet. The panel's steps:

1. Ask the hub for a credential for this agent: a remembered agent client named after it (`clients.create {name, role: "agent"}`, app role only; this call is for connect to add), so it can be revoked on its own in Settings > Devices.
2. Save it in the keychain under `agentKeyRef(client)` through a desktop command. It is never shown.
3. Run or show `installSteps(client, input)[0]`.

The browser build has no keychain, so it cannot hold a per-agent credential. There the panel shows the steps and sends the person to the desktop app to finish.

## Options

| Flag | Environment | Default |
| --- | --- | --- |
| `--http` | `SLICERX_MCP_HTTP=1` | stdio |
| `--host`, `--port` | `SLICERX_MCP_HOST`, `SLICERX_MCP_PORT` | `127.0.0.1`, `3977` |
| `--token-file <path>` | `SLICERX_MCP_TOKEN_FILE`, or `SLICERX_MCP_TOKEN` for a fixed token | a new token in `~/.config/slicerx/mcp-http-token` at every launch |
| `--allowed-host <name>` | `SLICERX_MCP_ALLOWED_HOST` (comma list) | loopback names only |
| `--allow-dir <dir>` (repeat) | `SLICERX_MCP_ALLOW_DIR` (colon list) | stdio: any readable path; HTTP: none |
| `--out-dir <dir>` | `SLICERX_MCP_OUT_DIR` | `<tmp>/slicerx-mcp` |
| `--no-urls` | `SLICERX_MCP_NO_URLS=1` | URLs allowed, 256 MB limit |
| `--engine auto\|sx\|stub` | `SLICERX_MCP_ENGINE` | `auto` |
| `--sx-geom-bin <path>` | `SLICERX_MCP_SX_GEOM_BIN` or `SLICERX_SX_GEOM_BIN` | next to `sx`, then `PATH` |
| `--cloud-api <url>` | `SLICERX_MCP_CLOUD_API`, `SLICERX_CLOUD_API_URL`, or `SLICERX_CONFIG`; token from the keychain item `slicerx-cloud` or `SLICERX_MCP_CLOUD_TOKEN` | off |
| (environment only) | `SLICERX_MCP_SUPABASE_URL` and `SLICERX_MCP_SUPABASE_ANON_KEY`, or `SLICERX_CONFIG`; token from the keychain item `slicerx-sxlock` or `SLICERX_MCP_SXLOCK_TOKEN` | locked projects off |
| `--sx-bin <path>` | `SLICERX_MCP_SX_BIN` or `SLICERX_SX_BIN` | `sx` on `PATH` |
| `--printers demo\|link\|off` | `SLICERX_MCP_PRINTERS` | `demo` |
| `--link-url`, `--link-state-dir` | `SLICERX_MCP_LINK_URL`, `SLICERX_MCP_LINK_STATE_DIR`, `SLICERX_MCP_LINK_CODE`, `SLICERX_MCP_LINK_HUB_KEY` | `ws://127.0.0.1:47615`, the hub's default state directory, none, `hub-key.pub` from the state directory. The server checks the hub's signed hello against the key before it sends anything and pairs with a proof, never the code itself. |
| `--policy <file>` | `SLICERX_MCP_POLICY` | `~/.config/slicerx/mcp-policy.json` if present, else the defaults |
| `--log <file>` | `SLICERX_MCP_LOG` | `<out-dir>/actions.jsonl` |
| `--profiles-dir <dir>` | `SLICERX_MCP_PROFILES_DIR` | `~/.config/slicerx/profiles` |
| `--data-dir <dir>` | `SLICERX_MCP_DATA_DIR` or `SLICERX_DATA_DIR` | bundled `data/`, else the clone |

## Adding tools

An edition or another host can start the server in-process and add its own tools, written as mimir tools, without the base package importing them. They go through the same permission policy and approvals:

```ts
import { createContext, createSlicerxServer } from '@slicerx/mcp'
const ctx = await createContext({ extraTools: [myTool] })
await createSlicerxServer(ctx).connect(transport)
```

## Security

- Model paths must be inside `--allow-dir` when it is set. HTTP mode reads no local path until you add one.
- HTTP mode binds to 127.0.0.1, requires the bearer token on every request, and checks the Host and Origin headers against loopback names (against DNS rebinding). Each MCP session gets its own server instance and its own pending approvals; idle sessions close after an hour.
- The server never reads credentials. Printer credentials stay in the operating system keychain behind `sx-link`.
- Knowledge text, model metadata, profile names and printer replies are data. Tool output marks printer and file text as untrusted, and none of it can approve an action.

## Licensing

The server code is Apache-2.0, like the rest of SlicerX (`LICENSE-APACHE`, `NOTICE`). The published bundle also inlines the stock printer, filament and process profiles from `packages/profiles`, which come from the profile resources of OrcaSlicer and Bambu Studio and are AGPL-3.0-or-later (`dist/LICENSE-AGPL-profiles.txt`), so the package as a whole is `Apache-2.0 AND AGPL-3.0-or-later`. It contains no OrcaSlicer code. MCP clients talk to the server over stdio or HTTP as a separate program, so connecting a client places no license terms on it. See `docs/licensing.md` in the repository.

## Development

```sh
pnpm --filter @slicerx/mcp test        # tools, permissions and approvals, resources, HTTP, both engines
pnpm --filter @slicerx/mcp typecheck
pnpm --filter @slicerx/mcp dev -- --engine stub   # run from source
npx @modelcontextprotocol/inspector node packages/mcp/dist/cli.js
```

Tests that need the real core run when `target/release/sx` exists and are skipped otherwise.

Packaging: `pnpm --filter @slicerx/mcp pack` runs the build (bundles, data, self-contained declarations from `scripts/emit-types.mjs`) and writes the tarball. Pack and publish with pnpm, which applies `publishConfig.exports` (the `dist/` entries with their types) and drops the `workspace:` ranges; `npm pack --dry-run <tarball>` lists what the registry would get.

Dependencies:

- `@modelcontextprotocol/sdk` 1.31.0: the MCP server, stdio and streamable HTTP transports (MIT).
- `zod` 4.6.5: tool input schemas (MIT).
- `yaml` 2.9.1: reads the knowledge base (ISC).
- Development only: `esbuild` 0.28.2 bundles the workspace packages into `dist/cli.js`, `tsx` 4.23.15 runs from source, `vitest` 5.0.2 runs the tests, and `@types/node` 24.19.0.

## Status

Working: stdio and HTTP transports, the permission policy with elicitation and approval requests, the action log, file slicing with the `sx` engine or the stub, the MCP project with mimir's skills, the simulated printers, and every resource listed above. Theming tools build and check themes; applying one happens in your page with `applyTheme()` or `<ThemeProvider>`. Printer actions on real printers go through sx-link's broker (tested with the mock printers). Planned: publishing `@slicerx/mcp` to npm, and testing on physical printers.
