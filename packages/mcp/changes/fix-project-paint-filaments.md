### Fixed

- `slicerx_slice_file` 1.18.1 (from 1.18.0) and `slicerx_estimate_file` 1.15.1 (from 1.15.0), with `project_settings` and a `machine:` profile: a Bambu Studio, OrcaSlicer or PrusaSlicer project painted in filaments its parts do not print with slices with every filament the paint uses, each with its own color, flush row and filament values, as the app opens it. Before, the slice listed only the filaments up to the highest one a part names, so a column on filament 2 painted in filament 3 printed with two filaments' settings.
