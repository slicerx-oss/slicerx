### Changed

- `slicerx_geom_fillet` 1.4.0 (from 1.3.0) and `slicerx_geom_chamfer` 1.4.0 (from 1.3.0) round and bevel edges that run into a round. A straight edge on a flat face that runs smoothly into a round with the same angle between the faces, such as a side of a rounded rectangle, stops halfway into the round's first side. Picked edges that meet that way become one mitered round, closed when they make a whole loop, so the top loop of a rounded box or a cone's base rim rounds in one step. Before, these were refused with "the edge ends at a curved face" or "the face across the edge is curved".
- `slicerx_geom_edge_pick` 1.3.0 (from 1.2.0) reports those edges as supported, with the largest radius and bevel that fit, and its `chain` runs on through a round.
- The refusals for edges these tools still leave alone say which case it is: "both faces along this edge are curved", "the picked face is curved. Pick the edge from the flat face on its other side", "the angle between the faces changes along the round the edge runs into", "the edge ends at a curved face it does not run into smoothly" (the tip of a C, an edge running square into a boss), and "edges 1 and 2 meet along a round; pick both from the flat face they share".

### Fixed

- A fillet or chamfer step in a design whose edges lie along a round (a rounded box's top loop) is found again when the design replays. Before, the faces' keys named the whole round and the step broke.
