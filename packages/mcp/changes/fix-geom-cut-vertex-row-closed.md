### Fixed

- `slicerx_geom_cut` gives pieces with no triangle collapsed to a line when the plane runs through a row of points, or a hair from one. Before, a smooth hull cut at z 3.6, the height of a row of its section points, came back with 12 triangles on each piece whose corners land on one point once stored, and a repair dropped them and filled holes.

### Changed

- `slicerx_geom_info` for a model, the `slicerx_geom_cut` report and the other model answers that give `watertight` read closed the way the slicer and design checks already do: corners at the same stored point are one vertex, whatever their indices. Two boxes touching along one edge, each closed by its own indices, now read `watertight: false` with 1 non-manifold edge. Triangles that collapse to a line at the stored point are left out of the edge counts and given in `edges.collapsedTriangles` (and `belowEdges` and `aboveEdges` for a cut), a new field sent only when there are some. A mesh with no two corners at one stored point reads as before.
