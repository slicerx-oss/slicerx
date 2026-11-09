// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Writes docs/printer-profiles.md: per printer model, whether its machine settings were checked against the
// maker's profile (and which version), how its G-code stands, and where the catalog differs from the profile.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const printers = JSON.parse(readFileSync(here('../profiles/printers.json'), 'utf8')).printers
const machine = JSON.parse(readFileSync(here('../../profiles/machine.json'), 'utf8'))
const gcode = JSON.parse(readFileSync(here('../../profiles/gcode.json'), 'utf8'))
// The hand-written families' models (gcode-written.json); a model in both files is refused, as the loaders do.
for (const [id, family] of Object.entries(JSON.parse(readFileSync(here('../../profiles/gcode-written.json'), 'utf8')).models)) {
  if (id in gcode.models) throw new Error(`printer model ${id} has a G-code family in both gcode.json and gcode-written.json`)
  gcode.models[id] = family
}
const size = (a) => {
  const pts = (Array.isArray(a) ? a : String(a).split(',')).map((s) => String(s).toLowerCase().split('x').map(Number))
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1])
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
}
const rows = printers.map((p) => {
  const e = machine.models[p.id]
  const g = String(gcode.models[p.id]).startsWith('maker_') ? 'maker template' : 'written'
  if (!e) return `| ${p.vendor} ${p.model} | no maker profile to check against | ${g} | catalog values only |`
  const v = p.buildVolume
  const [w, d] = size(e.machine.printable_area)
  const h = Number(e.machine.printable_height)
  const note = v.shape === 'rectangular' && (w !== v.x || d !== v.y || h !== v.z) ? `catalog ${v.x}x${v.y}x${v.z} mm, profile ${w}x${d}x${h} mm` : 'same bed and height'
  if (e.makerDocs) return `| ${p.vendor} ${p.model} | written from the maker's ${e.makerDocs.firmware ? 'firmware source' : 'published pages'}, read ${e.makerDocs.checked} | ${g} | ${note} |`
  return `| ${p.vendor} ${p.model} | checked at ${machine.orcaCommit} | ${g} | ${note} |`
})
const text = `# Printer profiles

Each printer profile carries the machine settings of the maker's own profile for that model, checked against OrcaSlicer commit ${machine.orcaCommit}: bed shape and origin, printable height, nozzle and extruder offsets, machine limits, retraction and z hop defaults, G-code flavor, extruder clearance, thumbnails and the rest of the numbers and choices. \`packages/profiles/machine.json\` holds them and \`js/machine.test.ts\` locks them. A private script diffs them against the maker's current profiles and fails on any difference.

Where the printer catalog and the maker's profile disagree, the profile's value is the one in the printer config (\`printerConfig\`). Start, end, layer change, filament change, pause and time lapse G-code (and the file start G-code where the maker has one) is the maker's own text as OrcaSlicer 2.4.2 resolves it for the printer's default filament (the owner reported the makers' permission on 2026-09-30), and written for SlicerX for printers Orca has no preset for. The shipped text is compared with Orca 2.4.2's resolved text for every printer that has a dump.

The Sovol SV04 has no maker profile to read, so its machine settings are written from Sovol's published firmware source (Marlin 2.0.9.2, \`Marlin/Configuration.h\` and \`Marlin/Configuration_adv.h\` of https://github.com/Sovol3d/SV04-IDEX-3D-Printer-Mainboard-Source-code at commit 1867fcba, read 2026-11-09; \`machine.json\` names them under \`makerDocs\`): two extruders with 0.4 mm nozzles, the 300 x 300 x 400 mm volume Sovol states for it, extruder offsets of zero (the firmware runs in its auto-park mode and applies the carriage offset itself), and the firmware's speed, acceleration and jerk limits. Its G-code family \`sovol_sv04\` was written for SlicerX and is in \`packages/profiles/gcode-written.json\`: the start heats both nozzles together when the plate uses both and primes each along its own edge of the bed, and a tool change is a \`T\` command followed by a wait for the new tool's temperature, with no manual swap. These values are estimated, not from Sovol: the right tool's prime line (X 298, Y 10 to 140 and back at X 297.6), the left tool's prime line (X 2, Y 10 to 140 and back at X 2.4), the prime height (Z 0.28) and length (10 mm each way), the travel height before each prime (Z 5), the 150 °C nozzle temperature while homing, and the whole end block: a lift to 2 mm above the print, the present move of the bed to Y 240 (80 percent of the bed), and a lift to 70 mm above the print (at most 10 mm under the top). Every one of these moves is inside the bed and inside the X range both carriages reach (the left one X -62 to 302, the right one X 0 to 362), and the end lifts before it moves; \`packages/core/tests/sv04_tool_changes.rs\` checks that on the sliced G-code. The limits are the firmware's compiled defaults, so a printer whose settings were changed from its screen or saved with \`M500\` may differ. This profile has not been run on a real SV04. Duplication and mirror modes are not covered.

The Prusa Core One with INDX has no maker profile to read yet, so its machine settings are written from the public INDX pages (Prusa's INDX conversion kit page and Bondtech's INDX documentation, read 2026-11-09; \`machine.json\` names them under \`makerDocs\`): eight tools with 0.4 mm nozzles (the kits have 4 or 8 tools; a print uses one per filament), the 248 x 205 x 270 mm volume Prusa states with INDX fitted, a tool change time of 12 s (Prusa: about 12 s per change for PLA), and extruder offsets of zero (the firmware keeps each tool's offset). The motion limits, retraction, z hop, clearances and thumbnails are copied from the plain Core One's profile, since the kit changes the head and not the motion system. A tool change is left to the printer's firmware: our G-code never moves the head to a dock or the purge collector, whose positions are estimated and used only for Preview and the time estimate. Its G-code family \`prusa_core_one_indx\` takes the plain Core One's own start, end, layer change and pause G-code and changes only what INDX needs: the start picks up the first tool (\`T[initial_tool]\`) right after homing and waits for its temperature there, reads the first tool's nozzle, filament and temperature instead of the first slot's, and moves its three positions in front of the bed onto it (estimated: the chamber heating spot X 242 Y 10, the limited mesh area at Y 2, the purge start X 247 Y 2); the end parks at X 242 Y 200 instead of in front of the bed (estimated), after the Core One's own lift. A tool change is our own: a \`T\` command and a wait for the new tool's temperature, with no manual swap and no move of ours. The profile has not been run on a real printer. It is replaced once Prusa publishes its own INDX printer profile.

| Model | Machine settings | G-code | Bed and height |
| --- | --- | --- | --- |
${rows.join('\n')}
`
writeFileSync(here('../docs/printer-profiles.md'), text)
console.log(`${rows.length} rows`)
