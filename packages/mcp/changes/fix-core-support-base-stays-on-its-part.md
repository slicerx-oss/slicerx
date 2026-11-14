### Fixed

- `slicerx_slice_file` with organic tree supports on a plate of several objects: the first support layer no longer grows under a neighboring object. Where it grows out past the branches it now keeps the support's XY distance from every other object's footprint, and support lines at the edge of a support area carry the object that area holds up, so a printer that skips one object no longer skips part of its neighbor's support. No tool's input or answer shape changes, so no tool version moves.
