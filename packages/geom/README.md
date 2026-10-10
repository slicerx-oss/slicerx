# sx-geom

Mesh operations for SlicerX, in Rust: plane cuts with caps and connectors, split to fit a build volume, mesh repair, orientation analysis, hollowing with drain holes, text and logo emboss or deboss, calibration and reference model generators, and resume from a layer. Apache-2.0, written from scratch. It depends on no other workspace crate and has no file, network or clock access in the library, so it builds for `wasm32-unknown-unknown` as is.

Units are millimeters in `f64`, Z up, bed at Z = 0. Triangles are counterclockwise seen from outside. `TriMesh::from_f32` and `TriMesh::to_f32` convert to and from the `f32` buffers of `sx-core`'s `MeshPart` and the contracts' `MeshPart`.

## Rust API

| Module | Entry points |
| --- | --- |
| `cut` | `plane_cut(&TriMesh, &Plane, &CutOptions) -> CutResult` (below, above, extras such as dowels, report); `section(&TriMesh, &Plane) -> Section` |
| `split` | `split_to_fit(&TriMesh, &SplitOptions) -> SplitResult` |
| `repair` | `repair(&TriMesh, &RepairOptions) -> (TriMesh, RepairReport)` |
| `orient` | `analyze(&TriMesh, &Orientation, &OrientOptions) -> OrientReport`, `candidates`, `rank` |
| `hollow` | `hollow(&TriMesh, &HollowOptions) -> (TriMesh, HollowReport)` |
| `emboss`, `font` | `emboss_text(&TriMesh, &EmbossSpec)`, `emboss_polygons(...)`, `font::text_polygons` |
| `calib` | `generate(&CalibRequest) -> CalibModel` (objects, per-object settings, Z range overrides) |
| `resume` | `plan(&TriMesh, &ResumeRequest) -> ResumePlan`, `layer_count`, `layer_top` |
| `import` | `import_obj(bytes, name, mtl_loader, &ImportOptions)`, `import_amf`, `import_stl` -> `ImportedModel` (parts with slots and colors, unit info, bodies, `into_objects`, `scaled`), `detect_unit` |
| `simplify` | `simplify(&TriMesh, &SimplifyOptions) -> (TriMesh, SimplifyReport)`, quadric edge collapse |
| `svg` | `extrude_svg(&str, &SvgOptions) -> SvgModel` (parts per fill color) |
| `solids` | `SolidSpec` (JSON solids: box, cylinder, prism or extrude, countersink) with `to_mesh` and `to_convex` |
| `layers` | `plan_layers(&TriMesh, nozzle_mm, LayerMode, &LayerOptions) -> LayerProfile` (sleipnir) |
| `convex` | `intersect(&TriMesh, &Region)`, `subtract(&TriMesh, &ConvexSolid)`: the boolean engine behind cuts, connectors and drain holes |
| `json` | `call(op, request_json) -> response_json`, `OPERATIONS` |

How the boolean engine works is in the `convex` module docs: imprint the face planes into the mesh, keep the triangles whose material side is inside the region, then close the open edges on each face by walking the face boundary. Caps are triangulated without new vertices, so parts stay watertight.

## JSON and the `sx-geom` command

`sx-geom <op> [--out-dir DIR] < request.json` prints the response. With `--out-dir`, meshes in the response are written as STL files and replaced by `{"stlPath": ...}`. `sx-geom ops` lists the operations. Errors print `{"error": "..."}` and exit with status 1.

Meshes in requests are `{"positions": [x, y, z, ...], "indices": [...]}`, `{"stlBase64": "..."}` or, for the command only, `{"stlPath": "..."}`. In the WebAssembly module a mesh can also go in raw, `{"rawPath": "mem:N"}` (a buffer reserved with `geom_file`), and a request with `"meshOutput": "raw"` gets its meshes back the same way, each named `{"rawOut": N}` and read with `geom_out_file_ptr(N)` and `geom_out_file_len(N)` (packages/geom/wasm/src/lib.rs). Planes are `{"axis": "z", "at": 40}`, `{"point": [...], "normal": [...]}` or `{"normal": [...], "offset": d}`. All keys are camelCase.

| Operation | Request | Response |
| --- | --- | --- |
| `info` | `mesh` | vertices, triangles, bounds, volume, area, edge counts, watertight, components |
| `section` | `mesh`, `plane` | area, seam length, islands, polygons in the plane frame, the frame |
| `cut` | `mesh`, `plane`, `options.connector` (`kind`: `pin`, `dowel` or `dovetail`, `diameterMm`, `depthMm`, `toleranceMm`, `count`, `positions`) | `below`, `above`, `extras`, `report` |
| `split` | `mesh`, `options` (`buildVolumeMm`, `marginMm`, `allowRotateZ`, `connector`) | `parts` (mesh, size, rotateZ90), `cuts`, `extras`, `warnings` |
| `repair` | `mesh`, `options` | `mesh`, `report` |
| `orient.analyze` | `mesh`, `orientation` (`{"down": [...]}`, `{"matrix": [[...]]}` or `{"eulerDeg": [...]}`), `options` | overhang area, support volume, bed contact, height, footprint, score |
| `orient.rank` | `mesh`, `options`, `maxCandidates` | `ranked`, best first |
| `hollow` | `mesh`, `options` (`wallMm`, `voxelMm`, `drainHoles`) | `mesh`, `report` |
| `emboss` | `mesh`, `spec` (`text`, `point`, `normal`, `up`, `sizeMm`, `depthMm`, `mode`: `emboss` or `deboss`) | `mesh` |
| `emboss.polygons` | `mesh`, `polygons`, `point`, `normal`, `up`, `depthMm`, `mode` | `mesh` |
| `calibrate` | `{"test": "temp-tower" \| "flow" \| "pressure-advance" \| "retraction" \| "max-volumetric" \| "tolerance" \| "shrinkage" \| "feature-piece" \| "pa-line" \| "pa-pattern" \| "vfa" \| "input-shaping-freq" \| "input-shaping-damp" \| "cornering", ...}` | `objects` (mesh, offset, settings), `ranges` (zFromMm, zToMm, settings), `instructions`, `expected` |
| `resume` | `mesh`, `measuredHeightMm` or `failedLayer`, `firstLayerHeightMm`, `layerHeightMm` | `resumeLayer` (from 0), `resumeZMm`, `printedHeightMm`, `remaining` mesh |
| `layers.plan` | `mesh`, `nozzleMm`, `mode` (`quality` or `strength`), `options` (`minHeightMm`, `maxHeightMm`, `firstLayerMm`, `smoothing` (0 to 100 strength, default 70), `smoothingRadiusMm` (default eight times the thickest layer), `maxStepRatio`, `zStepMm`, `baseHeightMm`) | `layerTopsMm` (first layer first), `heightsMm`, `bounds`, `overshootMm`, `zones` (range, class, reason), `metrics` (layers and stair step against a uniform plan, and `stepChange`: layer to layer height change with and without the smoothing stage) |
| `nest.footprint` | `mesh` or `meshes`, `transform` (4x4 column major), `toleranceMm` (0.1), `minHoleMm2` (1) | `polygons` (outline seen from above, holes kept, grown at most `toleranceMm` where simplified), `hull` (exact), `areaMm2`, `bounds` |
| `nest.arrange` | `bed` (`widthMm`, `depthMm`), `items` (`id`, `polygons`, `hull`, `grow`, `reach`, `copies`), `fixed`, `zones`, `options` (`gapMm`, `safetyMm`, `rotate`, `rotationStepDeg`, `skirt`, `center`, `budget`) | `placements` (`id`, `copy`, `angleDeg`, `offset`: a point p goes to rotate(p) + offset), `leftOver`, `tooLarge`, `stats`. `nest.start`, `nest.step` (`session`, `passes`) and `nest.end` run the same search a pass at a time |
| `build` | `solids` (each `{"type": "box", "min", "max"}`, `{"type": "cylinder", "origin", "axis", "diameterMm", "heightMm"}`, `{"type": "prism"` or `"extrude", "points", "holes", "origin", "axis", "heightMm"}`), `subtract` (cutters, below) | `mesh`, `shells`, `watertight`, `edges`, `volumeMm3`, `bounds` |
| `subtract` | `mesh`, `solids` (convex cutters: box, cylinder, convex prism, `{"type": "countersink", "origin", "axis", "shaftDiameterMm", "headDiameterMm", "angleDeg", "depthMm"}`) | as `build`, plus `removedVolumeMm3` |

`build` has no union: solids that overlap stay separate shells, and `shells` says how many. `subtract` in `build` cuts every solid. A countersink's `origin` is on the surface and its `axis` points into the material.
| `import` | `data` (`{"base64"}` or `{"path"}`), `name` (format from the extension, or `format`: `obj`, `amf`, `stl`), `mtl` (inline text; else next to the OBJ), `options` (`maxColors` 16, `splitShells` true), `applyUnitGuess`, `separateObjects` | `unit` (`declared`, `detected`, `suggestedScale`, `confidence`, `reason`), `multiBody`, `bodies`, `slotColors`, `warnings`, `objects[].parts[]` (`name`, `slot`, `color`, `body`, `mesh`) |
| `simplify` | `mesh`, `options` (`targetRatio`, `targetTriangles`, `maxErrorMm`) | `mesh`, `report` (before, after, collapses, `maxErrorMm`), `watertight` |
| `remesh` | `mesh`, `coarsen` (true to take the extra vertices off straight edges and flat faces instead) | `mesh`, `changed`, `triangles`, `volumeMm3`, `watertight`: each flat face filled again with well shaped triangles, as booleans, extrudes, pushes and edge rounds now do on their own |

Import notes: OBJ vertex colors (`v x y z r g b`) win over `usemtl` `Kd` colors; colors map to slots in order of first appearance and merge by median cut past `maxColors`. AMF converts its declared unit to millimeters; OBJ and STL carry no unit, so the guess (meters under 0.4 units, inches under 9) is only applied with `applyUnitGuess`. `multiBody` is true for several OBJ objects, AMF objects or STL shells, so the caller can ask "one multi-part object or separate objects" and pass `separateObjects`. An AMF constellation is not applied.
| `extrude.svg` | `svg` (text, `{"base64"}` or `{"path"}`), `options` (`heightMm` 2, `baseMm` 0, `baseMarginMm` 2, `baseColor`, `toleranceMm` 0.02, `scale` mm per user unit, `fitWidthMm`, `fitHeightMm`, `defaultColor`, `maxColors` 16) | `parts[]` (`name`, `color`, `slot`, `areaMm2`, `watertight`, `mesh`), `slotColors`, `sizeMm`, `mmPerUnit`, `warnings` |
| `text.polygons` | `text` (at most 80 characters), `sizeMm` (cap height), `origin` (default 0,0), `align` (`center`, default, or `left`), `strokeMm` | `polygons[]` (`points`, `holes`), `bounds` (`min`, `max`) |

`text.polygons` returns the emboss font's outline as polygons in the shape `build` takes for `extrude` solids, so text can be its own part. `center` puts the middle of the outline on `origin`; `left` puts its left edge there, still centered vertically.

`extrude.svg` reads path, rect, circle, ellipse, polygon and polyline fills with transforms, nonzero and evenodd fill rules, `clipPath` and gradients (first stop color). Elements paint bottom to top and what a later element covers is cut out of the ones below, so the color parts never overlap. With no size option the SVG's own `width` (with units) sets the scale, else one user unit is one CSS pixel (0.2646 mm). The artwork's lowest corner is the origin; with a base plate the plate spans it plus the margin. Strokes, text, images, masks, filters and `use` are ignored with a warning.

The newer calibrations follow `OrcaSlicer` 2.4.2 (`calib.cpp`, `GCode.cpp`, the dialogs); Bambu Studio has only the older pressure advance line and PrusaSlicer has none of them.

- `pa-line` and `pa-pattern` are tool paths, not models: `objects` is empty and `expected.plan` holds layers of travel and extrude moves (x, y, speed, line width, pressure advance and acceleration to set before the move, flow scale) with `labels` for the printed numbers and `values` per line or chevron. Add `"gcode": {"flavor": "klipper" | "marlin" | "repRapFirmware" | "repetier" | "bambu", "filamentDiameterMm", "flowRatio", "retractionMm", ...}` to get `expected.gcode` (body G-code without start and end code). Line parameters: `start`, `step`, `count`, `slowSpeedMmS`, `fastSpeedMmS`; pattern: `start`, `end`, `step`, `wallCount`, `firstLayerSpeedMmS`, `outerWallSpeedMmS`, `outerWallAccelerationMmS2`; both take `nozzleDiameterMm`, `layerHeightMm`, `bedWidthMm`, `bedDepthMm`, `bedOriginMm`, `drawNumbers`.
- `vfa` is a one-wall tower with `ranges` setting `outer_wall_speed` per band (40 to 200 mm/s in steps of 10 every 5 mm).
- `input-shaping-freq` (15 to 110 Hz, damping 0.15, shaper `mzv`), `input-shaping-damp` (0 to 0.4 at 30 Hz) and `cornering` (`jerk` 1 to 15 mm/s or `junctionDeviation` 0 to 0.25 mm) are one-wall square towers with sharp corners. `sx-core` cannot change those firmware settings by height, so each band is in `expected.layerCommands` as `{zFromMm, zToMm, <value>, commands: [{type: inputShaping | junctionDeviation | jerkXy, ...}], gcode: {klipper, marlin, reprapFirmware, repetier}}`, and `expected.setupGcode` holds what Orca emits once at the first layer (shaper type, Klipper's `MINIMUM_CRUISE_RATIO=0`). The object settings carry Orca's keys for the test (acceleration, jerk or junction deviation off, cooling slowdown off).

Settings in calibration output use the OrcaSlicer key names the settings package already reads (`nozzle_temperature`, `filament_flow_ratio`, `pressure_advance`, `retraction_length`, `outer_wall_speed`, `spiral_mode` and others).

## Resume from a layer

Layer math matches `sx-core`'s layer plan (layer 0 is the first layer, a layer exists while its middle is below the model top). `resume` returns the first layer to print. The G-code for it comes from `sx-core` slicing the whole plate and emitting layers from that index, so the new layers line up with what is on the bed.

## Timings

Release build on the development Mac, procedural meshes of 30,000 triangles (`cargo test --release -p sx-geom --test timing -- --ignored --nocapture`):

| Operation | Time |
| --- | --- |
| Section | 0.2 ms |
| Plane cut with caps | 11 ms |
| Cut with 2 pins or 2 dowels | 31 ms |
| Cut with a dovetail | 13 ms |
| Split a 312 mm torus into 4 parts for a 180 mm bed | 31 ms |
| Repair | 15 ms |
| Orientation analysis, one orientation | 1.8 ms |
| Rank 12 orientations | 8.6 ms |
| Hollow, 2 mm wall | 19 ms |
| Deboss 12 characters on a 30k triangle face | 24 ms |
| Calibration models | 0.02 to 12 ms each |
| Resume plan with the remaining mesh | 11 ms |

## Tests

`cargo test -p sx-geom` covers every operation on procedural shapes: watertight output, volume conservation across cuts, connector volumes, fewest cuts on boxes, cut placement at a neck, hollow shell volumes against the analytic value, layer counts against `sx-core`'s reference plate, and a JSON call per operation.

## In the browser

`packages/geom/wasm` builds `sx-geom` for a Web Worker as one call entry over a plain C ABI (no wasm-bindgen): `sh packages/geom/wasm/scripts/build.sh` writes `packages/geom/wasm/pkg/sx_geom_wasm.wasm`, the full engine (3.3 MB, 976 KB gzip), and `sx_geom_core.wasm`, the core the app loads first (2.6 MB, 772 KB gzip; docs/cad-engine.md section 2). `packages/geom/wasm/geom.mjs` wraps it:

```js
import { createGeom } from './geom.mjs'
const geom = await createGeom(await WebAssembly.compileStreaming(fetch('sx_geom_wasm.wasm')))
const out = geom.call('build', { solids: [{ type: 'box', min: [0, 0, 0], max: [10, 10, 5] }] })
```

Every operation in the tables above works except `stlPath` meshes (no file access). Send meshes flat (`positions`, `indices`) or as base64 STL; `import` takes `data: {base64}`. Calls are synchronous, so run them in a worker.
