# Changelog: sx-core `api`

All notable changes to the `sx_core::api` module. The format follows Keep a Changelog, and the module follows semver (0.x: a breaking change bumps the minor version).

## [Unreleased]

### Added

- `PlateSpec::placement` (`plate.placement`, `PlatePlacement`): `center` (the default, as before) or `keep`. With `keep`, `build_plate` refuses the plate with `Error::Config` (key `plate.placement`) when a part lands off the printable area (the config's `printable_area`, else the plate's bed from 0, 0), naming each part and how far it reaches past each edge in mm. Hosts that split a 3MF into its build items place them where the file puts them under `keep` (the `sx` CLI does). The request schema lists the field.

- `WarningCode::NoMachineProfile` (`no_machine_profile`) and `ConfigReport::warnings`: with `options.configReport` or `options.strict`, a request whose config and object settings carry no printer settings (no `printable_area` or `bed_shape`, no `machine_max_*` or `machine_min_*` keys) gets the warning in the report's `warnings` and in `configReport.warnings` (`NO_MACHINE_PROFILE` is its text). The slice still runs on the engine's defaults, and `strict` does not refuse it. The result schema lists the code and the field.

## [0.2.7] - 2026-10-30

### Added

- `RequestOptions::tool_changes` (`toolChanges`, `ToolChangeSpec`): tool changes by height or layer. From the first layer whose top reaches a change's `zMm` (or from its 0-based `layer`), every object prints in the change's 1-based `filament`, written as a normal filament change with the printer's change G-code, and with the prime tower on the tower stands up to the last change. A change applies only on a plate that prints one filament, by layer; otherwise, and for a change above the top of the print, the slice is the same as without it and has a `tool_change_skipped` warning (`WarningCode::ToolChangeSkipped`) per change. A change to the filament already printing changes nothing. `with_tool_changes` applies them to a session. The request and report schemas list the option and the code.
- `load_3mf_marks` (`ProjectMarks`): a project plate's layer marks, as `load_3mf_layer_gcode` reads them, plus its tool changes (`Metadata/custom_gcode_per_layer.xml` type 2) when the plate's stored slider mode is the one-filament mode, and a `tool_change_skipped` note for each one saved under another mode.
- `sx slice` on a 3MF plate and `sx slice --request` on a project plate (unless the request brings its own `toolChanges`) apply the project's tool changes. Before, they were left out and the whole plate printed in its first filament. Slices of such projects through `slicerx_slice_file` change accordingly.

### Changed

- A `color_change` layer mark (a request's `layerGcode`, or a project's color change, `Metadata/custom_gcode_per_layer.xml` type 0) writes the printer's pause G-code, `machine_pause_gcode` (`M400 U1` on a Bambu Lab printer, `M601` when the profile has none), so the print stops for a filament swap by hand. Before, it wrote `color_change_gcode` or `M600`; the stock A1 and P1S profiles have no color change G-code, and `M600` also brought a fan line after it. A pause or color change keeps the layer's usual lift, where the mark's layer used to move straight to its height, so the file differs from the same plate without the mark only by the pause and the progress lines. On a plate printed by object, a pause or color change by height (`zMm`) goes on each object's first layer that reaches it, where it went on the first object's only.

### Fixed

- A request's object without a transform, and a 3MF plate that is no slicer's project, go to the middle of the printable area where it does not start at 0, 0: the request's bed starts at the area's front left corner (`plate::bed_middle`). On the Snapmaker U1 (area from 0.5, 1) a 270 mm bed's middle is 135.5, 136, as `sx slice <file>` and the app place them. Before, `sx slice --request` used half the bed's size, 135, 135, so a request and a plain slice of the same file put it 0.5 mm apart in X and 1 mm in Y. `plate::centered_transform` takes the center to use.

## [0.2.6] - 2026-10-29

### Changed

- `project_config` keeps the wall generator a project inherited from its presets, on every printer, where it gave aegis walls over an inherited classic generator before. The walls note reads `classic walls, as the project has them`, and `kept` stays empty: engine-choices.json `keeps` is empty. Aegis walls the project lists as changed in `different_settings_to_system`, and any `--config` or request value, still apply. On a stock A1 project of an arch and a thin wedge, the wedge now gets gap fill on each of its 20 layers, where aegis printed none.
- A config that names no `wall_generator` (a request, `sx slice <model> --config`, or a project that names none) prints classic walls when its `printer_model` is a Bambu Lab printer, the generator every Bambu Lab preset uses, and the schema's aegis otherwise (`config::default_wall_generator`, `PrintConfig::stock_walls`). The walls note for such a config names the generator it really prints with; it said classic before, while the engine printed aegis.

### Fixed

- A preview segment whose path was not found in its layer's G-code has no G-code line (0 in `SliceRun::preview`, `extras::LINE_UNKNOWN` from `extras::relative` for a shard), where it pointed at the layer's marker line (`; CHANGE_LAYER` in a Bambu Lab file). On the A1 with classic walls, one path of the x-mark bench plate is such a path.
- A request's config, an object's or part's own settings, a height range and a project's object settings read a per-extruder value as Bambu Studio writes it for a printer with two extruders: a comma-separated string (`"50,nil"`, `"50,60"`) or a list (`["50", "nil"]`), the first slot being this extruder's value and `nil` a slot left unset. A `nil` slot keeps the value the settings had for it (an object's `"nil,60"` over a profile's 300 mm/s prints at 300 mm/s), and with none under it the setting keeps its default. This covers every number setting the engine reads, percents and line widths included. Before, an object whose speeds were `"50,nil"` stopped `sx slice --request` with exit code 3 and `sx slice <project.3mf> --plate N` with exit code 1 (`config key inner_wall_speed: unexpected value`).
- A value in an object's own settings that the engine cannot use is handled as one in the request's config, and named with its object. With `options.configReport` the object slices with the rest of its settings and the value is listed in `configReport.invalid` with the object's name in its new `object` field (`object 'slow': inner_wall_speed ("fast": unexpected value)` in the warning); `options.strict` refuses it with that list; without either the request is refused, naming the key and the object. Before, the objects' shared settings refused the request without the object's name, and on a plate of objects with different settings one object's value refused it from inside the slice.
- The config report's warning for such values says they were skipped (`2 settings had a value this engine cannot use and were skipped: ...`). It said they kept the default, which was wrong for a project's object settings, where the slice then stopped.

## [0.2.5] - 2026-10-29

### Changed

- `project_config` reads a PrusaSlicer project's width percents as that file format means them and passes them on in mm: `first_layer_extrusion_width` as a percent of the first layer height, `extrusion_width`, `external_perimeter_extrusion_width`, `perimeter_extrusion_width`, `infill_extrusion_width`, `solid_infill_extrusion_width`, `top_infill_extrusion_width` and `support_material_extrusion_width` as a percent of the layer height, and `support_material_xy_spacing` as a percent of the outer wall width (its own width, else the general width, else 1.125 times the project's own nozzle diameter). A 200% first layer width on a 0.2 mm first layer was `200%` of the nozzle (0.8 mm on a 0.4 nozzle) and is now 0.4 mm, and a percent support XY spacing, which was left out, now carries over. An object with its own `layer_height` gets these widths of its own layer height, from its own percents or the project's (and its XY spacing of its own outer wall width), and an object's own width percents are of the project's layer height when it sets none. A single object at 0.3 mm layers in a 0.1 mm project with a 150% inner wall prints 0.45 mm walls. Volume settings and the first layer width of an object are unchanged.
- `project_config` reads a PrusaSlicer project's feature widths left at 0 as that file format means them: `extrusion_width` when it is not 0 (in mm, or a percent of the layer height), else for `support_material_extrusion_width` the project's own nozzle diameter, where our 0 prints supports at `line_width` (1.125 times the nozzle). A project with every width at 0 now prints supports 0.4 mm wide on a 0.4 nozzle, not 0.45, and one with only a 0.5 mm `extrusion_width` prints its walls, infill and top surface at 0.5 mm, not 0.45 and 0.4. An object's widths at 0 follow its own general width the same way. `first_layer_extrusion_width` at 0 is unchanged.
- `project_config` reads a PrusaSlicer project's filament lift: `filament_travel_ramping_lift` 1 gives `filament_z_hop` of `filament_travel_max_lift` and `filament_z_hop_types` Slope Lift (Normal Lift when `filament_travel_slope` is 0 or 90), 0 gives `filament_z_hop` of `filament_retract_lift` and Normal Lift, and a `filament_retract_lift` with no ramping of its own gives `filament_z_hop` alone. `only_retract_when_crossing_perimeters` carries over as `reduce_infill_retraction`. Before, these were left out, so a project with the bundled MK4 or XL filament lifted nothing on the default printer; it now lifts 0.6 mm on each travel that retracts. The ramp's angle (`filament_travel_slope`) is still not read, and a printer's `travel_max_lift` is no longer read as `travel_slope` when a preset is imported.

## [0.2.4] - 2026-10-26

### Added

- `project_config` and `ProjectMetadata::project_settings` read a PrusaSlicer project's own settings (`Metadata/Slic3r_PE.config`, when the file has no `project_settings.config`): the print and filament values it may set, in our keys, through packages/settings/prusa-map.json, the table the app and the MCP server read. Printer settings, G-code and text stay the current printer's, and no engine choices or defaults are added, as the app opens such a project. `ProjectMetadata::settings_from` is `prusaslicer` for one. Before, both returned no settings for it.
- `app_missing_keys`: the keys a project's settings lack that the app that wrote it reads its own way, with their values, from `fromApp` in packages/settings/engine-choices.json. `project_config` applies them from that table instead of its own copy; what it returns is unchanged.
- `apply_project_defaults`: the same keys filled into a request's `config` from the project file it names, and `RequestOptions::project_defaults` (`projectDefaults`) for hosts that apply it. The request schema lists the option.
### Changed

- A layer height the config sets, for the plate, an object or a filament, prints as set. `max_layer_height` and `min_layer_height` no longer lower or raise it, and `clamp_config` reports `layer_height_clamped` only for a layer above the nozzle or below 0.04 mm. A 20 mm cube at 0.32 mm on a printer with a 0.28 mm maximum printed 72 layers of 0.28 mm; it now prints 63 of 0.32 mm. The two limits still bound support layers.
- `PrintConfig::check` (and so every request) refuses a layer height taller than the nozzle with `config key layer_height: layer height 0.44 mm cannot exceed the 0.4 mm nozzle diameter`, before the line width checks, which named a bridge or skin line instead. A layer height below 0.04 mm is refused with `layer height 0.03 mm is below the 0.04 mm minimum`, also on the listed path (`configReport`, projects), where it used to slice at the default 0.2 mm with a note.
- `support_line_width` is held to the layer only when support lines print (`enable_support`, or `raft_layers` of 1 or more). With support off, a 0.38 mm support line and a 0.38 mm layer were refused.

### Changed

- `project_config` gives a project that does not set `support_top_z_distance` or `support_bottom_z_distance` 0.2 for each, from `defaults` in packages/settings/engine-choices.json, as it gives `precise_outer_wall`. `sx slice <project.3mf>` prints the same G-code as before (0.2 was already the schema's default there); `sx project-settings` now lists both keys. A request with `layer_height` and no gaps keeps gaps of one layer, and `apply_project_defaults` still fills only the `fromApp` keys.

### Fixed

- An ironing flow written as a percent string (`"15%"`, as a project file writes it) prints at that percent. It printed at the 10% default; a number (15) was read right.
- `printer_structure` is part of the session key. A kept session built the collision model with the structure of its first request, so switching to or from a delta kept the old gantry rule in the report.

## [0.2.3] - 2026-10-25

### Added

- `load_3mf_items_counted`: `load_3mf_items`, and how many plates of the project have something to print, read in the same pass.

### Changed

- aegis and arachne walls simplify the wall outline and wall lines to at most the slice resolution (`resolution`, 0.012 mm on most stock profiles), but not below 0.01 mm, when `wall_maximum_deviation` is larger. A profile with a 0.001 mm resolution simplifies its walls at 0.01 mm. At the stock 0.025 mm deviation, round pegs and holes of 2 to 5 mm printed 0.02 to 0.03 mm small and their outer walls came out as 14 to 27 straight moves with no arcs; they now print within 0.018 mm of size, and with arc fitting on their outer walls come out as one to three arcs. With arc fitting off, round walls take more G-code lines (a file of round holes and pegs grew 17 percent).
- aegis walls fill thin parts: where one or two beads make up a part's whole cross section (a fin under about 1 mm, a small peg, the narrow end of a wedge), two beads each take half its thickness and one bead all of it. Before, two beads kept the ratio of the outer spacing to the outer to first inner spacing (in a 0.8 mm fin) or their own width (in a 1 mm fin or peg), and printed 0.82 and 0.83 of the material on those fins and 0.70 on a 1 mm peg with the stock walls. The walls of thicker parts, walls capped at one wall and the outer wall's place do not move.
- aegis walls (the default) with inner walls printed first follow `precise_outer_wall`: with it on (the stock setting) the first inner wall sits (outer width + inner width) / 2 from the outer wall, with it off (outer width + inner width) / 2 - (1 - pi/4) h. Before, both came out (1 - pi/4) h / 2 off (0.0215 mm at 0.2 mm layers), and gap fill and infill with them. The outer wall does not move, so part sizes, holes and pegs keep their size.

### Fixed

- `SESSION_FREE_KEYS` no longer lists 39 settings that shape paths or that building a session reads, so `session_key` changes with each and a host prepares a new session: the wall deviation, resolution and minimum lengths, `line_width`, gap fill, infill overlap and density near the bed, gyroid and model-aligned infill, bridge flow and filtering, brim combining, the skirt's filament diameter, prime tower purges and ramming, priming lines, wall direction, scarf thresholds, the head clearances of the collision check, and the filament map and extruder variant keys. `align_infill_direction_to_model` turned on for objects turned apart sliced with the infill unturned on a kept session.

## [0.2.2] - 2026-10-25

## [0.2.1] - 2026-10-24

### Added

- `load_3mf_items`: the build items of one 3MF plate, each a mesh of its own, and `is_3mf`. `Plate::items_on` makes a plate of them (one object per item, placed as the file places it) and `plate::items_transform` is the one translation they share. `set_collision_check` and `check_paths` are the collision check every slice of a plate runs, for hosts that slice a `Plate` themselves.
- `layer_gcode`: layer G-code (a request's `layerGcode`, or the marks `load_3mf_layer_gcode` reads from a project) on a session's layers, as `EmitOptions::layer_gcode` takes it.

### Changed

- Two extruder printers whose extruder variants give a process setting one value per extruder (the X2D's Bowden extruder, an H2D with a high flow nozzle) now print each filament at its own extruder's speeds and accelerations; all filaments used the first extruder's before. `PrintConfig::for_extruder` and `PrintConfig::for_slot` give the settings one extruder prints with.
- `sx slice <file.3mf>` slices each build item as an object of its own, as `sx slice --request` and the app already did: one object label per item (`EXCLUDE_OBJECT`, `M486`, and the `M624` ids on Bambu Lab printers), with its parts, modifiers and negative volumes inside it. It runs the same collision and clearance check as `--request`, refuses with exit code 3 where that check does, and takes `--allow-collisions`. It also takes the brim ears a project paints on each object. On plates of several objects the print order, travels and brims can change; single-object files change only in their label names.
- A 3MF object without a name is called `Object_<n>` (the build item's place, from 1), not after the file.
- `sx slice <project.3mf>` writes the pauses, color changes and custom G-code the project sets on the plate's layers (`Metadata/custom_gcode_per_layer.xml`), on the layers `sx slice --request` writes them. Before, only the request path read them.
- A slice of a Bambu Lab plate with more than 64 objects warns that the printer can't skip any of them, since such plates get no object labels.

### Fixed

- Bambu Lab H2D and X2D: the start and filament change G-code write -1 as the hotend id (`B` of `M620.11`, `H` of `M620 S..A`, `T..` and `M620.6`, and `M620 D`), as the maker's slicer does, instead of 0.
- Object labels no longer carry the folders a model was opened from. `load_mesh`, `load_3mf_plates` and `Mesh::from_stl` name a model by its file's name alone (of a name given with folders, by either separator, only the last part stays), and a 3MF object without a name is called `Object_<n>` (the build item's place, from 1), not after the file. `sx slice` and `sx slice --request` of a model given by its full path wrote that path into every label comment, `M486` and `EXCLUDE_OBJECT` name.

## [0.2.0] - 2026-10-22

### Changed

- `project_metadata` and `project_config` no longer fail on a `Metadata/project_settings.config` that is not JSON. An empty one is a project without settings, JSON after a byte order mark is read, and anything else (INI style lines, a damaged file) is left out with the reason in `ProjectMetadata::settings_skipped` and `ProjectConfig::skipped`. `sx slice <project.3mf>` prints that reason and slices with the other settings; `--strict` refuses such a file.

## [0.1.9] - 2026-10-19

No changes to the slicer engine in this release; see @slicerx/mcp.

## [0.1.8] - 2026-10-18

### Added

- `load_3mf_layer_gcode`: the pause, color change and custom G-code marks a project sets on a plate's layers, as `layerGcode` entries by height. `Mesh::brim_points`: the painted brim ears a project gives each object, placed where the mesh loads.

### Changed

- `sx slice --request` on a 3MF plate now takes the project's painted brim ears (per object) and its layer marks, unless the request brings its own `layerGcode` or `brimPoints`. Slices of such projects through `slicerx_slice_file` change accordingly.

## [0.1.7] - 2026-10-16

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
