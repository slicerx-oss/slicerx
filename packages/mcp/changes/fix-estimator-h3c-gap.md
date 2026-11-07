### Fixed

- `slicerx_slice_file`, `slicerx_estimate_file` and `slicerx_slice` time an H3C print with the unload a change into an unused hotend takes: the filament the print leaves is unloaded first (28 s on the stock settings), once for each tool the print starts using after the first. Before, those changes took the load time only, so a four-filament H3C print came out about 84 s short.
