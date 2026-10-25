# Changelog: sx CLI JSON

Changes to the `sx` command's JSON input and output. Keep a Changelog format; semver.

## [Unreleased]

### Added

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
