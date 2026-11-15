### Fixed

- `slicerx_design_save` 1.1.1 (from 1.1.0): the saved file holds the design's placement on the plate (the build item's transform) exactly, each number with the digits it needs to read back the same, instead of rounded to 4 decimals, so a turned design no longer shifts by up to about 0.01 mm 100 mm out. Whole numbers are written as before, and part vertices still to 0.0001 mm. `bytes` in the answer can be larger for a turned or moved design.
