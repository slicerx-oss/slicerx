# Changelog: sx-core `api`

All notable changes to the `sx_core::api` module. The format follows Keep a Changelog, and the module follows semver (0.x: a breaking change bumps the minor version).

## [Unreleased]

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
