### Fixed

- The .gcode.3mf the server writes (`slicerx_slice_file` with `output` `gcode.3mf`, and a slice exported as a .gcode.3mf) carries project settings other slicers open without a settings error: a filament ironing speed on automatic and an empty post-processing list are left out. Before, they read the automatic ironing speed as 0 mm/s, below the 1 mm/s they take, and refused the file.
