### Fixed

- `slicerx_geom_shell` 1.6.1 (from 1.6.0) shells a curved body whose voxel wall folds over itself at the wall asked, such as a twisted hexagon vase lofted smooth through a hexagon every 20 mm and opened at its top with a 1.6 mm wall. Before, it was refused with "a 1.6 mm wall does not work on this body, since it would keep triangles too thin to store; try a wall a little thinner or thicker". The wall is the same as before; the cut no longer leaves triangles with no area on it.
