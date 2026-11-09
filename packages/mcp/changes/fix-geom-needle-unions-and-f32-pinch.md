### Fixed

- `slicerx_geom_boolean` 1.3.1 (from 1.3.0) joins a bar whose end sits square on another part's face, such as a swept handle bar ending on its post, wherever the part sits on the plate. At some plate positions the join was refused with "the result is unsafe at mesh storage precision (collapsed triangles)". The faces and their keys stay as they were.
- `slicerx_geom_subtract` 1.2.1 (from 1.2.0) catches a cut whose corners meet only once the part is stored, which left the part closed by its own count but not once its corners were welded, and cuts it with the boolean engine instead. When the boolean engine's cut already stores, it is kept without a further weld, so the flared stem bore now leaves 15898 triangles.
