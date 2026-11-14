### Fixed

- `slicerx_geom_hole` 2.1.1 (from 2.1.0) no longer refuses a hole whose axis line leaves the part on an edge where a face square to the axis meets a slanted one, such as the end of a post where a bar leaning over it is joined. Both faces cross the line at the same depth, and the slanted one could come first by rounding alone, so the hole was refused with "center: the part is not closed along the hole's axis". Now the face square to the axis is taken when one crosses within 0.000001 mm of the nearest crossing. A line that leaves the part on a slanted face alone is read as before.
