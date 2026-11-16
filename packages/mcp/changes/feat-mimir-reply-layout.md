### Changed

- `slicerx_design_plan` 1.22.0 (from 1.21.0), in the mimir tab, takes `leftOut`: the real thing's details the part leaves out (too small to print at its size, or not asked for), each a noun phrase with no reason, such as "window panes" or "the weather vane". The reply's part card lists them under Details. A local model's form leaves it out. An approved plan whose sizes the person set under this printer's smallest on the card returns them in `underFloors`, each with its feature, size, plain name, the size planned, the floor and why, so the part card warns about them. Before, they were named only in the summary.
- `slicerx_design_get_plan` 1.1.0 (from 1.0.0) returns a mimir tab plan's `leftOut` when it has one. `slicerx_design_put_plan` does not take it.
