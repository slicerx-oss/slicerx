// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Writes docs/prusa-import.md from prusa-map.json: which PrusaSlicer keys map to which of ours, and which stay unmapped.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const m = JSON.parse(readFileSync(here('../prusa-map.json'), 'utf8'))
const rows = Object.entries(m.rename).map(([a, b]) => `| \`${a}\` | \`${b}\` |`).join('\n')
const text = `# Importing PrusaSlicer presets

\`importPrusaIni(text, fileName)\` reads a PrusaSlicer \`.ini\`: one exported preset, an exported project configuration (print, filament and printer keys in one file, split into one preset per kind), or a config bundle (\`[print:Name]\`, \`[filament:Name]\`, \`[printer:Name]\`, with \`inherits\` merged and \`*abstract*\` sections left out). It returns typed presets and, for each, the keys it did not map.

Keys PrusaSlicer shares with us by name (about 150, such as \`layer_height\`, \`brim_width\`, \`nozzle_diameter\`, \`filament_diameter\`) need no entry. The rest are mapped through \`prusa-map.json\` (compared with PrusaSlicer commit ${m.prusaCommit}), the value forms are converted where the two differ (for example \`fill_density\` percent, \`gcode_flavor\`, \`ensure_vertical_shell_thickness\`), and percent speeds are turned into millimeters per second from the preset's own base speed.

Composite conversions: \`support_material\`, \`support_material_auto\` and the style set \`enable_support\` and \`support_type\`; \`first_layer_speed\` sets the first layer wall and infill speeds; \`ironing\` and \`ironing_type\` give one ironing type; \`bed_temperature\` sets the smooth and textured PEI plates (and their first layer values); a travel lift (\`retract_lift\`, \`travel_ramping_lift\`, \`travel_max_lift\` and \`travel_slope\`, and the filament's own \`filament_retract_lift\`, \`filament_travel_ramping_lift\` and \`filament_travel_max_lift\`) gives the z hop height and type: with ramping on the ramp's height as a slope lift (straight up at a slope of 0 or 90 degrees), with it off the straight lift as a normal lift.

## Renamed keys

| PrusaSlicer | SlicerX |
| --- | --- |
${rows}

## Projects

\`prusaProjectSettings(text)\` reads \`Metadata/Slic3r_PE.config\` from a PrusaSlicer \`.3mf\`, where each line is written as \`; key = value\`, and returns the values in the form \`project_settings.config\` has in an Orca or Bambu Studio project. A PrusaSlicer project then opens with its settings the same way. \`prusaOverrides(meta)\` does the same for one object's or volume's settings from \`Metadata/Slic3r_PE_model.config\`.

A width percent in a project is of a height, where one of ours is of the nozzle, so \`prusaProjectSettings\` writes these in mm (prusa-map.json \`widthPercentOf\`): \`first_layer_extrusion_width\` is a percent of \`first_layer_height\`; \`extrusion_width\`, \`external_perimeter_extrusion_width\`, \`perimeter_extrusion_width\`, \`infill_extrusion_width\`, \`solid_infill_extrusion_width\`, \`top_infill_extrusion_width\` and \`support_material_extrusion_width\` are a percent of \`layer_height\`; and \`support_material_xy_spacing\` is a percent of the outer wall width at the layer height, which is \`external_perimeter_extrusion_width\` when set, else \`extrusion_width\`, else 1.125 times the project's own \`nozzle_diameter\`. A missing height or nozzle reads as 0.35 mm first layer, 0.3 mm layer and 0.4 mm nozzle (\`percentBaseDefaults\`). The mm values are not rounded: 150% of a 0.15 mm first layer is 0.225. A width of 0 is auto, as below. \`prusaObjectOverrides(meta, projectText)\` does the same for one object: a width percent the object sets, and each of the project's when the object has its own \`layer_height\`, is of the object's layer height (the project's when it sets none), and its support XY spacing is of its own outer wall width. The first layer width stays the project's. Volume settings and \`.ini\` presets are read as before.

A feature width of 0 in a project (\`external_perimeter_extrusion_width\`, \`perimeter_extrusion_width\`, \`infill_extrusion_width\`, \`solid_infill_extrusion_width\`, \`top_infill_extrusion_width\` or \`support_material_extrusion_width\`, prusa-map.json \`zeroWidthFallback\`) is \`extrusion_width\` when that is not 0, in mm as given or as a percent of \`layer_height\`. When \`extrusion_width\` is 0 too, the support width is the project's own \`nozzle_diameter\` (\`zeroWidthNozzle\`; 0.4 mm when the file has none), and the other widths stay 0, which here already means 1.125 times the nozzle (the nozzle itself for the top surface). \`prusaObjectOverrides\` does the same with the object's general width when the object sets it or a width at 0, or has its own \`layer_height\` under a general width in percent. \`first_layer_extrusion_width\` at 0 stays 0.

## Ignored keys

Resin printer (SLA) keys, preset ids and compatibility bookkeeping, host credentials, the thumbnails and binary G-code options, and project placement keys (\`wipe_tower_x\`, \`wipe_tower_y\`) are not print settings and are dropped without being counted.

## Not mapped

SlicerX has no setting with the same meaning for these ${m.unmapped.length} keys, so an imported preset loses them and reports them. For some of them the import report names the closest SlicerX setting, from \`import-nearest.json\`. The keys:

${m.unmapped.map((k) => `\`${k}\``).join(', ')}.
`
writeFileSync(here('../docs/prusa-import.md'), text)
