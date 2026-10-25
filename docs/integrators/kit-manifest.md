# Packed kit filenames

Run `node scripts/pack-integrator-kit.mjs <kit-folder>` to build a kit. Install the stable filenames:

```sh
npm install ./kit/slicerx-viewport.tgz ./kit/slicerx-embed.tgz ./kit/slicerx-mcp.tgz
```

The kit keeps the original versioned archives and also writes byte-identical copies with these stable names. Copies work on Windows without symlink privileges. Package metadata inside the archives keeps the actual version. A subsequent pack refreshes the stable files.

`kit-manifest.json` has `schemaVersion: 1` and a `packages` array. Each entry has `name` (for example `@slicerx/viewport`), `version`, `file` (stable filename), `archive` (versioned filename) and `sha256` (the lowercase SHA-256 of either file). Paths are relative to the manifest. Consumers should reject unknown schema versions, select entries by package name, verify the hash and record the package versions in their lockfile. Package versions may differ from each other and from the engine release.

A `files` array lists plain files at the top of the kit, each with `name` and `sha256`. Select entries by name, verify the hash, and ignore names you do not know. Today it has one:

- `defaults.json`: every setting's default, as `{ "key": [scope, value] }`, where scope is `process`, `printer` or `filament`. It is the same file the app and the engine read, and `slicerx_list_setting_defaults` returns the same values. Only `process` defaults are what the engine slices with when a config leaves a key out. `printer` and `filament` defaults are the app's starting preset, not the engine's own values. Presets, project settings and overrides win over all of them, and a project imported from another slicer's 3MF may fill a few keys it leaves out with that format's own values. A setting the engine works out for itself has no entry. Per-extruder values are arrays, such as `[0.4]`.

A vendor command that fixes filenames to 0.1.0 must switch to these stable names or read the manifest. The packer does not mislabel newer archives as version 0.1.0. This change supplies the SlicerX-side contract; it does not update another repository's vendor command. Engine-only and assets-only kits do not create a package manifest or `defaults.json`. Engine archives still use `engine/<platform>/` and `engine/SOURCE.txt`.
