### Fixed

- `slicerx_geom_extrude` 1.12.2 (from 1.12.1): on a design that must stay exact, a sketch whose loops cross, or that has another problem the sketch check finds, is refused with that problem, such as "Loop 2 crosses loop 1 (segment 1 of loop 2 meets segment 2 of loop 1).", as on a mesh design. Before, it was refused with "Exact replay does not support shape.extrude for this part. The mesh path was not used." A sketch with no problem that the exact kernel cannot take yet, such as one with a spline, is still refused that way.
