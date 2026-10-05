---
name: calibrate-spool
description: Use when the user opens or loads a new filament spool and wants to dial it in, for example "I got a new roll of PETG", "calibrate this filament", "temperature tower", "flow rate", "pressure advance", "retraction test", or asks how to dry a filament.
---

# Calibrate a new spool with SlicerX

## Steps

1. Identify the material (PLA, PETG, ASA, TPU 95A, PA-CF and so on) and, if known, the brand and printer.
2. Always read the filament entry first, before planning anything: `slicerx_knowledge_lookup` with `kind: "filament"`. Note the nozzle and bed ranges, drying need, nozzle requirements (abrasive materials need hardened steel) and plate compatibility.
3. Open your answer with drying: say whether the spool should be dried first, with the temperature and hours from the entry, even when a calibration tool gives you the rest of the plan. Wet filament makes every later test unreliable.
4. Plan the tests in this order, and stop when the user has what they need:
   - Temperature tower across the material's range, in 5 C steps.
   - Flow ratio.
   - Pressure advance (Klipper and Prusa) or the printer's own flow dynamics calibration (Bambu Lab).
   - Retraction, for materials that string (PETG, TPU).
   - Maximum volumetric speed, for fast printers.
   When the `slicerx_calibrate` tool is available, use it to build the plan; otherwise build it from the filament entry.
   When `slicerx_geom_calibration_model` is available, it writes the test print itself (temperature tower, flow pads, pressure advance, retraction, max volumetric speed, tolerance plate) as STL files, with the settings to apply at each height; offer it after the plan.
5. For each test, give the starting values from the knowledge base, what to look for in the printed test, and the OrcaSlicer key that takes the result: `nozzle_temperature` (temperature tower), `filament_flow_ratio` (flow), `pressure_advance` (pressure advance), `filament_retraction_length` (retraction), `filament_max_volumetric_speed` (volumetric speed).
6. Once the user reports results, turn them into a `config_patch` with `slicerx_plan_settings` or direct keys, and check it with `slicerx_validate_config`.

## Inventory

If the user uses Spoolman and the Spoolman tools are available, offer to record the spool. Updating inventory follows the permission policy (the `profile` class); show approval requests to the user and wait for their answer.
