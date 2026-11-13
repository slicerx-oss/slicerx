### Added

- `slicerx_design_part_filament` 1.0.0 sets which filament an existing part of a design prints with, as a step named "Filament N for <part>": it replays, saves and undoes like any step. `part` is from 0 and `slot` from 1 to 32; another slot is refused with "slot: give a filament slot from 1 to 32", and a part the design does not have with the number of parts it has. The answer is the design, with the part's new slot in `parts`, and the summary "Set <part> to filament N: step N".
