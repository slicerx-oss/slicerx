### Fixed

- `slicerx_geom_extrude` 1.15.1 (from 1.15.0): on a design with exact solids, a cut sketched on the part's surface stays exact. A row of ten or more round cuts sketched flush on a lofted body's side could fail in the exact kernel, and the step ran on the mesh with the note that the exact solid could not do it. Such a cut now starts 0.01 mm back past the surface, as a cut on the mesh does, so it removes the same material and the part stays an exact solid. A cut that starts inside the part or clear of it is made as asked.
