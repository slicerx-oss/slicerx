### Changed

- `slicerx_geom_cut` 1.4.0 (from 1.3.0): with `design` and `keep: "both"`, an optional `name` names the upper piece, the new part the cut makes. Without it the upper piece is still called after the part with "top" added. The name is kept on the step, so it stays when the cut or a step before it changes, and when the design is saved and opened again. A `name` on a cut that keeps one piece is refused with "name: only a cut that keeps both pieces makes a new part; leave name out".
