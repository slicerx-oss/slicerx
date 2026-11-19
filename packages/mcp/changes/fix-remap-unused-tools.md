### Fixed

- `slicerx_remap_toolheads` 1.1.0 remaps a Snapmaker U1 file whose start G-code selects a tool the plate never prints with, such as T0 for the bed check when filament 1 prints 0 g. That tool may be left out of the map: it stays as written and the new `tools_kept` lists it. Before, the file was refused with `remap_refused` ("Tool 0 has no selected loaded toolhead"). A tool that extrudes and is missing from the map is still refused.
