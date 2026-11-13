### Changed

- `slicerx_paint_preview` 1.4.0 (from 1.3.0) takes `feature`, the plan feature the paint builds, and `slicerx_paint_apply` 1.3.0 (from 1.2.0) tags the step with it when the apply gives none. A feature given to the apply still wins.
- `slicerx_paint_preview`'s text is shorter: its description names the triangles, area and connected regions together, and `max_depth` reads "How many times a height band halves triangles at its edges; left out, edges land within 0.04 mm of the height (6 to 10)".
