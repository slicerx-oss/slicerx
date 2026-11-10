### Fixed

- `slicerx_design_check` 1.8.0 (from 1.7.0) no longer reads a wall from a ledge microns wide that a flush join leaves where two rims of different facet counts meet on one circle, such as a cone joined onto a body of the same radius. A flat patch narrower than 0.01 mm across is left out of the minimum wall, however long it runs. Before, a toy rocket with 5 mm fins failed "minimum wall" at 0.004 mm. A real wall stays measured whatever its thickness: a plate 0.004 mm thick and millimeters wide still reads 0.004 mm.
