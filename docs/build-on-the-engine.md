# Build your own CAD app on the SlicerX engine

The modeling tools in SlicerX (sketch and extrude, revolve, push and pull, booleans, fillet and chamfer, kept dimensions, editable history) run on one engine, `sx-geom`. You can build your own CAD app or configurator on it. It is a Rust crate with no file, network or clock access in the library, so the same code runs natively, as a command line tool and as WebAssembly in a browser worker.

The engine is mesh-first: every body is a closed triangle mesh in millimeters, and every operation takes meshes and returns meshes. It has no B-rep kernel and no constraint solver. Sketches are typed geometry (lines, arcs, circles with sizes and positions), and history is a list of operations you replay.

## Ways to call it

Each takes the same JSON: an operation name and a request object, with camelCase keys, millimeters, degrees, Z up and the bed at Z = 0.

| Where | How |
| --- | --- |
| Rust | Depend on the `sx-geom` crate (`packages/geom`) and call `sx_geom::json::call(op, request_json)`, or the typed modules (`face`, `push`, `edge`, `boolean`, `sketch`) directly. |
| Browser | Build `packages/geom/wasm` (`sh packages/geom/wasm/scripts/build.sh`) and load it with `createGeom` from `packages/geom/wasm/geom.mjs`. Calls are synchronous, so run them in a Web Worker. |
| Any language | Run `sx-geom <op> --out-dir DIR < request.json`. With `--out-dir`, meshes in the reply are written as STL files and replaced by `{"stlPath": ...}`. `sx-geom ops` lists the operations. |
| AI clients | The SlicerX MCP server (`packages/mcp`) offers the same operations as `slicerx_geom_*` tools. |

Meshes go in as `{"positions": [x, y, z, ...], "indices": [a, b, c, ...]}`, as `{"stlBase64": "..."}`, or (command line only) as `{"stlPath": "..."}`. A mesh can carry its placement as `{"mesh": ..., "transform": [16 numbers]}` (column-major, local to world, as three.js `Matrix4.elements`). The engine works in world coordinates, and a mesh that replaces an input comes back in that input's local frame, so a moved or rotated object keeps its transform.

Errors are one plain sentence of the form `field: what is wrong`, ready to show to a person.

## The modeling operations

| Operation | What it does | Request |
| --- | --- | --- |
| `face.pick` | A flat face: its sketch frame, outline, area and triangles | `mesh`, `triangle`, `at` (a point on that triangle) |
| `edge.pick` | The sharp edge of a face nearest a point, whether it can be rounded, the largest radius that fits, its tangent chain and the loop around the face | `mesh`, `triangle`, `at` |
| `sketch.check` | Whether sketch loops close and do not cross, which are holes, and each problem with its loop and segment | `loops` |
| `shape.extrude` | Extrude a rectangle, circle, slot, polygon, text, free sketch or SVG outline as a new body, joined to a target or cut from it | `frame`, `shape`, `placement`, `spec`, `target` |
| `sketch.revolve` | Revolve sketch loops around an axis in their plane | `frame`, `loops`, `axis`, `angleDeg`, `operation`, `target` |
| `face.push` | Move a flat face along its normal: out adds material, in cuts | `mesh`, `triangle`, `at`, `distanceMm` |
| `boolean` | Union, difference or intersection of closed meshes | `op`, `a`, `b` |
| `edge.fillet`, `edge.chamfer` | Round or bevel straight edges between flat faces | `mesh`, `edges`, `radiusMm` or `distanceMm` |
| `sketch.fillet`, `sketch.chamfer` | Round or bevel sketch corners before extruding | `loops`, `corners`, `radiusMm` or `distanceMm` |
| `dimension.anchor`, `dimension.evaluate` | Dimensions that stay on the model and follow later edits | see `docs/cad-history.md` |
| `measure.feature`, `measure` | Distances, angles, radii and areas between picked features | `mesh`, `pick` |

Each `*.preview` variant (`face.push.preview`, `edge.fillet.preview`, `edge.chamfer.preview`) returns only the pieces to draw while the person drags or types, without the boolean. `docs/cad-fillet.md` has the full fillet and chamfer contract, and the `sx-geom` README lists the mesh tools (cut, split, repair, hollow, emboss, calibration models).

### Picking

The engine picks a face by a triangle index and a point on it. A viewport has both from its ray hit. Without a viewport, find the triangle whose plane contains the point and whose normal matches the face you mean; the MCP server's `slicerx_geom_faces` does this for AI clients.

`face.pick` returns a `frame`, `{origin, normal, u, v}`. Sketch coordinates are `[u, v]` in that frame. On the bed and on faces that look up or down, `u` is +X; on walls `u` is horizontal and `v` points up.

An edge is `{a, b, face}`: its end points and the outward normal of its first face. `edge.pick` returns it, and the fillet and chamfer operations find it again from those points, so you can store it.

### Sketches

A sketch is a plane plus closed loops:

- `{"points": [[u, v], ...]}`: straight sides, closed back to the first point
- `{"type": "circle", "center": [u, v], "diameterMm": d}`
- `{"start": [u, v], "segments": [...]}` with lines (`{"type": "line", "to": [u, v]}`, or `lengthMm` with `angleDeg` or `turnDeg`) and arcs (`center` and `sweepDeg`, three points with `through`, `radiusMm` with `clockwise` and `large`, or tangent with `radiusMm` and `sweepDeg`)

A loop inside another loop is a hole. Use the sketch as the shape `{"type": "sketch", "loops": [...]}` in `shape.extrude`.

## A minimal example

A 40 by 30 by 10 mm plate with a 6 mm hole, its top edges rounded, in a browser worker:

```js
import { createGeom } from './geom.mjs'

const geom = await createGeom(await WebAssembly.compileStreaming(fetch('sx_geom_wasm.wasm')))

// the triangle that contains `at` and faces `normal`; a viewport gets this from its ray hit
function triangleAt({ positions: p, indices: ix }, at, normal) {
  const v = (i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]]
  const sub = (a, b) => a.map((x, k) => x - b[k])
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  for (let t = 0; t < ix.length / 3; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => v(ix[3 * t + k]))
    const n = cross(sub(b, a), sub(c, a))
    const len = Math.hypot(...n)
    if (dot(n, normal) < 0.999 * len || Math.abs(dot(n, sub(at, a))) > 1e-3 * len) continue
    if ([[a, b], [b, c], [c, a]].every(([p0, p1]) => dot(cross(sub(p1, p0), sub(at, p0)), n) >= -1e-9 * len)) return t
  }
  throw new Error('no face there')
}

const up = [0, 0, 1]

// 1. extrude a rectangle from the bed
const plate = geom.call('shape.extrude', {
  shape: { type: 'rectangle', widthMm: 40, heightMm: 30 },
  placement: { center: [20, 15] },
  spec: { distanceMm: 10 },
})

// 2. pick the top face
const center = [20, 15, 10]
const top = geom.call('face.pick', { mesh: plate.mesh, triangle: triangleAt(plate.mesh, center, up), at: center })

// 3. cut a hole through it, sketched on the top face (a cut goes into the face)
const drilled = geom.call('shape.extrude', {
  frame: top.frame,
  shape: { type: 'circle', diameterMm: 6 },
  spec: { distanceMm: 10, operation: 'cut' },
  target: plate.mesh,
})

// 4. round the four top edges: pick one, then take the loop around the face
const edgeAt = [20, 0, 10]
const edge = geom.call('edge.pick', { mesh: drilled.mesh, triangle: triangleAt(drilled.mesh, edgeAt, up), at: edgeAt })
const rounded = geom.call('edge.fillet', {
  mesh: drilled.mesh,
  edges: edge.loop.filter((e) => e.supported).map((e) => e.edge),
  radiusMm: 2,
})
// rounded.mesh is watertight and ready to slice: 11,598 mm3, down from 12,000
```

The same requests work through `sx-geom` on the command line and through `sx_geom::json::call` in Rust.

## Editable history

The engine has no history of its own; your app keeps it, and the engine replays it. This is how SlicerX does it (`docs/cad-history.md` has the full model):

- An object keeps its `base` meshes and an ordered list of steps, `{op, params, transform}`. `params` is exactly the request the operation took, with the mesh left out; `transform` is the object's placement when the step ran.
- The current mesh is the replay: start from the base and run each step with `{mesh: current, transform}` and its params. Moving the object later does not disturb a step, because the engine answers in the object's local frame.
- References live in the params in the engine's own terms: a face as a point and a normal (find the triangle again on the replayed mesh), an edge as its `{a, b, face}`, a sketch plane as its frame.
- To edit step k, change its params and replay from k. A step that fails stops the replay with the engine's sentence, and the object shows the result before it, never a half-applied one.

```js
// where each operation takes the mesh it changes
const meshKey = { 'face.push': 'mesh', 'edge.fillet': 'mesh', 'edge.chamfer': 'mesh', 'shape.extrude': 'target', 'sketch.revolve': 'target', boolean: 'a' }

function replay(geom, history) {
  let mesh = history.base
  for (const step of history.steps) {
    if (step.suppressed) continue
    const params = { ...step.params }
    // a face is stored as a point and a normal; find its triangle on the mesh as it is now
    if (params.normal) params.triangle = triangleAt(mesh, params.at, params.normal)
    const key = meshKey[step.op]
    const item = { mesh, transform: step.transform }
    mesh = geom.call(step.op, { ...params, [key]: key === 'a' ? [item, ...(params.a ?? []).slice(1)] : item }).mesh
  }
  return mesh
}
```

This loop assumes the object was never moved (an identity transform), so `triangleAt` can search the local mesh. For a moved object, bring `at` and `normal` into its local frame first.

## STEP and other imports

`sx-geom` reads STL, OBJ (with colors) and AMF, and imports SVG artwork as outlines or solids. The SlicerX app reads STEP files with occt-import-js (Open CASCADE, LGPL-2.1) in a separate worker and hands the tessellated meshes to the engine; a STEP model then works with every operation above. Your app can do the same, or start from meshes it makes itself.

## License

`sx-geom` and its WebAssembly build are Apache-2.0, as is the rest of what the SlicerX contributors wrote. You can use them in open or closed source products, commercial ones included.

The NOTICE file is part of the license terms (section 4(d)). If you ship the engine or anything built on it, pass the NOTICE on and show the credit "Made possible by SlicerX", linked to https://slicerx.app/support, wherever your product shows third-party credits: an About screen, a credits page or the documentation. If it shows no such credits, put the line in a NOTICE or credits file that ships with it.

Third-party code keeps its own license: the boolean engine uses manifold-rust (Apache-2.0), and `packages/vendor` holds i_overlay with our changes. `THIRD-PARTY.md` lists everything. The names "SlicerX" and its logo are not covered by the license beyond that credit, so a product built on the engine uses its own name.
