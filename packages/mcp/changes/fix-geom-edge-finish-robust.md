### Changed

- `slicerx_geom_edge_pick` 1.4.0 also returns `chainMaxRadiusMm`, `chainMaxDistanceMm`, `loopMaxRadiusMm` and `loopMaxDistanceMm`: the largest round and bevel that every edge of the chain, or every supported edge of the loop, takes. These are the limits slicerx_geom_fillet and slicerx_geom_chamfer enforce on that set; `maxRadiusMm` still looks at the picked edge alone. A loop edge where the faces meet at less than 30 degrees is now marked unsupported, as the fillet and chamfer refuse it.

### Fixed

- `slicerx_geom_fillet` 1.4.1 and `slicerx_geom_chamfer` 1.4.1 cut an edge listed more than once (a chain and a loop that both hold it) once, and the step's note says which edge was a repeat. Before, the edge was cut twice, which added triangles and left slivers along it.
