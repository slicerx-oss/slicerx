# Fillet and chamfer

Engine contract for rounding and beveling edges, in sx-geom (`packages/geom`) and the typed calls in `packages/app/src/geom/cad.ts`. Same rules as `docs/cad-engine.md` sections 2 and 7: JSON in and out, world millimeters, angles in degrees, meshes flat or `{mesh, transform}`. A mesh that replaces an input comes back in that input's local frame. Errors are thrown as one plain sentence of the form `field: what is wrong`, ready to show. This file only grows; nothing in it is renamed or removed.

The tool is meant for brackets, boxes and plates: round or bevel the straight edge where two flat faces meet, the edges along a round on a flat face (a rounded rectangle's outline, a cone's base rim), and the round edge where a flat face meets a cylinder square to it (a hole's rim, the root of a boss, the rim of a round plate). Left out on purpose: variable radius, setback and vertex blends beyond the simple sphere corner, edges between other curved faces, and anything that needs a B-rep.

Shared shapes, as in section 7: `Vec2`, `Vec3`, `MeshResult`, `BooleanOptions`, `FaceFrame`, `SketchLoop`.

## Edges

An edge is a straight run where two flat faces meet at a sharp fold (more than 30 degrees). Collinear mesh edges between the same two faces are one edge. A face is curved when it blends into a neighbor without a sharp fold (the facets of a tessellated cylinder, for example). An edge between a flat face and one facet of a curved face works when it is picked from the flat face (see "Edges along a round"); an edge picked from a curved face, or between two curved faces, is reported but cannot be filleted or chamfered.

```
EdgeRef = { a: Vec3, b: Vec3, face: Vec3, moved?: boolean }
```

`a` and `b` are the end points (world). `face` is the outward normal of the first face, the one that takes `distanceMm` in a two distance chamfer. The ops find the edge again from these, so an `EdgeRef` from `edge.pick` can be stored and sent back as it is.

### Round edges

A round edge is the closed circle where a flat face meets a cylinder whose axis is square to it, all the way round: the rim of a hole, the root of a boss, the rim of a round plate. The faces come from the mesh's face ids, or are found from the mesh when it has none (a cylinder is recognized when its facets lie on one). Its reference adds the circle's center:

```
EdgeRef = { a: Vec3, b: Vec3, face: Vec3, center: Vec3 }
```

`face` is the flat face's outward normal, `a` a corner of the circle (the same one whichever triangle was picked) and `b` the same point; the radius is `a`'s distance from the axis through `center` along `face`. `edge.pick` returns it with `lengthMm` the circumference, `chain` the edge alone and `loop` the edge alone. `maxDistanceMm` is how far the flat face reaches from the rim (to its nearest other edge on that side of the circle, or to the middle) and how far the cylinder runs from it. A chamfer's `distanceMm` is on the flat face and `distance2Mm` down the cylinder. The tool is the straight edge's cross section turned once around the axis, in as many steps as the rim has sides and starting at one of its corners, so it follows the hole's own facets. A chamfer's bevel comes out as a cone face. A size that would reach past the middle of the circle fails as `edges: edge 1 is a round edge 8.000 mm across; this size reaches past its middle`; a round edge that is gone (a history replay changed the part) as `edges: edge 1 is a round edge that is not there any more; pick it again`. When the face a rim sits on moves in a replay, its corner and center move with it.

### Edges along a round

A straight edge on a flat face may run on into a curved face: a side of a rounded rectangle into its corner, one side of a cone's base rim into the next. When the next side of the round along the flat face turns less than 30 degrees from the edge and meets the flat face at the same angle as the edge's own faces (within 0.0001 radians), the edge ends on the plane halfway between it and that next side. That plane holds the line between the two faces across, so the edge's tool meets the next side's exactly. Edges picked together that meet that way, from the same flat face, become one tool: the edge's cross section swept along them and mitered at each joint, with its ends as for one edge, or closed with no ends when they make a whole loop. An edge picked alone stops on that plane.

`edge.pick` reports these edges as supported, and its `chain` runs on through a round, so the loop of a rounded box's top is supported all the way round. When the angle between the faces changes along the round (a sloped top over a rounded outline), the edge is not supported, and neither is an edge that ends at a curved face it does not run into smoothly (the tip of a C, an edge running square into a boss). A keyed edge whose two faces meet along a curve (a flat face and a round, which share no one straight edge) is found again by its place on that curve.

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
| `chainMaxDistanceMm` | `[number, number]` | the widest bevel every edge of `chain` takes, each side as in `maxDistanceMm` |
| `chainMaxRadiusMm` | number | the largest fillet radius every edge of `chain` takes |
| `loopMaxDistanceMm` | `[number, number]` | the widest bevel every supported edge of `loop` takes |
| `loopMaxRadiusMm` | number | the largest fillet radius every supported edge of `loop` takes |
| `chain` | EdgeRef[] | the edge and the edges that continue it tangentially (turning 20 degrees or less at each corner), in order along the edge |
| `loop` | `{edge: EdgeRef, supported: boolean}[]` | every edge around the picked face's boundary ring that holds this edge, in order, so a click can take the whole loop |

`EdgeFace = {normal: Vec3, curved: boolean, triangles: number[]}`. `triangles` is for the hover highlight.

`maxDistanceMm` and `maxRadiusMm` look only at this edge. When several edges share a face, the ops check the whole set.

The chain and loop sizes are the least of the same per edge test over those edges: a fillet or chamfer of the chain, or of the loop's supported edges, at that size or less passes the per edge fit, and a size above it is refused as `does not fit on this face`. Two strips that overlap on one face are still checked by the op on the set.

An edge on the loop is supported exactly when the op takes it: two faces that meet at less than 30 degrees are not an edge for either ("The faces along this edge meet at less than 30 degrees, too flat to round.").

Errors: `edge: pick near the edge of a flat face`, `triangle: out of range`.

Reasons when not supported: "Both faces along this edge are curved. Fillet and chamfer need a flat face on one side.", "The picked face is curved. Pick the edge from the flat face on its other side.", "The mesh is open along this edge.", "More than two faces meet along this edge.", "The edge ends where more than three faces meet.", "The edge ends at a curved face it does not run into smoothly.", "The angle between the faces changes along the round the edge runs into.", "The edge meets the face at its end at too shallow an angle."

When `supported` is false, `maxDistanceMm` and `maxRadiusMm` are 0 and `chain` holds the edge alone. `maxDistanceMm` and `maxRadiusMm` are rounded down to whole micrometers.

The chain and loop sizes are 0 when `supported` is false, and rounded down to whole micrometers like the edge's own.

## Chamfer and fillet

### edge.chamfer

| Field | Type | Notes |
| --- | --- | --- |
| `mesh` | item | the body |
| `edges` | EdgeRef[] | one or more |
| `distanceMm` | number | set back on the edge's first face (`face`), above 0, at most 1000 |
| `distance2Mm` | number? | set back on the second face; equal to `distanceMm` when absent |
| `allOrNothing` | boolean? | default true: any edge that fails fails the call. false: the edges that fail are left as they were and listed in `skipped` (see below) |
| `options` | BooleanOptions | optional |

### edge.fillet

| Field | Type | Notes |
| --- | --- | --- |
| `mesh` | item | the body |
| `edges` | EdgeRef[] | one or more |
| `radiusMm` | number | above 0, at most 1000 |
| `toleranceMm` | number? | chord tolerance of the round, default 0.01, from 0.001 to 1 |
| `allOrNothing` | boolean? | as for `edge.chamfer` |
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
- An edge listed more than once (the same ends either way round, or the same round edge) is cut once; `notes` says so, as `edge 2 is edge 1 again and was taken once`, and `refs` still has one entry per edge asked for.

With `allOrNothing: false` an edge that fails is left as it was and the rest are cut. The reply then always has `skipped`, empty when every edge was cut: `{index, code, message}` per edge left, `index` counting from 0 in request order and `message` the sentence the call would have failed with. `notes` adds `edge 3 was left as it was: ...` for each. When a failure names several edges (two strips that overlap, a corner it cannot blend), the last of them is left out and the rest tried again, so a corner keeps two of its three rounds. A call that can cut none of its edges fails as the first edge did. Absent, the call is all or nothing as before, byte for byte.

| Code | When |
| --- | --- |
| `does_not_fit` | the size is wider than the face beside the edge, or the edge is too short for it |
| `overlap` | its strip would overlap another edge's on one face |
| `corner` | a corner of three or more rounds it cannot blend |
| `round_join` | edges along a round picked from different faces, or one point of a round named more than twice |
| `not_found` | no sharp edge there any more, or more than one matches (pick it again) |
| `face_reference` | a face key the edge was kept by is missing or split |
| `unsupported` | any other reason `edge.pick` gives for not supporting the edge |

A history step keeps `allOrNothing` as given and, once it has run, `skipped`: the indexes it left out when it was made. A replay that leaves out the same edges is quiet; one that leaves out others (an earlier step changed so a round no longer fits) is still done, and its status note reads `This step now leaves edges 2, 5 as they were; when it was made it left 2.` Each step status of such a step has `skipped` with the codes of this replay.

Errors, all plain sentences:
- `edges: pick at least one edge`
Messages about one edge name it counting from 1:

- `edges: edge 2: no sharp edge between two flat faces there` (the edge is gone or moved)
- `edges: edge 2: more than one edge matches there; pick it again`
- `edges: edge 2: the picked face is curved. Pick the edge from the flat face on its other side`, and the other reasons from `edge.pick` in the same form
- `edges: edges 1 and 2 meet along a round; pick both from the flat face they share`, and `edges: edges 1, 2 and 3 meet at one point along a round; pick each edge once`
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

## Through the MCP

`slicerx_geom_edge_pick` returns `loopRef` and `chainRef` first: `{set: "loop" | "chain", at, normal}`, the picked face's point and normal, which `slicerx_geom_fillet` and `slicerx_geom_chamfer` take in `edges` beside single edges, with `loopEdges` and `chainEdges` saying how many edges each names. The per-edge `chain` and `loop` lists come only with `list_edges: true`. The ops pick a reference again on the part as it is when the step is made (the flat face facing `normal` nearest `at`, within 25 mm) and store the edges it names, so a step keeps plain edges and replays as before. A reference picked before an earlier round ate into its face still finds the face; a single edge that round moved is refused with `pick it again`, and the refusal says a loopRef or chainRef holds. One reference stands for any number of edges, so a whole outline of 300 edges is one entry, and the 256 entry cap of `edges` is not raised.

The MCP ops default to `all_or_nothing: false`, store `allOrNothing` on the step, and always reply with `skipped` (`index` in the step's edges, `input` the entry of `edges` it came from, `code`, `message`). `slicerx_design_steps` lists a step's `skipped` beside its state. The app's fillet tool sends no `allOrNothing`, so it stays all or nothing.

## Build

`build` (section 2) returns one manifold body: the solids are unioned, so touching solids leave no non-manifold edges.

## Engine notes

- Native and wasm replies are byte for byte the same; all trigonometry goes through `fm::Fm`.
- Worker size with these ops: 2,785,746 bytes, 844,971 gzip -9 (before: 2,675,315 and 807,964, same measure).
- The ops find each edge again from its end points, so an `EdgeRef` stays valid until the mesh changes along that edge. After a fillet or chamfer, pick again.
- An end point matches a mesh vertex within 0.001 mm, or a ten millionth of the body's diagonal when that is larger (the rule dimension anchors use). From then on the ops use the mesh's own vertices, so a reference that went through JSON, a transform or a replayed history step and came back off by rounding still finds its edge. A reference that is off by more, covers only part of an edge or runs past its end fails as `no sharp edge between two flat faces there`.
- The far end of a round's arc is placed from the directions of the two faces rather than from the angle between them (cos 90 is not 0), so it lies exactly on its face, and a later push along that face leaves no hairline flap.
- The edge pieces are prisms with the bevel or round as cross section. They reach 0.01 mm past both faces, and past an end that opens to air (a convex edge) or into material (a concave one), so the boolean never meets coincident faces. Where an edge runs into a wall it stops exactly at the wall.
