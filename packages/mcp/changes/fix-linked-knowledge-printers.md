### Changed

- A slice on `printer:prusa_mk4s`, `printer:prusa_xl`, `printer:prusa_core_one`, `printer:voron_2_4` or `printer:voron_trident` now starts from the maker's own process, supports and default filament for that machine, as the app does on `machine:prusa-mk4s`, `machine:prusa-xl`, `machine:prusa-core-one`, `machine:voron-2.4-300` and `machine:voron-trident-300`. Before, these five knowledge printers, whose names differ from SlicerX's profiles, took SlicerX's generic Standard with supports on and the schema's filament. A `process:<tier>` named with one of them is the maker's tier, and a project sliced on one has its G-code checked against that machine. Supports are now off by default on these printers, as in the maker's Standard; `intent:standard` or `enable_support` turns them on.

### Fixed

- `printer:prusa_mk4s`, `printer:prusa_xl`, `printer:prusa_core_one`, `printer:voron_2_4` and `printer:voron_trident` carry the start, end, layer change and filament change G-code SlicerX ships for the machine each stands for, as `machine:<id>` does, and a slice on one runs it as trusted G-code. Before, their names did not match SlicerX's profiles, so they printed with the schema's bare start script.
