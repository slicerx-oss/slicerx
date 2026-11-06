### Changed

- `slicerx_design_open` 1.1.0 returns `notes`: what the engine's 3MF reader skipped or read another way, each once, and its answer text says them. There is no `notes` when the file was read whole. `@slicerx/mcp` exports `readDesignFile` (the designs plus those notes) and the `OpenedDesign` type; `readDesigns` is unchanged.

### Fixed

- `slicerx_slice_file` and `slicerx_estimate_file` with `project_settings` count the filament of a part of a type the engine does not know, since that part prints as a normal part. Before, its filament was left out.
