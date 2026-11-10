### Added

- `slicerx_geom_interference` 1.0.0 checks two parts of a design against each other. It takes `design`, `a` and `b` (part indexes, not the same one) and returns `interferes`, `overlap_mm3` (the volume the two share), `clearance_mm` (the smallest distance between their surfaces, 0 when they touch or interfere) and, when they do not interfere, `from` and `to` (the closest pair of points, one on each part, mm). A shared volume under 0.001 mm3 counts as touching. A gap beside a round face reads up to about 0.02 mm under the modeled one, since round faces are drawn as flat facets. A part that is not closed is refused with what is open. Read only. App link method `geom.interference` (read class).

### Changed

- `slicerx_geom_measure` 1.3.0 adds `section`, in place of `a` and `b`: a design's part (`part`, default 0) cut at a plane (`plane`, with `origin`, a point on it in mm, and `normal`). It returns `section` with `area_mm2`, `outline_mm`, `regions`, `holes` and `loops` (each region's `outer` loop and its `holes`, as world points in mm on the plane); a section of more than 4000 points gives `loop_points` and `loops_left_out` in place of `loops`. A part that is not closed, a plane that misses the part and a zero normal are refused in plain words. The change is additive: a call without `section` answers as 1.2.0 did, and `a` is required unless `section` is given.
