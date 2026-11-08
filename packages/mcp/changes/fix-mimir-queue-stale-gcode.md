### Fixed

- `slicerx_mimir_run` 1.0.1 reports the last slice as `stale` after a pause or other layer mark is added or changed, an object is renamed, or the profile's G-code stops being the shipped text, as well as after the plate, printer or slots change. mimir's own queue refuses such a slice in the app. A color change's slot note and a spool reload that changes only the grams left still leave it current.
