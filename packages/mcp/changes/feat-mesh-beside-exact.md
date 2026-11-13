### Changed

- `slicerx_geom_build` 1.6.0 (from 1.5.0): on an exact design, a part built from more than one solid, or with cutters, is added as a mesh part beside the exact parts. Before, the design refused it. The exact parts stay exact. Steps that work only on that mesh part run on the mesh. Joining it into an exact part still stops on an exact design, with the reason.
- `slicerx_design_steps` 1.6.0 (from 1.5.0): on an exact design, each mesh part in `parts` has `mesh: true`. The same mark is on the parts of every design result that lists them.
