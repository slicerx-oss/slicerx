# What's new in engine 0.1.5 for integrators

Engine 0.1.5 is not released yet. The latest release is [engine-v0.1.4](https://github.com/slicerx-oss/slicerx/releases/tag/engine-v0.1.4). This page lists what 0.1.5 brings for apps that build SlicerX in, so you can plan for it.

Each item says where it stands on `main`:

- **On main**: merged, and in 0.1.5 when it is cut.
- **Pending (#NNN)**: in an open pull request. It ships in 0.1.5 only if that pull request merges before the cut, and its details can still change.

Check what you have with `sx --version` (since 0.1.4) and the `@slicerx/mcp` version in your lockfile. To try a build before it's released, pack the kit from a clone ([quickstart.md](quickstart.md), Before you start).

## sx slice uses a project's own settings

Pending (#591).

`sx slice project.3mf` builds its config from the project's own `Metadata/project_settings.config`, so a Bambu Studio or OrcaSlicer project slices with its own printer, process and filament settings. Up to 0.1.4 it used `--config` or the engine's defaults and read only the meshes.

Layers, lowest first:

1. the engine's defaults
2. the project's settings (keys a file may never set are left out: scripts and credentials)
3. each object's own settings (below)
4. `--config`

SlicerX's engine choices the project did not change itself stay SlicerX's: aegis walls, and the precise outer wall on.

To slice as before, with the defaults or your own `--config` only, pass `--no-project-settings`.

## The settings report, and --strict

Pending (#640).

A slice can say which settings it did not use:

- **Keys this engine never reads** (`configReport.notApplied`), for example another slicer's options SlicerX has no use for.
- **Values it could not use** (`configReport.invalid`: key, value, reason). Only that one setting falls back to its default; every other key still applies.

How to ask for it:

- **Request JSON:** set `options.configReport: true` to get the report in the result's `configReport`. Without it, a value the engine cannot use refuses the whole config and names the key, as before.
- **`sx` CLI:** turns the report on for you and prints it as one block on stderr. stdout still carries only the result JSON.
- **Strict mode:** `options.strict: true`, or `--strict` on `sx slice`, refuses the slice when the report lists anything. `sx` then exits with code 3, invalid input, as for any refused config ([engine-path.md](engine-path.md) has the exit codes).
- **MCP server:** the project import report comes back as `import_report`, and `strict_settings` refuses a project with settings the engine does not use.
- **App:** shows the same report in Settings > Presets when it opens a project. Pending (#606).

## Which walls ran, and why

Pending (#640; the project path in #591).

`sx` prints one line on stderr naming the wall generator the slice used and the reason, by the same rule the app and the MCP server use. For example:

- `sx: walls: aegis walls, kept by SlicerX; the project used Bambu's default classic` (the project inherited its generator)
- `sx: walls: classic walls, the project's own choice` (the project changed it)
- `... set by the object's own settings` or `... set by --config`

To print classic walls from a project that inherited them, send `wall_generator: classic` in the request or in `--config`.

## Support settings in slicerx_inspect_project

Pending (#559).

`slicerx_inspect_project` returns the project's support settings as `support`: `enable_support`, `enforce_support_layers`, `support_*` and `tree_support_*`, as the file sets them, without slicing. It's an empty object when the project sets none. `support_filament` is the slot the file names, even when the print has fewer filaments. On main since 0.1.4, a support filament past the print's filaments prints with the active one and says so in the warnings.

## Per-object settings from a project

Pending (#637).

A Bambu Studio or OrcaSlicer project can give an object settings of its own in `Metadata/model_settings.config`: layer height, supports, brim, walls, infill and the like. The engine now uses them.

- **One object:** its settings are the plate's.
- **Several objects:** each slices with its own. Layer height can differ only when the plate prints by object.
- **Request settings:** an object's own settings in the request go over the file's.
- **Safety:** custom G-code and keys a file may never set are left out of object and part settings, with a warning.

## Modifier volumes

- **`slicerx_region_modifiers` is an MCP tool** (on main, #618), along with the other checks and project operations the app runs from its panels: `slicerx_gcode_inspect`, `slicerx_risk_report`, `slicerx_supports`, `slicerx_mesh_repair` and the rest. On main it plans only.
- **`slicerx_region_modifiers` with `apply`** places its plan. Pending (#667, and the MCP project side after #673).
  - Settings that only act on their feature (ironing top surfaces, overhang slowdown, thin-wall detection) go on the object.
  - Each hole you name gets a modifier ring 3 mm past its edge with 2 more walls.
  - Regions you name (box, cylinder or sphere) get the rest.
  - Anything without a place stays a plan, and the answer says so.
- **`slicerx_project_add_volume`** adds a cut, a support blocker, a support enforcer or a settings modifier to an object, as a box, a cylinder or an STL, in the object's own coordinates. Pending (#673). The same pull request adds:
  - `slicerx_project_move`, `slicerx_project_rotate` and `slicerx_project_scale`
  - plate tools: `slicerx_project_plate_add`, `slicerx_project_plate_remove` and `slicerx_project_move_to_plate`
  - `slicerx_project_object_settings` and `slicerx_project_height_ranges`
  - read-back of all of it in `slicerx_project_show`
- **The app's Model verbs as tools:** duplicate, drop to bed, lay on face and rename. Pending (not opened yet; they follow #673 and the tool list in #671).
- **`sx` requests** already take `volumes` (role `negative`, `support_blocker`, `support_enforcer` or `modifier`, with `settings` for a modifier) and `options.heightRanges`. That's unchanged.

## Toolsets: fewer tools listed by default

Pending (#671, then a toolsets pull request that is not open yet). Names can still change.

Up to 0.1.4 the MCP server lists every tool. From 0.1.5 it is planned to list only the core tools by default, so a client loads fewer tool definitions up front:

- To keep every tool listed, start the server with `--toolsets all`.
- Clients can find more tools with `slicerx_find_tools`, load a set with `slicerx_load_tools`, and run one directly with `slicerx_call`.

If your app relies on a tool outside the core set, plan to pass `--toolsets all` once 0.1.5 is out. #671 itself changes nothing clients see: it moves every server tool into one list, one file each, so the server, the command line and the docs read the same list.
