### Fixed

- `slicerx_geom_shell` 1.6.2 (from 1.6.1) and `slicerx_geom_hollow` 1.3.1 (from 1.3.0) smooth a voxel wall without turning any of its triangles over. Before, a few triangles of a thin wall on some curved bodies, such as a twisted hexagon vase made of 32 straight bands and shelled with a 1.6 mm wall, folded over their neighbors, so the wall crossed itself and the shell's cut took the robust engine. Walls move by less than a millionth of their volume on the bodies measured.
