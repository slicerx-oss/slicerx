### Added

- Paint reaches filament 32. `slicerx_paint_preview` and `slicerx_app_paint_preview` 1.0.2 take a color state up to 32, and a replace from one, and refuse 33 and up with "Paint uses filaments 1 to 32, as many as a project holds." A design saved with paint on filament 17 or higher also carries `Metadata/Slic3r_facets_annotation.json`, the same paint for readers that take it from there.
