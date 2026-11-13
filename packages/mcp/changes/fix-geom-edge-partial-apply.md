### Breaking

- `slicerx_geom_edge_pick` 2.0.0 (from 1.5.0) returns `loopRef` and `chainRef` first, the face's loop and the edge's tangent chain as one entry each that `slicerx_geom_fillet` and `slicerx_geom_chamfer` take as is, with `loopEdges` and `chainEdges` (how many edges each names). The per-edge `chain` and `loop` lists come only with `list_edges: true`; before, every pick returned them.

### Changed

- `slicerx_geom_fillet` 1.6.0 (from 1.5.0) and `slicerx_geom_chamfer` 1.6.0 (from 1.5.0) do the edges they can and leave the rest as they were by default: the reply always has `skipped`, empty when every edge was done, with each edge left out as `index` (in the step's edges), `input` (the entry of `edges` it came from), `code` (`does_not_fit`, `overlap`, `corner`, `round_join`, `not_found`, `face_reference` or `unsupported`) and `message`. `all_or_nothing: true` refuses the whole step instead, as before. The step keeps the choice and which edges it left out, and a later replay that leaves out others says so in the step's note.
- `slicerx_geom_fillet` 1.6.0 and `slicerx_geom_chamfer` 1.6.0 take `loopRef` and `chainRef` entries in `edges`. Each is picked again on the part as it is when the step is made, so one entry names a whole outline of any length and still holds after an earlier round moved its edges.
- `slicerx_design_steps` 1.6.0 (from 1.5.0) lists `skipped` on a fillet or chamfer step that left edges as they were.
- A fillet or chamfer refused because an edge moved (`pick it again`) adds that a loopRef or chainRef is picked again when the step is made.
