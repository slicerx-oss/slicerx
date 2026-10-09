# Printer, filament and process configuration

The configuration a slice uses is built in layers, later ones winning:

1. The schema defaults.
2. The selected printer's shipped presets (`packages/profiles/resolved/<brand>.json`): the printer settings (bed shape and height, speeds, accelerations, machine limits, retraction, extruder), the filament in each slot and the process of the quality tier, resolved the way OrcaSlicer 2.4.2 resolves them (the full `inherits` chain and the extruder variant applied). The text of the printer's G-code is the one written for SlicerX (`packages/profiles/gcode.json`).
3. The Easy controls the person moved off the quality tier. A control left alone changes nothing, so the maker's preset stands. sleipnir is always applied.
4. The person's own overrides (Expert settings, imported presets and projects).

The code is `packages/app/src/adapters/profile.ts` (the layer), `adapters/config.ts` (`resolveConfig`) and `state/profile-sync.ts` (follows the printer, tier and filaments). The bed comes from the layer, and the printer's temperature limits go to the engine as `options.machineLimits`.

## Trusted G-code

`options.trustedGcode` is set only when the printer matches a shipped profile whose G-code is the shipped text and none of the G-code settings is overridden. Text from a user edit, an imported preset or an imported project always gets the strict linter. `trustOptions` in `state/actions.ts` decides it.

## Acceptance against OrcaSlicer 2.4.2

For Bambu Lab printers, Bambu Studio is the reference where it and OrcaSlicer differ in behavior: it is the maker's own slicer, and people compare against it. One case so far: the H2D's automatic filament map, when two maps cost the same, puts filament 1 on the right (master) extruder as Bambu Studio does (`filament_map = 2,1`); OrcaSlicer is not consistent there. Settings themselves still resolve as OrcaSlicer 2.4.2 resolves them, below.

`packages/core/bench/compare/resolved_dump.py` slices a model with OrcaSlicer 2.4.2 on a stock printer, filament and process and writes the settings it resolved (the config block of its G-code). `packages/settings/scripts/gen-resolved.ts` turns the dumps of every printer into the shipped files. `packages/app/test/resolved-parity.test.ts` compares the app's configuration with Orca's key by key when `ORCA_RESOLVED_DIR` points at the dumps (they stay out of the repository).

Result for the default filament and the standard process, 0.4 mm nozzle:

| Printer | Orca settings | Differ | Which |
| --- | --- | --- | --- |
| Bambu Lab P1S | 593 | 4 | `required_nozzle_HRC`, two preset names |
| Prusa MK4S | 589 | 3 | `printer_notes`, two preset names |
| Creality K1 | 593 | 2 | two preset names |

Reasons for each difference:

- G-code: the shipped text is the maker's, as Orca 2.4.2 resolves it for the printer's default filament: start, end, layer change, before layer change, filament change, pause, time lapse, file start and the rest of the printer G-code in `packages/profiles/gcode.json`, and the filament start and end G-code with each filament preset. All 42 printers Orca 2.4.2 has a preset for match it on every setting except the ones below (the check covers all of them, not only these three).
- `required_nozzle_HRC`: Orca's Bambu PLA Basic asks for a nozzle of hardness 3 while the printer's own value is 0 (unknown), and Orca only warns. The engine refuses a mismatch, so the request is not sent until the printer's nozzle hardness is known.
- `default_filament_profile`, `default_print_profile` and `printer_notes`: Orca preset names and notes, not settings.

The default filament is the one the maker's printer preset names (Bambu PLA Basic for the P1S, Prusa Generic PLA for the MK4S, Creality HF Generic PLA for the K1). Models Orca 2.4.2 has no preset for (43 of 49 printers are covered) use SlicerX's own printer, filament and process profiles.

## Filament, nozzle size and the Easy sliders

- **Filament.** Each slot slices with its own shipped preset, resolved like the printer's: the product the slot was matched to or the person picked (the AMS match, or Brand and Product in the filament dialog), in the variant that suits the printer (the one named for the printer and nozzle, else one whose compatible printers list it, else `System`), with the entry for the printer's extruder variant (standard or high flow) kept. A material with no product gets the shipped `Generic <material>` preset (the printer vendor's own, else the shared library's). The printer's default filament is Orca's exact one. The knowledge-base filament is used only when no generic preset of the material exists. The test compares Bambu PETG HF and Polymaker Panchroma PLA on the P1S with Orca 2.4.2: 6 and 14 settings differ, each listed in `test/resolved-parity.test.ts` (preset names, the plate the dump set, G-code text, `required_nozzle_HRC`, and keys the preset leaves unset where the schema default is from Orca main and not 2.4.2, such as `slow_down_min_speed` and `filament_cost`).
- **Nozzle size.** The size is kept per printer (0.2, 0.25, 0.4, 0.6, 0.8 as the model offers), chosen in the Change menu of the printer card, in Printer settings, in setup, and with the command bar. A printer whose status carries `nozzleDiameterMm` reports its own size, which wins and cannot be changed. The size picks the machine, filament and process presets Orca has for it (`profiles/resolved`, 93 model and size pairs checked against Orca 2.4.2 in the same test). A size Orca has no preset for keeps the default nozzle's machine with our own process for that size.
- **Easy sliders.** Detail and Strength stand where the resolved preset is (the position whose layer height, walls and infill are nearest the preset's) until they are moved; Supports and Brim read from the preset. Moving one applies just that control.

