# Holes over MCP

Two tools work on round holes. `slicerx_geom_hole` cuts a new one, through the wall it starts in or to a depth, with a counterbore or a countersink at its entry. `slicerx_geom_hole_edit` makes a hole that is already there another size, the way the app's hole tool does. Both work on a design (steps in its history) or on an STL (a new STL in the output folder), and both need `sx-geom` next to `sx`, like the other design tools, or the app link to the open app.

## A new hole

### Where it goes

Give one of these:

- `center` and `axis`: the hole's center on the flat face it starts at, and its axis, either way round. Any point on the axis line works; the hole starts where that line meets the part nearest the point. Left out, `axis` is square to the face at `center`.
- `face`: `{"at": [x, y, z]}`, a point on the face the hole starts at, with `normal` when the point is on an edge. The hole goes square into that face.

On a design, `part` names the part. Without it, a `center` and `axis` pick uses the part the axis line meets first, and a `face` pick uses the part the point is on.

The entry has to be a flat face square to the axis, and the hole's whole circle (and the head's, when there is one) has to sit on it. These are refused with `invalid_input`, and nothing changes:

- a point on a round face, such as the side of a boss: give the center on the boss's flat top instead
- a circle that runs off the face, or onto a step or a round face
- an axis more than 1 degree off square to the face
- an axis line that meets no part
- a hole already on that axis line where the new one would start: the refusal names it, and `slicerx_geom_hole_edit` changes it. A wider hole round the line, such as a cup's bore over a drain hole in its floor, is not in the way

### What it makes

- `diameter_mm`: the hole's diameter, required. A hole narrower than the nozzle is refused, as the hole tool refuses it.
- `depth_mm`: a blind hole's depth from its entry. Left out, the hole goes through the wall it starts in, to the face where the material ends along the axis. A depth as deep as that wall, or deeper, makes it through too.
- `counterbore`: `{"diameter_mm", "depth_mm"}`, wider than the hole and less deep.
- `countersink`: `{"diameter_mm", "angle_deg"}`, the diameter on the face and the cone's full angle, 30 to 90 (90 by default). The cone has to end above the hole's far end.
- `label`: on a design, the cut's name in the history, such as `M3 clearance`. The default is `Hole <diameter> mm`.

A hole takes a counterbore or a countersink, not both.

### Read-back and steps

The answer has `hole`, the hole as made and measured on the new body:

| Field | Meaning |
| --- | --- |
| `center` | the hole's center on the face it starts at, mm |
| `axis` | the way out of the hole through its entry |
| `diameterMm` | the shaft's diameter |
| `depthMm` | from the entry to the far end (the far face, or the floor of a blind hole) |
| `kind` | `through` or `blind` |
| `head` | `none`, `counterbore` or `countersink`, with its sizes |

On a design the cut is a `shape.extrude` step, a circle on the entry face cut into it, the step Extrude with Cut makes, so it replays when an earlier step changes and its depth edits with `slicerx_design_edit_step`. A counterbore or a countersink is a second cut on the same face after it, named `Counterbore <diameter> mm` or `Countersink <diameter> mm`: a wider circle as deep as the counterbore, or a circle narrowing to the hole with its sides drafted by half the cone's angle. When the head cannot go on, the cut is taken back off and the call is refused. A hole the engine cannot read back as one, such as one that runs out through a round face, keeps its steps, and `hole` is `null` with a note in the summary. Both steps carry `feature` when it is given. On an STL the answer also has the new `mesh` with its volume and whether it is closed.

### Example

```sh
slicerx-mcp call design_new '{"name":"Plate"}' \
  geom_extrude '{"design":"d1","shape":{"type":"rectangle","widthMm":30,"heightMm":20},"placement":{"center":[15,10]},"distance_mm":5}' \
  geom_hole '{"design":"d1","center":[15,10,5],"axis":[0,0,1],"diameter_mm":3.4,"counterbore":{"diameter_mm":6.5,"depth_mm":3},"label":"M3 clearance"}'
```

The last line's `output`, shortened:

```json
{
  "summary": "Made a 3.4 mm through hole with a counterbore: step 3, Counterbore 6.5 mm",
  "output": {
    "design": "d1",
    "steps": 3,
    "lastStep": { "index": 3, "name": "Counterbore 6.5 mm", "op": "shape.extrude", "part": 0, "value": { "label": "Depth", "value": 3, "unit": "mm" }, "state": "done" },
    "volumeMm3": 2882.536,
    "part": 0,
    "hole": { "center": [15, 10, 5], "axis": [0, 0, 1], "diameterMm": 3.4, "depthMm": 5, "kind": "through", "head": "counterbore", "counterbore": { "diameterMm": 6.5, "depthMm": 3 } }
  }
}
```

## Changing a hole already there

### Picking the hole

Give one of these:

- `center` and `axis`: a point on the hole's axis line and the axis, either way round. The center of the hole on the face it starts at is the usual point. Any point inside the hole's circle on that line works. The end nearest the point is the entry. Where two holes share the line, such as a counterbore over its shaft, the narrower one is the hole.
- `face`: a point on the hole's wall, `{"at": [x, y, z]}`, with `normal` (pointing into the hole) when the point is on an edge, or `{"triangle": n}`, or a `topology` reference from `slicerx_geom_faces`.

On a design, `part` names the part. Without it, a `face` pick uses the part it is on and a `center` pick uses the first part with a hole on that line.

### What it becomes

- `diameter_mm`: the new diameter. Left out, the hole keeps its own.
- `depth_mm`: a blind hole's new depth from its entry. A through hole stays through.
- `counterbore`: `{"diameter_mm", "depth_mm"}`, wider than the hole and less deep.
- `countersink`: `{"diameter_mm", "angle_deg"}`, the diameter on the face and the cone's full angle (90 by default).
- `label`: on a design, the step's name in the history, such as `M3 clearance`. The default is `Hole <diameter> mm`.

Give at least one of the first four. A hole takes a counterbore or a countersink, not both.

### Read-back

The answer has `before`, the hole as found, and `after`, the hole as made, with the fields of a new hole's `hole` (`head` in `after` only).

`after` is measured on the new body: the narrowest hole on the old hole's axis line. On a design the answer also has the design summary with `lastStep`, the new `hole.apply` step. On an STL it has the new `mesh` with its volume and whether it is closed.

A pick that finds no hole is refused with what is there instead, for example `pick: no round hole there: the pick is on a flat face` or `no round hole on that axis line; the nearest face to the point is the outside of a boss or rod`, and with a note that a new hole is `slicerx_geom_hole`'s. The design is left as it was.

### The step

On a design the tool adds the same `hole.apply` step the hole tool records: the hole as found, the spec and the label. The step replays when an earlier step changes (a plate made thicker gives the hole its new depth), its diameter edits with `slicerx_design_edit_step`, and a saved 3MF opens in SlicerX with it editable. With the app link on, the step lands in the open app's history and undo.

A countersunk hole reads back, but the tool, like the app's hole tool, only works on holes that start at a flat face, so it can't change a countersunk hole again.

### Example

```sh
slicerx-mcp call design_new '{"name":"Plate"}' \
  geom_extrude '{"design":"d1","shape":{"type":"rectangle","widthMm":30,"heightMm":20},"placement":{"center":[15,10]},"distance_mm":5}' \
  geom_extrude '{"design":"d1","shape":{"type":"circle","diameterMm":6},"frame":{"origin":[15,10,5],"normal":[0,0,1]},"distance_mm":5,"operation":"cut"}' \
  geom_hole_edit '{"design":"d1","center":[15,10,5],"axis":[0,0,1],"diameter_mm":3.4,"counterbore":{"diameter_mm":6.5,"depth_mm":3},"label":"M3 counterbore"}'
```

The last line's `output`, shortened:

```json
{
  "summary": "Made the 6 mm hole 3.4 mm with a counterbore: step 3, M3 counterbore",
  "output": {
    "design": "d1",
    "steps": 3,
    "lastStep": { "index": 3, "name": "M3 counterbore", "op": "hole.apply", "part": 0, "value": { "label": "Diameter", "value": 3.4, "unit": "mm" }, "state": "done" },
    "volumeMm3": 2882.413,
    "part": 0,
    "before": { "center": [15, 10, 5], "axis": [0, 0, 1], "diameterMm": 6, "depthMm": 5, "kind": "through" },
    "after": { "center": [15, 10, 5], "axis": [0, 0, 1], "diameterMm": 3.4, "depthMm": 5, "kind": "through", "head": "counterbore", "counterbore": { "diameterMm": 6.5, "depthMm": 3 } }
  }
}
```

The engine's own call takes the same pick: `sx-geom hole.find` with `mesh`, `at` and `axis` (no `triangle`) finds a hole by its axis line ([../cad-engine.md](../cad-engine.md)).
