# Changelog: sx-core `api`

All notable changes to the `sx_core::api` module. The format follows Keep a Changelog, and the module follows semver (0.x: a breaking change bumps the minor version).

## [Unreleased]

## [0.1.3] - 2026-10-10

### Added

- Partner apps: a partner app key can pause and cancel prints on its own cards through sx-link, and the MCP server takes a partner key from `SLICERX_MCP_LINK_KEY`.
- Smart layer heights (sleipnir): when a request turns `smart_layer` on and sends no layer tops, sx-core plans them itself.
- sx-geom refills flat faces with well shaped triangles after booleans, fillets and pushes.
- Viewport: a near-black silhouette round Model's parts in the CAD look, a model added to the plate fades in beside the others, the plate reveal plays in Model too, and the selected model shows move arrows.
- Embed: Prepare's tools in the embedded view (select, move, rotate, scale, arrange, drop to bed), a reveal for each plate, and an optional calm bed outline (`bedOutline: 'subtle'`).
- MCP: a slice that names no printer says so.
- Settings: stock G-code fingerprints from the presets the released slicer apps ship, so their stock start and end G-code is recognized as the maker's.
- Integrator guide: preparing a plate in the viewport and slicing it with sx.

### Changed

- MCP: a slice with no process named uses the SlicerX default process, and an opened project keeps SlicerX's engine choices, as the app does.
- Viewport: white lights and quieter plastics, so a filament keeps its hue on every face, and a softer bloom on the plate reveal.
- Faster: each object's footprint is worked out once, each layer's auto lift overhang is worked out once, an object's paint stays with its parts instead of being cut again, a layer's regions share one cut of each neighbor, mesh lookups use a faster hash, and the WebAssembly build's square roots use the module's own float instructions. The viewport lets go of its toolpath copies once they are uploaded and builds a model's paint overlay in one pass.

### Fixed

- MCP: a project's flush volumes, nozzle map and prime tower position reach the engine. Before, they were dropped and the project sliced with defaults.
- MCP: opening a Bambu Studio project with nozzle variants now gives each filament its own settings, temperatures included; before, values could shift to the wrong filament.
- The H2D's print time estimate counts the time the printer spends flushing between filaments.
- Filament use counts the filament flushed between colors, including the H2D's flush inside the printer, so totals match what the printer uses.
- Bambu Studio 2.8 projects keep their "reduce infill retraction" choice, so travels inside infill no longer retract every time.
- MCP: plate collisions are reported as collisions, with the objects and layers involved.
- Paint on an object of several parts is worked out on the object's whole layer outline, with the paint of all its parts, so colors no longer stop at the boundary between parts. Where no paint reaches, the filament of the part underneath prints.
- Painted tops and bottoms color the shell layers beyond them, as deep as the project's color penetration settings ask, and specks too small to print are dropped.
- No "plate has none" support warning for an object that has support enforcers.
- Smart layer heights end exactly on the model's top, without a sliver.
- Seam placement sees the nearest face on grazing rays, so a seam can move slightly on some painted models.
- A pulled box is a plain box again after the flat face fill.
- The camera eases to a newly opened model from the swap frame.

## [0.1.2] - 2026-10-09

### Fixed

- Bambu Studio's -1 for auto reads as the value it stands for: `raft_first_layer_expansion` as 2 mm and `tree_support_wall_count` as 0, so a project's own settings slice. The raft expansion range checks run only when the print has a raft or supports.
- `LongBridge`: a `max_bridge_length` of 0 sets no limit, so presets that ship 0 (Bambu Lab) no longer warn about every bridge; findings past the first five are counted as bridges and regions on separate lines.

## [0.1.1] - 2026-10-06

### Added

- `RequestOptions::stock_gcode_keys` (never read from JSON) and `PrintConfig::trusted_gcode_keys`: custom G-code keys a native caller checked as the maker's stock text, linted as trusted when the rest is not.

## [0.1.0] - 2026-10-05

### Added

- Custom G-code: `machine_start_gcode`, `machine_end_gcode`, `before_layer_change_gcode`, `layer_change_gcode`, `change_filament_gcode`, `filament_start_gcode`, `filament_end_gcode`, run through the placeholder language (`sx_core::template`, `api::render_gcode_template`); `options.layerGcode` for pauses, color changes and custom G-code at a layer.
- `Mesh::load` reads OBJ and AMF through `sx-geom` (cargo feature `import`, on by default, off in the web WASM build, which loads those formats with the separate `sx-geom` module), with per-part filament slots and colors.
- Parity with OrcaSlicer, found by `bench/compare/parity.py`: flow spacing between beads, connected sparse infill (`sparse_infill_anchor_max`), internal bridges (feature 16), `thick_bridges`, overhang walls only where a bead hangs completely free, the top surface only on the visible top layer, skirt (`skirt_loops`, `skirt_distance`, `skirt_height`, feature 15).
- Overhang walls (`;TYPE:Overhang wall`, speeds `overhang_1_4_speed` to `overhang_4_4_speed`, `enable_overhang_speed`), bridges (`bridge_speed`, `bridge_flow`) and `seam_position` (back, nearest, aligned, aligned_back, random). `PathInfo` gained `flow`. The reference plate's G-code and SXPV changed: walls of the leaning X are split into overhang pieces; extrusion is unchanged.
- `resume_from_layer`, `height_ranges` and per-object `settings` in the request options, `slice_shard`, `emit_gcode_with` and `EmitOptions`, `HeightRange`; new config keys `filament_flow_ratio`, `enable_pressure_advance`, `pressure_advance`.
- `project_metadata` and `ProjectMetadata`: the settings entries of a 3MF project.
- `RequestOptions::layer_tops_mm` (`options.layerTopsMm`), `build_session` and `SliceSession::with_layer_tops`: slice at explicit layer tops (sleipnir), native and WASM.
- `api` module: `load_mesh`, `slice`, `slice_range`, `emit_gcode`, `preview_buffers`, `stitch_preview`, `SliceEngine`, `SliceSession`, `PrintConfig`, the plate, output and warning types, and `validate_gcode`.
- JSON path: `SliceRequest`, `run_request`, `run_request_with` (progress reports), `SliceReport` (schema version 1), `REQUEST_SCHEMA` and `RESULT_SCHEMA`.
- `load_3mf_plates`: each plate of a Bambu or Orca project as its own mesh.
- Loaders for 3MF (core spec, production-extension component files, Bambu and Orca per-part filament slots, ZIP64), binary and ASCII STL, a quantized JSON model format, and the raw parts format (`SXMP`).
