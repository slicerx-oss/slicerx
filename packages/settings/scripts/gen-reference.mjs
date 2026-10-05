// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Writes docs/reference/: one file per section and group with every setting in schema.json,
// plus an index. `--check` fails when the committed files differ from what the schema says.
// Usage: node scripts/gen-reference.mjs [--check]
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkg = new URL('../', import.meta.url)
const outDir = fileURLToPath(new URL('docs/reference/', pkg))
const guideLink = '../guide.md'
const schema = JSON.parse(readFileSync(new URL('schema.json', pkg), 'utf8'))
const easy = JSON.parse(readFileSync(new URL('easy-map.json', pkg), 'utf8'))
const settings = schema.settings
const byKey = new Map(settings.map((d) => [d.key, d]))

const SECTION = { process: 'Process', filament: 'Filament', printer: 'Printer' }
const SECTION_NOTE = {
  process: 'Print settings: layers, walls, infill, speeds, supports, adhesion.',
  filament: 'Material settings: temperatures, cooling, flow, retraction, drying.',
  printer: 'Machine settings: bed and nozzle geometry, motion limits, G-code, network.',
}
const GROUP_TITLE = {
  quality: 'Quality and geometry', strength: 'Strength: walls, shells and infill', speed: 'Speed', support: 'Support', adhesion: 'Adhesion: skirt, brim and raft',
  overhangs: 'Overhangs and bridges', motion: 'Acceleration, jerk and machine limits', special: 'Special modes', advanced: 'Advanced extrusion',
  multimaterial: 'Multi material', gcode: 'G-code', profile: 'Profile metadata', cooling: 'Cooling', temperature: 'Temperature', extrusion: 'Extrusion',
  retraction: 'Retraction', drying: 'Drying', filament: 'Filament properties', machine: 'Machine', network: 'Network and hosts', others: 'Other',
}
const STAGE = {
  layers: 'layers (the whole slice)', contours: 'contours', perimeters: 'perimeters', surfaces: 'surfaces', infill: 'infill', paths: 'paths',
  gcode: 'G-code only', preview: 'preview only',
}
const TYPE = {
  float: 'number', int: 'integer', bool: 'boolean', percent: 'percent (a number, 15 means 15%)', floatOrPercent: 'millimeters or percent (string such as "0.42" or "110%")',
  enum: 'enum', string: 'string', gcode: 'G-code text', point: 'point [x, y]', floats: 'list of numbers, one per extruder', ints: 'list of integers, one per extruder',
  bools: 'list of booleans, one per extruder', percents: 'list of percents, one per extruder', floatsOrPercents: 'list of millimeter or percent strings, one per extruder',
  enums: 'list of enum values, one per extruder', strings: 'list of strings, one per extruder', points: 'list of points [x, y]', pointsGroups: 'list of point lists',
}
const UNIT = { mm: 'mm', 'mm/s': 'mm/s', 'mm/s2': 'mm/s2', 'mm3/s': 'mm3/s', '%': '%', C: 'C', s: 's', 'g/cm3': 'g/cm3', deg: 'degrees', 'money/kg': 'money per kg', mm3: 'mm3', layers: 'layers', Hz: 'Hz', 'delta-C': 'C (difference)', 'money/h': 'money per hour' }
const OPS = { eq: 'is', ne: 'is not', gt: 'is above', ge: 'is at least', lt: 'is below', le: 'is at most', in: 'is one of', notin: 'is none of' }

const label = (k) => byKey.get(k)?.label ?? k
const fmt = (v) => {
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (typeof v === 'string') return v === '' ? 'empty' : JSON.stringify(v)
  if (Array.isArray(v)) return v.length === 0 ? 'empty list' : JSON.stringify(v).length > 90 ? JSON.stringify(v).slice(0, 87) + '...' : JSON.stringify(v)
  return String(v)
}
const oneLine = (s) => s.replace(/\s+/g, ' ').trim()

// Which Easy control writes each key.
const easyBy = new Map()
for (const r of easy.rules) for (const k of r.op === 'set' ? [r.key] : r.keys) easyBy.set(k, { rule: r, control: easy.controls[r.control]?.label ?? r.control })

function easyText(k) {
  const e = easyBy.get(k)
  if (!e) return undefined
  const r = e.rule
  if (r.op === 'scale') return `Scaled by the ${e.control} control (speed presets ${Object.entries(easy.speed_factors).map(([n, f]) => `${n} ${f}x`).join(', ')}); never below its own value because of a flow or acceleration cap.`
  return `Set by the ${e.control} control${r.note ? `. ${oneLine(r.note).replace(/\.$/, '')}` : ''}.`
}

function entry(d) {
  const lines = [`### \`${d.key}\``, '', `**${d.label}**${d.mode === 'develop' ? ' (develop mode)' : ''}`, '']
  if (d.help) lines.push(oneLine(d.help), '')
  const rows = []
  rows.push(['Type', TYPE[d.type] ?? d.type])
  if (d.unit) rows.push(['Unit', UNIT[d.unit] ?? d.unit])
  rows.push(['Default', fmt(d.default)])
  if (d.min !== undefined || d.max !== undefined) rows.push(['Recommended range', `${d.min ?? 'no minimum'} to ${d.max ?? 'no maximum'}`])
  if (d.orcaMin !== undefined || d.orcaMax !== undefined) rows.push(['Orca limits', `${d.orcaMin === undefined ? (d.min ?? 'none') : (d.orcaMin ?? 'none')} to ${d.orcaMax === undefined ? (d.max ?? 'none') : (d.orcaMax ?? 'none')}`])
  if (d.auto) rows.push(['Automatic', 'The value 0 means automatic and is always allowed.'])
  if (d.nullable) rows.push(['Nullable', 'A profile can store `nil` to take the value from another profile; the key is then left out.'])
  if (d.enumValues?.length) {
    const vals = d.enumValues.map((v, i) => (d.enumLabels?.[i] && d.enumLabels[i] !== v ? `\`${v}\` (${d.enumLabels[i]})` : `\`${v}\``))
    rows.push(['Values', vals.join(', ')])
  }
  if (d.enabledWhen?.length) rows.push(['Used only when', d.enabledWhen.map((c) => `${label(c.key)} (\`${c.key}\`) ${OPS[c.op]} ${Array.isArray(c.value) ? c.value.map(fmt).join(', ') : fmt(c.value)}`).join('; and ')])
  if (d.section === 'process') rows.push(['Tier', `${{ simple: 'Simple', advanced: 'Advanced', expert: 'Expert', develop: 'Develop only', hidden: 'Hidden (profile key)' }[d.mode]}${d.intent ? `, ${d.intent}` : ''}${d.showWhen === 'multicolor' ? ', shown with two or more filaments' : ''}`])
  rows.push(['Changing it redoes', STAGE[d.invalidates] ?? d.invalidates])
  const et = easyText(d.key)
  if (et) rows.push(['Easy mode', et])
  rows.push(['mimir class', d.pilot ? { edit: 'edit (may change in a plate override)', guarded: 'guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)', read: 'read (never written)' }[d.pilot] : 'read (not in the catalog: never written)'])
  if (d.effect?.increase || d.effect?.decrease) rows.push(['Effect', [d.effect.increase && `higher: ${d.effect.increase}`, d.effect.decrease && `lower: ${d.effect.decrease}`].filter(Boolean).join('. ')])
  for (const [k, v] of rows) lines.push(`- ${k}: ${v}`)
  lines.push('')
  return lines.join('\n')
}

const files = new Map()
const groups = new Map()
for (const d of settings) {
  const id = `${d.section}-${d.group}`
  if (!groups.has(id)) groups.set(id, { section: d.section, group: d.group, items: [] })
  groups.get(id).items.push(d)
}
const order = ['process', 'filament', 'printer']
const sorted = [...groups.values()].sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section) || a.group.localeCompare(b.group))
for (const g of sorted) {
  const title = `${SECTION[g.section]}: ${GROUP_TITLE[g.group] ?? g.group}`
  const body = [
    `# ${title}`,
    '',
    `${g.items.length} settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](${guideLink}) for how to read and apply them.`,
    '',
    ...g.items.sort((a, b) => a.key.localeCompare(b.key)).map(entry),
  ].join('\n')
  files.set(`${g.section}-${g.group}.md`, body)
}
const idx = [
  '# Settings reference',
  '',
  `Every setting in the SlicerX schema: ${settings.length} keys, named like OrcaSlicer's settings (commit \`${schema.orca_commit}\`) so profiles interchange. Each entry gives the label, type, unit, default, range, allowed values, the settings it depends on, the slice stage it redoes, its Easy mode mapping and its mimir class. This reference is generated from \`schema.json\` by \`scripts/gen-reference.mjs\`; edit the schema inputs, not these files. Labels are our own wording.`,
  '',
  `How to read the fields is in the [guide](${guideLink}).`,
  '',
]
for (const s of order) {
  idx.push(`## ${SECTION[s]}`, '', SECTION_NOTE[s], '')
  for (const g of sorted.filter((x) => x.section === s)) idx.push(`- [${GROUP_TITLE[g.group] ?? g.group}](${g.section}-${g.group}.md): ${g.items.length} settings`)
  idx.push('')
}
idx.push('## Every key', '', 'Alphabetical, each linking to its group file.', '')
for (const d of [...settings].sort((a, b) => a.key.localeCompare(b.key))) idx.push(`- \`${d.key}\`: ${d.label}, [${d.section}/${d.group}](${d.section}-${d.group}.md#${d.key})`)
idx.push('')
files.set('index.md', idx.join('\n'))

const check = process.argv.includes('--check')
if (check) {
  let bad = 0
  const have = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith('.md')) : []
  for (const [name, text] of files) {
    if (!have.includes(name) || readFileSync(outDir + name, 'utf8') !== text + (text.endsWith('\n') ? '' : '\n')) {
      console.error('out of date:', name)
      bad++
    }
  }
  for (const f of have) if (!files.has(f)) {
    console.error('stale file:', f)
    bad++
  }
  process.exit(bad ? 1 : 0)
}
mkdirSync(outDir, { recursive: true })
for (const f of readdirSync(outDir)) if (f.endsWith('.md')) rmSync(outDir + f)
for (const [name, text] of files) writeFileSync(outDir + name, text.endsWith('\n') ? text : text + '\n')
console.log(files.size, 'files,', settings.length, 'settings')
