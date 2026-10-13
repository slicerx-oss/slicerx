# What's new in engine 0.1.5 for integrators

[engine-v0.1.5](https://github.com/slicerx-oss/slicerx/releases/tag/engine-v0.1.5) is out, with integrator kit 0.1.4 (`@slicerx/viewport`, `@slicerx/embed` and `@slicerx/mcp` as npm tarballs) attached. This page covers what changes for apps that build SlicerX in. The full list is in `packages/core/CHANGELOG.md` under 0.1.5.

Check what you have with `sx --version` (since 0.1.4) and the `@slicerx/mcp` version in your lockfile. To pack the kit with this engine, see [quickstart.md](quickstart.md), Before you start.

## sx slice uses a project's own settings

`sx slice project.3mf` builds its config from the project's own `Metadata/project_settings.config`, so a Bambu Studio or OrcaSlicer project slices with its own printer, process and filament settings. Up to 0.1.4 it used `--config` or the engine's defaults and read only the meshes.

Layers, lowest first:

1. the engine's defaults
2. the project's settings (keys a file may never set are left out: scripts and credentials)
3. each object's own settings (below)
4. `--config`

SlicerX's engine choices the project did not change itself stay SlicerX's: aegis walls, and the precise outer wall on.

To slice as before, with the defaults or your own `--config` only, pass `--no-project-settings`.

## The settings report, and --strict

A slice can say which settings it did not use:

- **Keys this engine never reads** (`configReport.notApplied`), for example another slicer's options SlicerX has no use for.
- **Values it could not use** (`configReport.invalid`: key, value, reason). Only that one setting falls back to its default; every other key still applies.

How to ask for it:

- **Request JSON:** set `options.configReport: true` to get the report in the result's `configReport`. Without it, a value the engine cannot use refuses the whole config and names the key, as before.
- **`sx` CLI:** turns the report on for you and prints it as one block on stderr. stdout still carries only the result JSON.
- **Strict mode:** `options.strict: true`, or `--strict` on `sx slice`, refuses the slice when the report lists anything. `sx` then exits with code 3, invalid input, as for any refused config ([engine-path.md](engine-path.md) has the exit codes).
- **MCP server:** the project import report comes back as `import_report`, and `strict_settings` refuses a project with settings the engine does not use.

The desktop app showing the same report in Settings > Presets is not in this release.

## Which walls ran, and why

`sx` prints one line on stderr naming the wall generator the slice used and the reason, by the same rule the app and the MCP server use. For example:

- `sx: walls: aegis walls, kept by SlicerX; the project used Bambu's default classic` (the project inherited its generator)
- `sx: walls: classic walls, the project's own choice` (the project changed it)

To print classic walls from a project that inherited them, send `wall_generator: classic` in the request or in `--config`.

## Support settings in slicerx_inspect_project

`slicerx_inspect_project` returns the project's support settings as `support`: `enable_support`, `enforce_support_layers`, `support_*` and `tree_support_*`, as the file sets them, without slicing. It's an empty object when the project sets none. `support_filament` is the slot the file names, even when the print has fewer filaments. Since 0.1.4, a support filament past the print's filaments prints with the active one and says so in the warnings.

## Per-object settings from a project

A Bambu Studio or OrcaSlicer project can give an object settings of its own in `Metadata/model_settings.config`: layer height, supports, brim, walls, infill and the like. The engine uses them.

- **One object:** its settings are the plate's.
- **Several objects:** each slices with its own. Layer height can differ only when the plate prints by object.
- **Request settings:** an object's own settings in the request go over the file's.
- **Safety:** custom G-code and keys a file may never set are left out of object and part settings, with a warning.

## Placing objects, volumes and settings over MCP

- **`slicerx_project_add_volume`** adds a cut, a support blocker, a support enforcer or a settings modifier to an object, as a box, a cylinder or an STL, in the object's own coordinates. Alongside it:
  - `slicerx_project_move`, `slicerx_project_rotate` and `slicerx_project_scale`
  - plate tools: `slicerx_project_plate_add`, `slicerx_project_plate_remove` and `slicerx_project_move_to_plate`
  - `slicerx_project_object_settings` and `slicerx_project_height_ranges`
  - read-back of all of it in `slicerx_project_show`
- **The app's checks and project operations are MCP tools:** `slicerx_region_modifiers`, `slicerx_gcode_inspect`, `slicerx_risk_report`, `slicerx_supports`, `slicerx_mesh_repair` and the rest.
- **`slicerx_region_modifiers`** takes `apply`, `holes` and `regions`. In the app, `apply` places the plan: feature-only settings (ironing top surfaces, overhang slowdown, thin-wall detection) go on the object, each named hole gets a modifier ring 3 mm past its edge with 2 more walls, and named regions (box, cylinder or sphere) get the rest. On the MCP server's project it still returns the plan with a note that nothing was applied. Place it yourself with `slicerx_project_add_volume` and `slicerx_project_object_settings`.
- **`sx` requests** already take `volumes` (role `negative`, `support_blocker`, `support_enforcer` or `modifier`, with `settings` for a modifier) and `options.heightRanges`. That's unchanged.

## Also in 0.1.5

- MCP design tools: a client builds a part step by step (sketch and extrude, revolve, fillet, boolean, mirror, array and more) into an editable history and saves it as a 3MF. They need `sx-geom` 0.1.5 next to `sx`.
- `slicerx_geom_info` and `slicerx_geom_measure` check a model, and `sx-geom` renders one.
- Smaller MCP replies: compact text, 20 profiles a page, and a brief `printer.list` unless you ask for detail.
- Profiles for the Bambu Lab H2D Pro and X2D and the Prusa Core One L.

## Not in 0.1.5

- **Toolsets.** The MCP server still lists every tool. Listing only a core set by default, with `--toolsets all` for the rest, is not on `main` yet.
- **The app's Model verbs as tools** (duplicate, drop to bed, lay on face, rename) are not on `main` yet either.
