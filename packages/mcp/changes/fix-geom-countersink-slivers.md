### Fixed

- `slicerx_geom_loft` cuts a countersink into a plate on the first try when the cone runs along a surface the plate already has: the hole's wall, the plate's top, or an earlier countersink on the same hole. Before, the cut could be refused with "the result is unsafe at mesh storage precision (collapsed triangles)" and went through only when asked again a little differently.
- `slicerx_geom_extrude`, `slicerx_geom_revolve`, `slicerx_geom_sweep`, `slicerx_geom_push_pull`, `slicerx_geom_fillet`, `slicerx_geom_subtract` and `slicerx_geom_boolean` clear the same sliver triangles (under 1e-6 mm2) from a cut or join where a sliver can go by moving a corner 10 microns or less, so storage no longer flattens them. The volume moves by a billionth of the part at most.
