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
  return `| ${p.vendor} ${p.model} | checked at ${machine.orcaCommit} | ${g} | ${note} |`
})
const text = `# Printer profiles

Each printer profile carries the machine settings of the maker's own profile for that model, checked against OrcaSlicer commit ${machine.orcaCommit}: bed shape and origin, printable height, nozzle and extruder offsets, machine limits, retraction and z hop defaults, G-code flavor, extruder clearance, thumbnails and the rest of the numbers and choices. \`packages/profiles/machine.json\` holds them and \`js/machine.test.ts\` locks them. A private script diffs them against the maker's current profiles and fails on any difference.

Where the printer catalog and the maker's profile disagree, the profile's value is the one in the printer config (\`printerConfig\`). Start, end, layer change, filament change, pause and time lapse G-code (and the file start G-code where the maker has one) is the maker's own text as OrcaSlicer 2.4.2 resolves it for the printer's default filament (the owner reported the makers' permission on 2026-09-30), and written for SlicerX for printers Orca has no preset for. The shipped text is compared with Orca 2.4.2's resolved text for every printer that has a dump.

| Model | Machine settings | G-code | Bed and height |
| --- | --- | --- | --- |
${rows.join('\n')}
`
writeFileSync(here('../docs/printer-profiles.md'), text)
console.log(`${rows.length} rows`)
