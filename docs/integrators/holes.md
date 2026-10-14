# Holes over MCP

`slicerx_geom_hole` makes a round hole another size, the way the app's hole tool does. It changes the diameter, a blind hole's depth, or adds a counterbore or a countersink at the hole's entry. It works on a design (a step in its history) or on an STL (a new STL in the output folder). It needs `sx-geom` next to `sx`, like the other design tools, or the app link to the open app.

## Picking the hole

Give one of these:

- `center` and `axis`: a point on the hole's axis line and the axis, either way round. The center of the hole on the face it starts at is the usual point. Any point inside the hole's circle on that line works. The end nearest the point is the entry. Where two holes share the line, such as a counterbore over its shaft, the narrower one is the hole.
- `face`: a point on the hole's wall, `{"at": [x, y, z]}`, with `normal` (pointing into the hole) when the point is on an edge, or `{"triangle": n}`.

On a design, `part` names the part. Without it, a `face` pick uses the part it is on and a `center` pick uses the first part with a hole on that line.

## What it becomes

- `diameter_mm`: the new diameter. Left out, the hole keeps its own.
- `depth_mm`: a blind hole's new depth from its entry. A through hole stays through.
- `counterbore`: `{"diameter_mm", "depth_mm"}`, wider than the hole and less deep.
- `countersink`: `{"diameter_mm", "angle_deg"}`, the diameter on the face and the cone's full angle (90 by default).
- `label`: on a design, the step's name in the history, such as `M3 clearance`. The default is `Hole <diameter> mm`.

Give at least one of the first four. A hole takes a counterbore or a countersink, not both.

## Read-back

The answer has `before`, the hole as found, and `after`, the hole as made, each with:

| Field | Meaning |
| --- | --- |
| `center` | the hole's center on the face it starts at, mm |
| `axis` | the way out of the hole through its entry |
| `diameterMm` | the shaft's diameter |
| `depthMm` | from the entry to the far end (the far face, or the floor of a blind hole) |
| `kind` | `through` or `blind` |
| `head` | `after` only: `none`, `counterbore` or `countersink`, with its sizes |

`after` is measured on the new body: the narrowest hole on the old hole's axis line. On a design the answer also has the design summary with `lastStep`, the new `hole.apply` step. On an STL it has the new `mesh` with its volume and whether it is closed.

A pick that finds no hole is refused with what is there instead, for example `pick: no round hole there: the pick is on a flat face` or `no round hole on that axis line; the nearest face to the point is the outside of a boss or rod`. The design is left as it was.

## The step

On a design the tool adds the same `hole.apply` step the hole tool records: the hole as found, the spec and the label. The step replays when an earlier step changes (a plate made thicker gives the hole its new depth), its diameter edits with `slicerx_design_edit_step`, and a saved 3MF opens in SlicerX with it editable. With the app link on, the step lands in the open app's history and undo.

A countersunk hole reads back, but the tool, like the app's hole tool, only works on holes that start at a flat face, so it can't change a countersunk hole again.

## Example

```sh
slicerx-mcp call design_new '{"name":"Plate"}' \
  geom_extrude '{"design":"d1","shape":{"type":"rectangle","widthMm":30,"heightMm":20},"placement":{"center":[15,10]},"distance_mm":5}' \
  geom_extrude '{"design":"d1","shape":{"type":"circle","diameterMm":6},"frame":{"origin":[15,10,5],"normal":[0,0,1]},"distance_mm":5,"operation":"cut"}' \
  geom_hole '{"design":"d1","center":[15,10,5],"axis":[0,0,1],"diameter_mm":3.4,"counterbore":{"diameter_mm":6.5,"depth_mm":3},"label":"M3 counterbore"}'
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
