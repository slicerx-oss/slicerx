### Changed

- `slicerx_design_steps` 1.7.0 (from 1.6.1) lists `copyOf` on a step that added an array's separate copies (`slicerx_geom_array` with `merge: false`): the part copied, from 0, and each copy's move from it as a 4 by 4 matrix in the design's own frame, column by column. The project file keeps it. A step saved before has no `copyOf` and opens as before.
