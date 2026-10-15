# Changelog: sx-core `api`

All notable changes to the `sx_core::api` module. The format follows Keep a Changelog, and the module follows semver (0.x: a breaking change bumps the minor version).

## [Unreleased]

## [0.1.6] - 2026-10-15

### Added

- The slice report's `featureFilaments`: for each plate object, the filament slots each feature (`outerWall`, `sparseInfill`, `support` and the rest, `Feature::key`) printed with, read from the sliced paths. `Feature::ALL` lists the features.
- `prepare_with`: `prepare` with progress. Preparing a session reports `Stage::Layers` as the plate, its objects and the session are ready, and stops on a cancel, and a run reports the stage on through the whole-object plans, so a host's bar moves before the first contour. `run_request_with` reports it too.

## [0.1.5] - 2026-10-13

### Added

- MCP designs: a client's modeling lands in an editable history. Open any 3MF as designs, redo, run boolean, cut, split, mirror and array as history steps, paint a design by preview and apply, and save it with its paint per triangle. With the app open, the design tools run there over the app link and wait for the person.
- MCP: slicerx_geom_info and slicerx_geom_measure check a model, sx-geom renders a model from the CLI and MCP, and slicerx_geom_array with merge false makes separate copies.
- MCP: place objects and give them their own settings, volumes and height ranges. The app's checks and project operations are tools too, and a printer's past jobs come through the hub.
- `sx slice <project.3mf>` slices with the project's own settings. 3MF projects load through sx-geom's reader, object settings included, and the sx-geom command line reads a 3MF project and the reader's mesh and paint buffers.
- Paint in the slice request, written over the model's own.
- Clean-room organic tree supports behind `organic_support_engine`, and a second lightning infill planner behind `lightning_engine`.
- The settings report says which wall generator runs and why, and lists the settings a slice does not use. A bad value loses only its own setting.
- The start G-code's extrusions are drawn with the first layer, and the start and end G-code's extrusion counts in the filament totals.
- Profiles for the Bambu Lab H2D Pro and X2D and the Prusa Core One L.

### Changed

- Faster: painted layers are cut with less work and fewer grids, side by side, within a grid budget that only steps in when memory is short. Solid fill joins are checked side by side, the time estimate reads moves ahead on other threads, and a big STL is welded without holding it three times.
- MCP: smaller replies (compact text, 20 profiles a page, plan sources on request), and printer.list is brief unless asked for detail.
- Viewport: big models build in workers, so the plate draws at once.

### Fixed

- PrusaSlicer modifiers and their settings are read instead of printed.
- On Bambu Lab printers, solid infill stays on the object's filament when only sparse infill moves. A spiral lift is one helical arc on printers that take it, with arc fitting off.
- The H2D's filament map leaves out filaments the plate never prints with.
- Painted support enforcers print under an underside that falls mid layer.
- A sliver over air narrower than half a solid line is no bridge.
- The reach, excluded-area, height and off-bed refusals count only the layers they checked, and say so.
- Viewport: line types keep clear, distinct colors (sparse infill is a clear blue), the toolpaths stay while you inspect a lowered layer, a view parked on the zoom limit stops redrawing, and the front, back, left and right views look level.
- MCP: a pick on a curved wall finds its face, and an oversized app link call reports its real error.

## [0.1.4] - 2026-10-11

### Added

- `sx --version` (and `-V`) and `sx-geom --version` print the version and exit.
- Integrator kit: the pack takes the engine release's prebuilt archives (macOS universal, Windows x64, Linux x64), checks them against SHA256SUMS.txt and lays out `engine/<platform>/{bin,lib,include}`, so an app can bundle sx without building it.
- Travels route round the printer's keep-out zones, with a nozzle-width clearance.
- On Bambu Lab printers, narrow internal solid infill is decided per piece.
- Solid surface lines join however long the turn between them is, and rectilinear solid surfaces print as one sweep.
- Each path is labelled with the object it belongs to.
- A support filament number past the project's filaments falls back to the current filament, with a warning naming the setting, the slot and the filament count.
- Viewport: move, turn and scale a multi-selection together.

### Changed

- MCP: each knowledge file is parsed once per process.
- Faster: the check for moves that pass through a printed part looks up the part by cell instead of over the whole mesh (one test plate went from 158 s to 8 s), and the viewport keeps its shader programs through a bed change.
- MCP: a slice with no process takes its supports from the printer's own preset.
- Embed: the viewport picks its quality from the graphics it finds.
- The WebAssembly build's size budget is 1056 KB gzip.

### Fixed

- A1 with timelapse: nothing wipes or primes from the timelapse park position any more. Before, a layer whose timelapse block came at its end primed at the park and the next wipe dragged back across the part (94 such moves on one test model), and the last layer's closing wipe ran from the park across the top. The last layer now ends in the same order as Bambu Studio and OrcaSlicer.
- Pilot and MCP policies: a policy never lets a print start without a person approving it; only pause and cancel go through on a policy alone.
- sx-geom: smart layer heights no longer leave a sliver layer on a part one layer tall.
- Walls no longer stop and restart where one path ends and the next begins. With "Avoid crossing walls" on, the step from the end of one wall path to the start of the next (the same point) was treated as a travel: it retracted, wiped back along the wall and lifted, then printed the next path's first move from where the wipe ended, mostly on curved outer walls where the overhang speed changes. On a 4-color figurine test model with its paint removed: classic walls went from 537 of these stops to none (short outer wall pieces 403 to 11; OrcaSlicer 13, Bambu Studio 13), Arachne-style walls from 157 to none (short open outer pieces 87 to 30; OrcaSlicer 43, Bambu Studio 37). Slice time is unchanged.
- 3MF projects: negative parts, modifiers, support blockers and support enforcers no longer print as solid parts. Part settings apply over the object's, an older project's part keeps only its own vertices, and where an enforcer and a blocker both reach, the enforcer wins.
- Painted side walls keep their color on the bottom layers and over overhangs, where an unpainted bottom face does not hold them back.
- By object, the switch to the next object's filament runs the change G-code (M620/M621 on Bambu Lab printers) and counts as a tool change.
- Layer ranges: a range over empty layers starts where the last layer with paths ended, an empty range writes neither the start nor the end of the print, every range of a by-object plate ends at the plate's top, and a range reads bridge clusters below its window the same as one range does.
- Smart layer tops that reach the model top within float noise are accepted.
- Border support goes to the object it holds up, not a neighbor beside it.
- A ledge narrower than the outer wall no longer starts in mid-air.
- A solid surface keeps its join a travel where it meets another path.
- Bambu Studio's zig-zag reads as rectilinear in every pattern key.
- sx-geom: an edge round coarsens only the faces it touches.
- Web engine: encodeParts writes the parts' paint, as the engine's raw format carries it.

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
