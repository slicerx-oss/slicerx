# CAD engine

SlicerX is a slicer, and its modeling tools cover what people need to make or fix a part for printing: free sketching with extrude and revolve, push and pull on a face, dimensions that stay on the model, fillet and chamfer, an editable CAD history and STEP import. The engine is mesh-first: every body is a closed triangle mesh, and there is no B-rep kernel. Sketches have no constraint solver; positions and sizes are typed.

## 1. Tools

| Tool | What it does | Engine |
| --- | --- | --- |
| Booleans | Union, difference and intersection of any closed meshes | `boolean.rs` on manifold-rust |
| Arrays | Linear, grid and circular copies as plate instances, or merged into one mesh | `array.rs`, `xform.rs` |
| Measure | Pick a point, edge, hole rim, face, cylinder or surface; read distance, angle, radius, diameter, length or area | `measure.rs` |
| Face shape tool | Pick the bed or a flat face, place a rectangle, circle, slot, polygon or text with typed dimensions, extrude it as a new body, joined, or cut | `face.rs` |
| Text | TrueType and OpenType text with kerning, as a solid or as a face shape | `outline.rs` |
| Automatic import | Repair every import, suggest a unit with an undo toast, split loose bodies | `import/auto.rs` |
| Fit check | Warn where print-in-place parts come closer than the printer can keep apart | `fit.rs` |
| Free sketch | Lines, arcs and circles with typed sizes on the bed or a face, checked for closure and crossings, with corner fillets and chamfers; extruded or revolved as a new body, joined or cut | `sketch.rs`, `sketch_corner.rs`, `face.rs` |
| Push and pull | Move a flat face along its normal, adding or cutting material | `push.rs` |
| Kept dimensions | Dimensions anchored to the model that follow later edits | `dimension.rs` |
| Fillet and chamfer | Round or bevel straight edges between flat faces, with sphere corners, and the round edge where a flat face meets a cylinder square to it (a hole's rim, a boss's root) | `edge.rs`, `edge/rim.rs`, docs/cad-fillet.md |
| Hole tool | Find a round hole from a pick (through or blind, its depth and diameter) and make it another size in place, with a counterbore or a countersink at its entry | `hole.rs` |
| Editable history | Each object keeps its CAD steps; editing a step replays the ones after it | app (`packages/app/src/cad/history`), docs/cad-history.md |
| STEP import | STEP files tessellated by occt-import-js in a worker, then repaired like any import | app (`step-worker.ts`) |

The other mesh tools are cut and split with connectors, repair, hollow, simplify, emboss, SVG extrude, primitives and calibration models.

### The cadTools switch

The switch hides the drawing tools. It is on by default. It never hides repair or simplify, and first-run setup does not ask about it. Booleans, arrays, measure, text and the face shape tool are always on.

### Design notes

- Booleans use manifold-rust 0.15.0 (Apache-2.0), a pure Rust port of Manifold with an exact engine and a robust one. A pure Rust library keeps the web and mobile builds cargo only. The engine is picked automatically: exact for clean inputs, robust for soup or self-intersecting meshes. Output is always manifold, or the call fails with a message.
- Plane cuts use the convex path in `convex.rs`, which is exact and cheap.
- A shape is its type, its dimensions and its place on the face; a free sketch is its loops. Both are stored as a history step (docs/cad-history.md), so editing one later reopens it with its numbers and replays the steps after it.
- Face frames: on the bed and on faces that look up or down, `u` is +X; on walls `u` is horizontal and `v` points up, so typed positions read the way the face is seen.
- Text uses the built-in font (Hanken Grotesk semibold, Latin subset, 24.5 KB, OFL) or any TTF or OTF file the user picks.
- Automatic import repairs each object with all its parts together, so color patches that are open on their own are not capped. Unit order: a unit the file declares, then the STL header, then size (under 0.4 reads as meters, up to 9 as inches, with high confidence when every side is a whole number of sixteenths of an inch). Loose shells are grouped: a cavity stays with the shell around it, shells that touch or overlap become parts of one object, and separate shells become separate objects. Shells that cross themselves are rebuilt one at a time, so two overlapping bodies stay two parts.

### Targets

Union of two 100k triangle meshes in 150 ms native and 500 ms in the browser. Test set: 30 hard cases (coplanar faces, near-touching, thin slivers), procedural or openly licensed.

## 2. Worker API

The engine runs in a Web Worker in the browser (`packages/geom/wasm`, loaded on the first geometry call) and natively in the desktop app. Both take the same JSON: an operation name and a request object. The app calls it through typed functions in `packages/app/src/geom/cad.ts`.

Meshes are flat (`{positions: [x, y, z, ...], indices: [a, b, c, ...]}`) or base64 STL. A mesh input can carry its plate transform as `{mesh, transform}`, where `transform` is three.js `Matrix4.elements` (16 numbers, column-major, local to world). The engine works in world millimeters. A mesh that replaces an input (a boolean result, a merged array, a join or cut) comes back in that input's local frame, so the object keeps its transform. Picks, features, face frames and new bodies are in world coordinates.

| Operation | Request | Response |
| --- | --- | --- |
| `boolean` | `op` (union, difference, intersection), `a` and `b` (lists of meshes), `options.engine` | mesh in `a[0]`'s frame, shells, volume, watertight, `report` |
| `array` | `mesh`, `spec` (linear or circular), `merge` | `transforms` per copy, `overlapping`; with `merge`, the union |
| `measure.feature` | `mesh`, `pick` (`triangle`, world `at`), `snapMm` | `feature` (point, edge, circle, plane, cylinder, surface) |
| `measure` | `a`, optional `b` (features) | distance with end points, center distance, angle, parallel, radius, diameter, length, area |
| `face.pick` | `mesh`, `triangle`, `at` | `frame`, `outline`, area, bounds, face triangles |
| `shape.profile` | `shape`, `placement`, `fontBase64` | outline polygons in the face frame, for the live preview |
| `shape.extrude` | `frame`, `shape`, `placement`, `spec` (distance, extent, flip, taper, operation), `target` | mesh, `frame` (target or world), `tool`, `report` |
| `text.mesh` | `text`, `heightMm`, `options` (size, spacing, align, kerning), `frame`, `fontBase64` | mesh, text bounds, characters the font lacks |
| `import.auto` | `data` (`base64`), `name`, `format`, `auto` (repair, split, declared unit) | objects with parts and repair counts, unit suggestion, summary sentences, warnings |
| `fit.check` | `mesh` or `meshes`, `minGapMm`, `minVerticalGapMm`, `layerHeightMm` | parts, gaps (size, limit, horizontal, vertical or fused, end points), warning sentences |
| `hole.find` | `mesh`, `triangle`, `at` (a pick on the hole's wall) | `entry` (center on the entry face, world), `axis` (out through the entry), `diameterMm`, `depthMm`, `through`; the entry is the end nearest `at` |
| `hole.apply` | `mesh`, `hole` (as `hole.find` returns it), `spec` (`diameterMm`, optional `depthMm` for a blind hole, optional `counterbore` `{diameterMm, depthMm}` or `countersink` `{diameterMm, angleDeg}`, 90 by default) | mesh in the item's frame, `report` (volume change, watertight, shells); a smaller hole or a shallower blind one first fills the old one flush with its ends |
| `resume` | `meshes` (every object with its transform) or `mesh`, `measuredHeightMm` or `failedLayer`, layer heights or `layerTopsMm` | layer to resume at, printed height, resume Z, warnings, optionally the part left to print |

Errors come back as a message the UI can show as is, for example "the cut removes the whole body".

Bundle size: the worker's wasm is under 3 MB (under 1 MB gzip). manifold-rust and its exact arithmetic add about 880 KB of code, and ttf-parser about 68 KB plus the 24.5 KB font. The main app bundle does not include it.

## 3. Print rescue

"Print the rest from this height". The person measures the part left on the bed, or reads the layer number off the printer. `resume.rs` turns that into the first layer to print again: the last layer whose top is at or below the measurement (within half the thinnest layer) counts as done, and a layer number from the printer is printed again because it is likely incomplete. When both are given and disagree by more than a layer, the measurement wins and a warning says so. Jobs that varied their layer height pass their layer tops, so the plan matches the layers that were printed.

The plate is then sliced whole, as before, with `resumeFromLayer` set. The engine writes G-code only from that layer, after a start sequence that heats and homes X and Y but not Z and draws no purge line. Walls and infill line up with what is on the bed. With `resumeZ` the G-code declares the nozzle height (G92 Z) at the top of the printed part, and the slice result carries a manual step warning to move the nozzle there first.

App calls: `planResume` and `resumeSliceOptions` in `packages/app/src/geom/resume.ts`.

## 4. Fit check

Print-in-place parts (hinges, chains, captive pins) fail when two parts print too close and fuse. `fit.rs` treats every closed shell of an object as a part, with any cavity shells inside it, and finds the exact smallest gap between each pair from triangle-to-triangle distances. A gap that runs mostly up and down is compared with the vertical limit, which defaults to the layer height because a thinner gap closes when sliced. Any other gap is compared with the clearance the person measured. The hole tolerance test measures the extra diameter where a peg fits, so the per-side gap is half of it (`gapFromHoleTolerance` in `cad.ts`). Parts that touch, cross or sit inside each other are reported as fused. Each gap comes with its two end points so the viewport can draw it.

App call: `fitCheck` in `packages/app/src/geom/cad.ts`.

## 5. Viewport

The viewport (`packages/ui/viewport`, three.js, WebGL2) has an MSAA HDR scene pass, half-resolution ambient occlusion, a selection outline, FXAA, render modes (studio, clay, xray, overhang, filament) and display styles. The look preset picks a clean studio look or a technical one. The reference device is an Apple M-series laptop.

Quality targets, each checkable:

1. Lighting: three point studio rig plus image-based ambient; matte, glossy and metallic materials that follow the filament type.
2. Edges: feature edges (crease angle 30 degrees) and silhouettes in one pass, constant pixel width, hidden edges dimmed.
3. Ambient occlusion: full quality on still frames, half resolution while moving, no halos at depth edges.
4. Shadows: a soft contact shadow on the bed per model, and an optional directional shadow in studio mode.
5. Anti-aliasing: 4x MSAA on still frames, FXAA while moving, no shimmer on thin toolpaths in Preview.
6. Camera: damped orbit with inertia, zoom to cursor, view changes animated over 150 to 250 ms, a view cube and axis gizmo that match the look presets.
7. Selection and hover: hover highlight within one frame; outlines, handles and gizmo hit areas that scale with the screen.
8. Performance: 60 fps orbit on 1 million triangles, Preview with 5 million toolpath instances at 60 fps, BVH picking under 2 ms.

## 6. Not built yet

- A constraint solver for sketches (sketches use typed sizes).
- A B-rep kernel. The engine stays mesh-first; STEP files are tessellated on import.
- A WebGPU renderer path.

## 7. Modeling operations

Push and pull, free sketch with extrude and revolve, an SVG outline on a face, and dimensions that stay on the model. Same rules as section 2: JSON in and out, world millimeters, angles in degrees, meshes flat or `{mesh, transform}`. A mesh that replaces an input comes back in that input's local frame. Errors are thrown as one plain sentence of the form `field: what is wrong`, ready to show. This section only grows; nothing in it is renamed or removed.

Shared shapes:

- `Vec2` is `[u, v]` in a face frame, `Vec3` is `[x, y, z]`.
- `FaceFrame` and `Polygon` are as `face.pick` returns them. Outer rings are counterclockwise seen from outside the face, holes clockwise.
- `MeshResult` is the usual mesh reply: `mesh`, `shells`, `triangles`, `bounds`, `volumeMm3`, `edges`, `watertight`.

### Push and pull

`face.push`: move a flat face along its normal.

| Field | Type | Notes |
| --- | --- | --- |
| `mesh` | item | the body |
| `triangle`, `at` | number, Vec3 | the pick, as for `face.pick` (world) |
| `distanceMm` | number | positive pulls out and adds material, negative pushes in and cuts. Pushing past the far side makes a hole. Not 0, at most 10000 |
| `options` | BooleanOptions | optional |

The face is the whole connected flat region `face.pick` finds, holes included. Walls run straight along the normal, as in a push and pull tool; sloped neighbors are not extended. The walls go through the face's own corners, so a face with a rounded corner moves without leaving hairline flaps at the old height. A flat face with rounds all the way round its rim is a face to pick: it meets only strips much narrower than itself, while a facet of a curved surface meets facets of its own size.

Reply: `MeshResult` in the body's local frame, plus
- `tool`: the swept prism (world),
- `operation`: `"join"` or `"cut"`,
- `report`: `volumeChangeMm3` (signed), `shells`, `watertight`, `boolean`,
- `moved`: `{frame, outline, distanceMm}` (world). Pass it to `dimension.evaluate` so dimensions on the moved face follow it.

Errors: `distanceMm: must not be zero (at most 10000 mm)`, `face: pick a flat face`, `face.push: the cut removes the whole body`.

`face.push.preview`: the prism only, no boolean, for drawing while dragging. Request `{frame, outline, distanceMm}` straight from `face.pick`. Reply `{tool, operation}`. Run `face.push` once on release.

### Sketches

A sketch is a plane plus closed loops. The plane is a `FaceFrame` (a picked face, or the bed when absent). Points are `Vec2` in that frame. There is no constraint solver: the engine checks the loops and reports problems with the loop and segment that cause them.

A loop is one of:
- `{start: Vec2, segments: Segment[]}`
- `{type: "circle", center: Vec2, diameterMm}`
- `{points: Vec2[]}`: straight sides through the points, closed back to the first

A segment starts where the previous one ended:

| Segment | Meaning |
| --- | --- |
| `{type: "line", to}` | straight to a point |
| `{type: "line", lengthMm, angleDeg}` | `angleDeg` is the direction in the plane, 0 along `u`, counterclockwise |
| `{type: "line", lengthMm, turnDeg}` | direction relative to the end of the previous segment, positive turns left; the first segment starts along `u` |
| `{type: "arc", center, sweepDeg}` | around `center`, positive counterclockwise |
| `{type: "arc", to, through}` | three point arc |
| `{type: "arc", to, radiusMm, clockwise?, large?}` | arc of that radius; `large` takes the longer of the two |
| `{type: "arc", radiusMm, sweepDeg}` | tangent to the end of the previous segment, positive turns left |

A loop is closed when its last segment ends within 0.001 mm of `start`. Loops inside loops become holes, and a loop inside a hole is an island.

`sketch.check`: request `{loops}`. Reply:
- `ok`: true when the sketch can be extruded,
- `polygons`: the filled region (Polygon[]),
- `areaMm2`,
- `loops`: per loop `{index, role: "outer" | "hole", areaMm2, lengthMm}`,
- `issues`: `{loop, segment, kind, message, at?}`. `loop` and `segment` count from 0; the message counts from 1 for people, for example "Loop 1: segment 4 crosses segment 2." Kinds: `open`, `zeroLength`, `selfCrossing`, `loopsCross`, `badArc`, `tooSmall`.

It does not throw for bad geometry, only for a request it cannot read.

New `Shape` types for `shape.profile` and `shape.extrude`:
- `{type: "sketch", loops}`. With the default placement the loops sit in the frame exactly as typed. `shape.extrude` throws the first issue's message when the sketch is not `ok`.
- `{type: "svg", svg, widthMm, toleranceMm?}`: the filled outline of SVG artwork (all colors merged), scaled to `widthMm`, centered on the placement's center, SVG up along `v`.

Both take every `ExtrudeSpec` field: `distanceMm`, `extent` (`oneSide`, `symmetric`, `twoSides`), `distance2Mm`, `flip`, `taperDeg` (draft) and `operation` (`new`, `join`, `cut`).

`sketch.revolve`: request `{frame?, loops, axis: {point: Vec2, direction: Vec2}, angleDeg?, operation?, target?}`. `angleDeg` is the sweep (default 360, up to 360), counterclockwise about `direction` by the right hand rule. The profile must stay on one side of the axis; touching it is fine. Reply as `shape.extrude`. Errors: `axis: the profile crosses the axis`, `axis: direction must not be zero`.

`sketch.snaps`: snap targets on a sketch plane. Request `{frame, outline?: Polygon[], meshes?: item[], nearMm?}`. `outline` is the picked face's outline from `face.pick`; `meshes` adds the sharp edges of those bodies that lie in the plane (within `nearMm`, default 0.01). Reply `{points: [{at, kind, radiusMm?}], edges: [{a, b}]}` with kinds `vertex`, `midpoint` and `center` (centers of circles and arcs, with their radius). `edges` is the outline with straight runs merged, for edge snaps and for drawing the projected outline.

`sketch.offset`: request `{loops}` or `{polygons}`, plus `distanceMm` (positive grows) and `join?` (`round`, default, or `miter`). Reply `{polygons, areaMm2}`. Error: `distanceMm: the offset leaves nothing`.

### Dimensions that stay on the model

Reference dimensions: they read the model and never drive it. Each end is an anchor stored in the object's local mesh frame, so moving, rotating, scaling and mirroring the object (transform changes) keep it exactly. Mesh edits re-find it.

```
Anchor    = { object: string, pick: { triangle, at: Vec3 }, snapMm: number, feature: Feature }
Dimension = { id: string, kind: "distance" | "angle" | "radius" | "diameter" | "length",
              a: Anchor, b?: Anchor, value?: number }
```

`object` is the caller's object id. `at` and `feature` (as `measure.feature` returns it) are local. `distance` and `angle` need `b`; `radius`, `diameter` and `length` read `a` alone (a circle or cylinder, or an edge for length). `value` is the last value the caller saw.

`dimension.anchor`: request `{object, mesh: item, pick: {triangle, at}, snapMm?}` with `at` in world coordinates. Reply `{anchor, feature}`: the anchor in local coordinates and the feature in world coordinates for drawing.

`dimension.evaluate`: request `{dimensions, objects: {[id]: item}, moves?: [{object, frame, outline, distanceMm}]}`. Each move is a `face.push` reply's `moved` plus the object id. Reply `{dimensions: [...]}` in the same order, each with:
- `id`, `status`: `"ok"` or `"lost"`,
- `value` and `unit` (`"mm"` or `"deg"`), `changed` (true when it differs from the stored `value` by more than 0.0005),
- `measurement`: the full `measure` reply in world coordinates (`from`, `to` and so on, for drawing),
- `a`, `b`: the anchors as found on the current mesh, to store back,
- `lost`: `["a"]`, `["b"]` or both, with `message`, for example "The face this dimension started from is gone."

An anchor is lost when its object is missing or the feature cannot be found again (same kind, same place within 0.001 mm or 0.01 degrees, after any move). A lost dimension keeps its old anchors so undo brings it back.

Project files: dimensions are saved as `Metadata/slicerx_dimensions.json` in the 3MF, `{version: 1, dimensions: Dimension[]}` with `object` set to the 3MF object id. It is a new optional part, so older files open with no dimensions and other slicers ignore it.

#### The dimensions part, exactly

`Metadata/slicerx_dimensions.json` is UTF-8 JSON, written only when the project has at least one dimension:

```json
{
  "version": 1,
  "dimensions": [
    {
      "id": "d1",
      "kind": "distance",
      "a": {
        "object": "3",
        "pick": { "triangle": 2, "at": [10, 10, 20] },
        "snapMm": 0,
        "feature": { "kind": "plane", "point": [10, 10, 20], "normal": [0, 0, 1], "areaMm2": 400 }
      },
      "b": {
        "object": "3",
        "pick": { "triangle": 0, "at": [10, 10, 0] },
        "snapMm": 0,
        "feature": { "kind": "plane", "point": [10, 10, 0], "normal": [0, 0, -1], "areaMm2": 400 }
      },
      "value": 20
    }
  ]
}
```

- `object` is the `id` of the object in `3D/3dmodel.model`; `pick.at` and `feature` are in that object's mesh coordinates, before its build item transform.
- `kind` is one of `distance`, `angle`, `radius`, `diameter`, `length`. `b` is present for `distance` and `angle` only. `value` is optional.
- A plane feature's `triangles` list may be left out when saving; it is only a hint.
- Readers ignore a `version` above the one they know and dimensions whose object is missing. On load the app runs `dimension.evaluate` once and shows lost dimensions as lost.

#### Engine notes

- Native and wasm results are byte for byte the same: every transcendental function in sx-geom goes through `fm::Fm` (the `libm` crate), and `packages/geom/clippy.toml` refuses the standard methods.
