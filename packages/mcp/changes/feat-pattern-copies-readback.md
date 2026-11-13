### Changed

- `slicerx_geom_array` 1.9.0 (from 1.8.0) and `slicerx_geom_mirror` 1.6.0 (from 1.5.0) with `steps` answer with `copies`: `{ total, kept, missed }`, how many copies the pattern has (the steps themselves are copy 1), how many it kept, and the numbers of those left out, from 1 as the step's note numbers them. A copy of a row along a curved side that finds no side where it lands counts as missed. The note in the summary is unchanged.
