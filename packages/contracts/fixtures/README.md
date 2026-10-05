# packages/contracts/fixtures

JSON examples of every cross-language shape, named `<area>-<shape>.json` (`slice-request.json`, `printers-status.json`, ...). Rust serializes them and a vitest in `packages/contracts` parses them, so the TS mirror cannot drift from the Rust types unnoticed. Each file is written by the round-trip test of the Rust crate that owns the shape, and each crate writes only files with its own prefix: `slice-`, `preview-`, `pilot-`, `printers-`, `store-`, `sx3mf-`, `settings-`.
