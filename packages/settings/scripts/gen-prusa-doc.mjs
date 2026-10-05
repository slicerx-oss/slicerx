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

Composite conversions: \`support_material\`, \`support_material_auto\` and the style set \`enable_support\` and \`support_type\`; \`first_layer_speed\` sets the first layer wall and infill speeds; \`ironing\` and \`ironing_type\` give one ironing type; \`bed_temperature\` sets the smooth and textured PEI plates (and their first layer values); \`travel_ramping_lift\` gives the z hop type.

## Renamed keys

| PrusaSlicer | SlicerX |
| --- | --- |
${rows}

## Projects

\`prusaProjectSettings(text)\` reads \`Metadata/Slic3r_PE.config\` from a PrusaSlicer \`.3mf\`, where each line is written as \`; key = value\`, and returns the values in the form \`project_settings.config\` has in an Orca or Bambu Studio project. A PrusaSlicer project then opens with its settings the same way. \`prusaOverrides(meta)\` does the same for one object's or volume's settings from \`Metadata/Slic3r_PE_model.config\`.

## Ignored keys

Resin printer (SLA) keys, preset ids and compatibility bookkeeping, host credentials, the thumbnails and binary G-code options, and project placement keys (\`wipe_tower_x\`, \`wipe_tower_y\`) are not print settings and are dropped without being counted.

## Not mapped

SlicerX has no setting with the same meaning for these ${m.unmapped.length} keys, so an imported preset loses them and reports them. For some of them the import report names the closest SlicerX setting, from \`import-nearest.json\`. The keys:

${m.unmapped.map((k) => `\`${k}\``).join(', ')}.
`
writeFileSync(here('../docs/prusa-import.md'), text)
