---
name: plan-settings
description: Use when the user asks which slicer settings to use or change for a material, printer, nozzle or goal, such as "what settings for PETG on my P1S", "switching from PLA to ASA", "I moved to a 0.6 nozzle", "make this print stronger", or asks what an OrcaSlicer setting does or whether a config is valid.
---

# Plan slicer settings with SlicerX

SlicerX uses OrcaSlicer's setting names. Every change it proposes carries a reason and its sources from the SlicerX knowledge base; pass those on instead of inventing your own.

## Steps

1. Pull out the target filament, printer and nozzle diameter, and what the user is switching from. Add an intent (draft, standard, fine or strong) only when the user asked for a goal such as stronger or faster; otherwise leave it out so the plan changes only what the switch requires.
2. Call `slicerx_plan_settings` with those fields (`filament`, `printer`, `nozzle_diameter`, `intent`, `from_filament`, `from_printer`). If the user pasted their current settings, pass them as `current`.
3. If the result has `unresolved` entries (an unknown printer name, an abrasive filament that needs a hardened nozzle, a temperature above the hotend limit), tell the user first.
4. Present the changes grouped by what they affect (temperatures, cooling, speeds, strength). For each: the setting label, before, after, and the tool's own reason in one line. Do not add changes or reasons the plan does not contain. Cite a source when the user asks why.
5. Check the result with `slicerx_validate_config` on the `config_patch` and mention any error or warning.
6. For questions about one setting, use `slicerx_explain_setting` (or `slicerx_find_settings` when you do not know the key). The resource `slicerx://settings/reference/{key}` has the full entry.

## Applying the plan

- Hand the user the `config_patch`. It can go into `slicerx_slice_file` as `overrides` or into a project with `slicerx_project_set_overrides`.
- Saving it into a saved profile goes through the permission policy (the `profile` class). Do not claim a profile was saved unless the tool confirmed it.
- Do not tell the user a value is safe for their hardware beyond what the knowledge base says. When sources disagree, the plan says so; repeat that.
