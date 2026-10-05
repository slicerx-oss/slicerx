# Changelog: sx CLI JSON

Changes to the `sx` command's JSON input and output. Keep a Changelog format; semver.

## [Unreleased]

### Added

- `sx metadata <project.3mf>`: the project's settings entries as JSON.
- `sx slice --request <file | ->` with `--out-dir`, result JSON with `schemaVersion` 1.
- `sx schema request` and `sx schema result`.
- Exit codes 0, 1, 2 and 3.

### Changed

- `sx slice <model>` writes the G-code to `-o` (or stdout without it, or with `-o -`). The one-line summary moved from stdout to stderr, so stdout carries nothing else.
