### Fixed

- `slicerx_slice_file` slices an A1 plate with a part in the nozzle wrap check corner, with wrap detection on or off. Before, it was refused with `collision` (a `keep_out` item for the wrap check corner). The printer skips its wrap check on such a plate, so the layer G-code leaves the mass check block out on every layer, as the stock A1 template asks.
