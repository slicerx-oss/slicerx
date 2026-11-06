### Fixed

- `slicerx_slice_file` and `slicerx_estimate_file` slice a 3MF project on the printer it was made for with the file's plate type (`curr_bed_type`, which picks the bed temperatures), its prime tower spot as the file gives it (`wipe_tower_x` and `wipe_tower_y`) and each filament's maker (`filament_vendor`). Before, the plate type fell back to the printer's default, the tower spot was rounded to 0.1 mm and every filament's maker was `(Undefined)`. A file's "Default Plate" still means the printer's default.
