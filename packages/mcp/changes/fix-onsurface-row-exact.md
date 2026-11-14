### Fixed

- `slicerx_geom_array` 1.9.3 (from 1.9.2) with `steps` and `onSurface` makes a row that follows a curved side on exact solids, such as a row of 12 holes along a curved side, when the engine keeps the part's solid between calls. Before, the whole row was refused with "Copy 1: The first copy is not on the part, so there is no surface for the row to follow", because the row looked for the side on a part that had no triangles yet. The same row on a mesh part is unchanged.
