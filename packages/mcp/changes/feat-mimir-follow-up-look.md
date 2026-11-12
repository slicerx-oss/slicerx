### Added

- `slicerx_design_look` 1.1.0 (from 1.0.0), in the mimir tab, takes `compare`: the share of the whole-model view that changed since the last look at the design, drawn twice in one frame and measured, as `visiblePct` against `floorPct` (2) with `belowFloor`, and the picture as it is now.

### Changed

- `slicerx_design_check` 1.16.0 (from 1.15.0): once a part has passed its plan's check, a failed check says a change since then broke it, to be fixed or undone in the same turn without asking, and never ends the building or repeats a closed answer.
