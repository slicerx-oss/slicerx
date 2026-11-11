### Fixed

- `slicerx_geom_fillet` 1.4.1 and `slicerx_geom_chamfer` 1.4.1 cut an edge listed more than once (a chain and a loop that both hold it) once, and the step's note says which edge was a repeat. Before, the edge was cut twice, which added triangles and left slivers along it.
