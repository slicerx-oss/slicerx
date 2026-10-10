# Changelog

All notable changes to `@slicerx/mcp` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Slice and estimate results carry `notices`, warnings with a code. `no_printer` says the slice named no printer, so the engine used its generic machine ("No printer chosen, so this slice used a generic 200 mm machine; times and limits are not for your printer."). The same line is in `warnings`.

- Set up local AI: `slicerx_local_ai_check` (hardware, one recommended model with its reason, size and license, running Ollama or LM Studio), `slicerx_local_ai_status` (installed local models and the one set up last) and `slicerx_local_ai_setup` (an Ollama download with progress notifications, then a tool call and speed check). Setup always asks the user first. Requests go only to 127.0.0.1. An edition config turns them off (`features.localAi`) or limits the models (`ai.allowedLocalModels`).
- A tool that must ask for a particular call (`mustAsk`) now asks over MCP even when its class is set to Allow, as it does in the app.

### Changed

- License: the server code is Apache-2.0. The bundle inlines the AGPL-3.0-or-later stock profiles, so the package is `Apache-2.0 AND AGPL-3.0-or-later`, with the AGPL text in `dist/LICENSE-AGPL-profiles.txt`.
- The published `./agents` entry is built (`dist/agents.js`), and both entries ship self-contained type declarations.
- Starting, resuming or sending G-code to a printer can no longer be approved through MCP. Those requests return `needs_person` and wait for a person in SlicerX or on the phone; `slicerx_approve` can only decline them. Pause and cancel still follow the policy. `slicerx_approve` ignores `bed_clear`.
- HTTP mode requires a bearer token on every request, loopback included. A new token is written to a 0600 file at every launch, or set with `SLICERX_MCP_TOKEN`. `--token` is refused, since command lines are visible to other users.
- In link mode a person-only request is registered with its work (`approvals.register {request, work}`), and the hub's `approval.done` report shows in `slicerx_pending_approvals`.
- HTTP mode uses MCP sessions, each with its own pending approvals, so a session can list and approve only its own requests.

### Fixed

- A travel through a printer's exclusion area or the A1's nozzle wrap check corner, or within the nozzle's width of one, is now refused with `collision` like a print path there, as a `keep_out` item in `details.collisions`. The server reads sx's sentence for it ("A print path or travel enters ...") as well as the older one.
- A Bambu Studio or OrcaSlicer project sliced with `project_settings` no longer fails on its stock start G-code (the Bambu Lab A1's `M211`, `M500` and `M18`). The project's printer G-code is compared with the printer's stock text, the template SlicerX ships or any version Bambu Studio or OrcaSlicer shipped for the model, and stock text is used as it is; the result's `project_gcode` says which. Other G-code stops the call with the new `project_gcode_review` code, with the diff against the printer profile's G-code and each flagged line in `structuredContent.error.details`. The new `project_gcode: "profile"` argument slices with the printer profile's G-code instead. No tool call can choose the project's own G-code.
- `slicerx_slice_file` and `slicerx_estimate_file` slice a 3MF plate as its objects, so `print_sequence` "by object" prints each one before the next, with the nozzle lifted over the finished ones. Before, the plate became one mesh and printed layer by layer. A file is placed on the printer's own bed (`printable_area`), `project_settings` takes a plate's own print sequence, and `slicerx_inspect_project` lists it per plate. A by-object plate whose objects sit too close for the toolhead, or with an object the gantry or lid would hit, fails with the new `sequence_clearance` code.
- A user's preset that inherits from a maker profile SlicerX ships (`profile_files`, or a slot in `filaments`) no longer makes the whole slice use the strict G-code checks. G-code it inherits is the shipped text; only G-code the file sets itself is checked strictly. Before, a user's PLA preset on a Bambu Lab A1 stopped the slice with `preflight_blocked`.
- `slicerx_slice_file` and `slicerx_estimate_file` no longer refuse the start G-code of shipped printer profiles (the Bambu Lab A1's, for one). Like the app, they mark the custom G-code as trusted only when no G-code setting came from a profile SlicerX does not ship, a project file, a preset file or an override; anything else still gets the strict checks. Projects sliced through mimir (`slicerx_slice`) follow the same rule.

### Added

- The integrator kit as resources: `slicerx://docs/integrators/agents` (the guide for coding agents) and `slicerx://docs/integrators/quickstart`.
- `filaments` on `slicerx_slice_file` and `slicerx_estimate_file`: a filament profile, preset file or spool color per slot, each setting only its own slot. The `.gcode.3mf` then names the right type and color for every slot.
- A `./cli` entry, so an app finds the server with `require.resolve('@slicerx/mcp/cli')` or `import.meta.resolve`.

- For apps that build SlicerX in: `slicerx_slice_file` and `slicerx_estimate_file` take 3MF and `.sx3mf` projects with a `plate`, the project's own settings (`project_settings`), and the user's OrcaSlicer and Bambu Studio presets and preset bundles (`profile_files`). Results list filament use per slot, tool changes, the plate and the G-code's SHA-256. `output: "gcode.3mf"` writes a `.gcode.3mf` for Bambu Lab printers, with the plate picture the engine draws, and `preview: true` the SXPV preview. Both tools send progress notifications.
- `slicerx_inspect_project`: plates, saved presets, filament slots and settings of a 3MF or `.sx3mf` project.
- `slicerx_list_profiles` lists the makers' filament presets (`stock-filament:` ids) and filters by `source`.
- Stable error codes on every refused call: `Error: <code>: <message>` and `structuredContent.error`.
- Locked projects: `slicerx_sxlock_inspect`, `slicerx_sxlock_open` and `slicerx_sxlock_export`, acting for the account whose API token the server holds, within its `sxlock_open` and `sxlock_seal` scopes. Off until the edition's account service is configured.
- Cloud slicing tools `slicerx_cloud_slice` and `slicerx_cloud_jobs` against the SlicerX cloud API. Off unless `--cloud-api`, `SLICERX_CLOUD_API_URL` or an edition config with `cloudSlicing` names one; until then both answer that cloud slicing is not configured and make no network call. Jobs never name a printer. Submitting checks `GET /v1/access` first, the invite, upload and daily job limits come back as plain errors, and results say that links expire after 7 days.
- Resource `slicerx://docs/build-on-the-engine`: how to build a CAD app on sx-geom (crate, WebAssembly, JSON ops, editable history, license).
- CAD tools on sx-geom: `slicerx_geom_faces`, `slicerx_geom_face_pick`, `slicerx_geom_edge_pick` and `slicerx_geom_sketch_check` (reads), and `slicerx_geom_extrude`, `slicerx_geom_revolve`, `slicerx_geom_push_pull`, `slicerx_geom_boolean`, `slicerx_geom_fillet` and `slicerx_geom_chamfer` (slice class). Faces are given as a point and a normal; the server finds the triangle the engine picks by.
- Printer setup: `slicerx_printer_profile_search`, `slicerx_printer_discover` and `slicerx_printer_add` (approval-gated, class printer_config), backed by the printer catalog and, in link mode, sx-link. Approvals for `printer.config` are verified by this server.
- Mesh tools from sx-geom: `slicerx_geom_cut`, `slicerx_geom_split`, `slicerx_geom_orient`, `slicerx_geom_repair`, `slicerx_geom_hollow`, `slicerx_geom_emboss`, `slicerx_geom_calibration_model` and `slicerx_geom_resume_plan`, `slicerx_geom_layers_plan`, `slicerx_geom_build` and `slicerx_geom_subtract`, behind the same permission policy, and the `sample:x-mark` built-in model.
- MCP server over stdio and stateless streamable HTTP, with Host, Origin and bearer token checks.
- mimir's tool registry, hosted for MCP clients, with an in-memory project (`slicerx_project_open`, `slicerx_project_add_model`, `slicerx_project_show`, `slicerx_project_set_overrides`) and a Node slicer host.
- Theming tools: `slicerx_theme_get` and `slicerx_theme_create`, with a WCAG contrast check and an optional saved stylesheet.
- Fleet tools: list, create, rename, recolor, delete, and add or remove printers; logged, no approval needed.
- Printer tools: list, status, camera snapshot, set temperature, load and unload filament, and single G-code lines; simulated printers by default and real printers through `sx-link`.
- The permission policy (Allow, Ask first, Off per class, per-printer exceptions) read from `~/.config/slicerx/mcp-policy.json` or `--policy`, approvals through MCP elicitation or `slicerx_approve`, single-use tokens from the approval broker, and a JSONL action log.
- File tools: `slicerx_slice_file`, `slicerx_estimate_file`; settings tools: `slicerx_list_profiles`, `slicerx_get_profile`, `slicerx_plan_settings`, `slicerx_explain_setting`, `slicerx_find_settings`, `slicerx_validate_config`; `slicerx_knowledge_lookup`.
- Resources: the knowledge base, the settings schema, catalog and Markdown reference, the mimir skill catalog, and the install, embedding, theming, printer and Home Assistant guides.
- Engines: the `sx` CLI as a separate process, and a stub estimator for STL files whose output printers refuse.
