# Fillet and chamfer

Engine contract for rounding and beveling edges, in sx-geom (`packages/geom`) and the typed calls in `packages/app/src/geom/cad.ts`. Same rules as `docs/cad-engine.md` sections 2 and 7: JSON in and out, world millimeters, angles in degrees, meshes flat or `{mesh, transform}`. A mesh that replaces an input comes back in that input's local frame. Errors are thrown as one plain sentence of the form `field: what is wrong`, ready to show. This file only grows; nothing in it is renamed or removed.

The tool is meant for brackets, boxes and plates: round or bevel the straight edge where two flat faces meet. Left out on purpose: variable radius, setback and vertex blends beyond the simple sphere corner, edges on curved faces, and anything that needs a B-rep.

Shared shapes, as in section 7: `Vec2`, `Vec3`, `MeshResult`, `BooleanOptions`, `FaceFrame`, `SketchLoop`.

## Edges

An edge is a straight run where two flat faces meet at a sharp fold (more than 30 degrees). Collinear mesh edges between the same two faces are one edge. A face is curved when it blends into a neighbor without a sharp fold (the facets of a tessellated cylinder, for example). Edges next to a curved face are reported but cannot be filleted or chamfered.

```
EdgeRef = { a: Vec3, b: Vec3, face: Vec3, moved?: boolean }
```

`a` and `b` are the end points (world). `face` is the outward normal of the first face, the one that takes `distanceMm` in a two distance chamfer. The ops find the edge again from these, so an `EdgeRef` from `edge.pick` can be stored and sent back as it is.

`moved` is set by history replays when the ends moved with a face they lie on (docs/cad-history.md). When no edge matches the ends exactly, the ops take the sharp edge on the line through `a` and `b` that overlaps them, end to end, with `face` naming its first face as before. None fails as `edges: edge 2 moved with the face beside it and is not there any more; pick it again`, two or more as `more than one edge matches there`. `edge.pick` never sets it.

### edge.pick

Request `{mesh: item, triangle, at}`, the pick as for `face.pick` (world).

The edge is the sharp boundary edge of the picked triangle's flat face nearest to `at`. Reply:

| Field | Type | Notes |
| --- | --- | --- |
| `edge` | EdgeRef | `face` is the picked face's normal |
| `lengthMm` | number | |
| `faces` | `EdgeFace[]` | `[0]` is the picked face, `[1]` the face across the edge; only `[0]` when the mesh is open there |
| `dihedralDeg` | number | angle between the faces inside the material: below 180 for a convex edge, above 180 for a concave one |
| `convex` | boolean | convex edges lose material, concave edges gain it |
| `supported` | boolean | false when the edge cannot be filleted or chamfered |
| `reason` | string? | why not, in words, when `supported` is false |
| `maxDistanceMm` | `[number, number]` | the widest bevel that fits on each face, measured on the face from the edge |
| `maxRadiusMm` | number | the largest fillet radius that fits |
| `chain` | EdgeRef[] | the edge and the edges that continue it tangentially (turning 20 degrees or less at each corner), in order along the edge |
| `loop` | `{edge: EdgeRef, supported: boolean}[]` | every edge around the picked face's boundary ring that holds this edge, in order, so a click can take the whole loop |

`EdgeFace = {normal: Vec3, curved: boolean, triangles: number[]}`. `triangles` is for the hover highlight.

`maxDistanceMm` and `maxRadiusMm` look only at this edge. When several edges share a face, the ops check the whole set.

Errors: `edge: pick near the edge of a flat face`, `triangle: out of range`.

Reasons when not supported: "The face across the edge is curved. Fillet and chamfer work between flat faces only.", "The picked face is curved. Fillet and chamfer work between flat faces only.", "The mesh is open along this edge.", "More than two faces meet along this edge.", "The edge ends where more than three faces meet.", "The edge ends at a curved face.", "The edge meets the face at its end at too shallow an angle."

When `supported` is false, `maxDistanceMm` and `maxRadiusMm` are 0 and `chain` holds the edge alone. `maxDistanceMm` and `maxRadiusMm` are rounded down to whole micrometers.

## Chamfer and fillet

### edge.chamfer

| Field | Type | Notes |
| --- | --- | --- |
| `mesh` | item | the body |
| `edges` | EdgeRef[] | one or more |
| `distanceMm` | number | set back on the edge's first face (`face`), above 0, at most 1000 |
| `distance2Mm` | number? | set back on the second face; equal to `distanceMm` when absent |
| `options` | BooleanOptions | optional |

### edge.fillet

| Field | Type | Notes |
| --- | --- | --- |
| `mesh` | item | the body |
| `edges` | EdgeRef[] | one or more |
| `radiusMm` | number | above 0, at most 1000 |
| `toleranceMm` | number? | chord tolerance of the round, default 0.01, from 0.001 to 1 |
| `options` | BooleanOptions | optional |

The round is a tessellated circular arc tangent to both faces, with its points on the arc and its chords inside it. Its segment count follows from the chord tolerance, so a fillet removes (or a concave one adds) slightly more than the exact round, at most the chord tolerance deep.

Both ops reply with `MeshResult` in the body's local frame, plus
- `report`: `volumeChangeMm3` (signed), `shells`, `watertight`, `boolean`,
- `edges`: per edge, in request order, `{convex, dihedralDeg, lengthMm}`,
- `corners`: per corner where three filleted edges meet, `{at: Vec3, kind: "sphere"}`.

Behavior:
- Convex edges lose material, concave edges gain it. One call may mix both.
- Where chamfered or filleted edges meet at a corner, the pieces meet cleanly and the mesh stays watertight. Two edges meeting with the third edge left sharp give a mitered corner.
- A fillet corner where three filleted edges meet gets a spherical patch when the three edges have the same radius, are all convex or all concave, and no two faces at the corner meet at less than 90 degrees. Any other three edge fillet corner fails in words: `edges: the corner at (x, y, z) joins three fillets this tool cannot blend; leave one of its edges out or make it a chamfer`.
- An edge that ends against a wall stops at the wall.

Errors, all plain sentences:
- `edges: pick at least one edge`
Messages about one edge name it counting from 1:

- `edges: edge 2: no sharp edge between two flat faces there` (the edge is gone or moved)
- `edges: edge 2: more than one edge matches there; pick it again`
- `edges: edge 2: the face across the edge is curved. Fillet and chamfer work between flat faces only`, and the other reasons from `edge.pick` in the same form
- `edges: edge 2 is too short for this size`
- `edges: the corner at (x, y, z) joins more than three fillets; leave some of its edges out`
- `radiusMm: 3 mm does not fit; edges 1 and 4 would overlap on one face` (likewise `distanceMm`), when the strips of two edges that do not share an end overlap on a face
- `distanceMm: must be above 0 (at most 1000 mm)`, likewise `distance2Mm` and `radiusMm`
- `distanceMm: 6 mm does not fit on this face; at most 4.2 mm` (and `radiusMm: ...`) when the bevel or round is wider than the face next to the edge, or when two bevels on the same face would overlap
- `toleranceMm: must be from 0.001 to 1 mm`

### edge.chamfer.preview and edge.fillet.preview

The same request as the op, no boolean. Reply `{cut: Mesh, join: Mesh}` (world): the pieces that would be removed and added, ready to draw while the person drags or types. Either may be empty. Run the op once on apply. The checks and errors are the same as the op's, so a preview that fails tells the person why before they apply.

## Sketch corners

Rounding or beveling a corner of a sketch before extruding is the cheap, robust way to a rounded profile. These ops work on the sketch loops of section 7 and return new loops.

A corner is `{loop, vertex}`, counting from 0. Vertex `i` of a `{start, segments}` loop is where segment `i` starts, so vertex 0 is `start`. For `{points}` loops vertex `i` is `points[i]`. Only corners between two straight segments can be changed; circles have no corners.

`sketch.fillet`: request `{loops, corners, radiusMm}`.
`sketch.chamfer`: request `{loops, corners, distanceMm, distance2Mm?}`. `distanceMm` is cut back along the segment that ends at the corner, `distance2Mm` (default equal) along the segment that starts there.

Reply `{loops, added}`:
- `loops`: the sketch with the changed loops rewritten as `{start, segments}` using only absolute forms: `{type: "line", to}` and `{type: "arc", center, sweepDeg}`. Loops without picked corners come back unchanged.
- `added`: per corner, in request order, `{loop, segment}`: the new arc or bevel line in the returned loop.

Errors:
- `corners: pick at least one corner`
- `corners: loop 2 has no corner 7`, `corners: there is no loop 3` (counting from 1 in the message)
- `corners: corner 3 of loop 1 is listed twice`
- `loops: ...` with the first sketch issue of a loop that has a picked corner
- `corners: corner 3 of loop 1 is not between two straight lines`
- `radiusMm: 5 mm does not fit at corner 3 of loop 1; at most 2.5 mm` (also for distances, and when two rounded corners would overlap on one segment)
- `corners: corner 3 of loop 1 is straight` (no turn to round)
- `radiusMm: must be above 0 (at most 1000 mm)`, likewise the distances

## Build

`build` (section 2) returns one manifold body: the solids are unioned, so touching solids leave no non-manifold edges.

## Engine notes

- Native and wasm replies are byte for byte the same; all trigonometry goes through `fm::Fm`.
- Worker size with these ops: 2,785,746 bytes, 844,971 gzip -9 (before: 2,675,315 and 807,964, same measure).
- The ops find each edge again from its end points, so an `EdgeRef` stays valid until the mesh changes along that edge. After a fillet or chamfer, pick again.
- An end point matches a mesh vertex within 0.001 mm, or a ten millionth of the body's diagonal when that is larger (the rule dimension anchors use). From then on the ops use the mesh's own vertices, so a reference that went through JSON, a transform or a replayed history step and came back off by rounding still finds its edge. A reference that is off by more, covers only part of an edge or runs past its end fails as `no sharp edge between two flat faces there`.
- The far end of a round's arc is placed from the directions of the two faces rather than from the angle between them (cos 90 is not 0), so it lies exactly on its face, and a later push along that face leaves no hairline flap.
- The edge pieces are prisms with the bevel or round as cross section. They reach 0.01 mm past both faces, and past an end that opens to air (a convex edge) or into material (a concave one), so the boolean never meets coincident faces. Where an edge runs into a wall it stops exactly at the wall.
