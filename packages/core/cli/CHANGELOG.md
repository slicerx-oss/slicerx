# Changelog: sx CLI JSON

Changes to the `sx` command's JSON input and output. Keep a Changelog format; semver.

## [Unreleased]

### Added

- `sx check --request <file | ->`: heimdall's plate check of a request, without slicing it. It prints `collisions` and `collisionFixes` as `sx slice` gives them, `certainty` (`sure` or `slice_decides`, one per collision), `unchecked` (`objectId`, `what`, `near`), `order` and `micros`, and exits with code 3 when a collision is sure.
- `sx project-settings`, `sx metadata` and `sx slice <project.3mf>` read a PrusaSlicer project's settings from its `Metadata/Slic3r_PE.config`: the print and filament values, on the default printer or the one `--config` names. They printed `{}` and sliced with the defaults before, so a project with support on printed none.
- `sx project-settings <project.3mf>`: the settings `sx slice <project.3mf>` takes from a project, as one JSON object on stdout to pass as a request's `config`. A 3MF without settings prints `{}`.
- Request option `projectDefaults` (boolean, default false): fills the keys `config` lacks that the app that wrote the first project file the plate names reads its own way, as `sx slice <project.3mf>` does. A Bambu Studio project gets `wipe_tower_wall_type` rib (unless the config sets `prime_tower_rib_wall`), `initial_layer_travel_acceleration` 500 and `internal_bridge_speed` 100%. stderr names the keys added. Without it a request is unchanged. `sx schema request` lists it.
- `sx call`: access the shared MCP commands, permissions and JSON read-back through the native CLI. Requires the installed tool runtime and Node.js 24+.
- Custom G-code that is the printer maker's stock text, unchanged, for the printer the settings name (`printer_settings_id`, `inherits` or `printer_model`) runs as trusted without `trustedGcode`. Cargo feature `stock-gcode`, on by default.
- `sx metadata <project.3mf>`: the project's settings entries as JSON.
- `sx slice --request <file | ->` with `--out-dir`, result JSON with `schemaVersion` 1.
- `sx slice <project.3mf>` without `--plate` on a project of more than one plate prints one stderr line with the plate count (`sx: plates: this project has 3 plates; slicing plate 1 (--plate N picks another)`). A request naming such a project without `#N` lists it in the result's `projectPlates` (`file`, `plates`, `sliced`, `text`).
- `sx schema request` and `sx schema result`.
- Exit codes 0, 1, 2 and 3.

### Changed

- A custom G-code refusal for a printer `sx` knows, whose text matches none of that printer's stock versions, adds one stderr line: the text needs a person's review, and after their yes a request sets `trustedGcode`; when only comments or spacing changed, `--script-printer <model-id> --script-firmware <flavor>` recognizes it. Not added when a refused line blocks even with `trustedGcode`. Exit code 1 as before.
- `sx slice <model>` writes the G-code to `-o` (or stdout without it, or with `-o -`). The one-line summary moved from stdout to stderr, so stdout carries nothing else.
