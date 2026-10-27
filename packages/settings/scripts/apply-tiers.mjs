// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Writes the user tiers into schema.json from scripts/tiers.json: mode (simple, advanced, expert, hidden), intent and
// showWhen. Idempotent. Run: node scripts/apply-tiers.mjs, then gen-defaults.mjs and gen-reference.mjs.
import { readFileSync, writeFileSync } from 'node:fs'

// --check: write nothing, name every schema entry that a run would change, and exit 1 when there is any
// (scripts/check-generated.mjs runs it this way).
const checkOnly = process.argv.includes('--check')
const url = (p) => new URL(p, import.meta.url)
const schemaText = readFileSync(url('../schema.json'), 'utf8')
const schema = JSON.parse(schemaText)
// A second parse, because the run below edits the entries of `schema` in place.
const before = new Map(JSON.parse(schemaText).settings.map((d) => [d.key, d]))
const t = JSON.parse(readFileSync(url('./tiers.json'), 'utf8'))
const list = schema.settings
const byKey = new Map(list.map((d) => [d.key, d]))

// New keys the engine already reads (defaults are the engine's own, so output does not change).
let lastProcess = list.findLastIndex((d) => d.section === 'process')
for (const n of t.newKeys) {
  if (byKey.has(n.key)) continue
  const d = { key: n.key, section: 'process', type: n.type, label: n.label, ...(n.unit ? { unit: n.unit } : {}), ...(n.min !== undefined ? { min: n.min } : {}), ...(n.max !== undefined ? { max: n.max } : {}), mode: 'expert', default: n.default, group: 'overhangs', invalidates: 'paths' }
  list.splice(++lastProcess, 0, d)
  byKey.set(d.key, d)
}

const easyMap = JSON.parse(readFileSync(url('../easy-map.json'), 'utf8'))
const easyKeys = new Set(easyMap.rules.flatMap((r) => (r.op === 'set' ? [r.key] : r.keys)))

const need = (k) => {
  const d = byKey.get(k)
  if (!d) throw new Error(`tiers.json names unknown key ${k}`)
  return d
}
const advanced = new Map()
for (const [intent, keys] of Object.entries(t.advanced)) for (const k of keys) { need(k); advanced.set(k, intent) }
for (const k of [...t.simple, ...t.hiddenProcess, ...t.hiddenOther, ...t.develop]) need(k)
const simple = new Set(t.simple)
const hidden = new Set([...t.hiddenProcess, ...t.hiddenOther])
const develop = new Set(t.develop)

function intentOf(d) {
  if (advanced.has(d.key)) return advanced.get(d.key)
  if (t.intentByKey[d.key]) return t.intentByKey[d.key]
  for (const [p, i] of Object.entries(t.intentByPrefix)) if (d.key.startsWith(p)) return i
  return t.intentByGroup[d.group] ?? 'quality'
}

for (const d of list) {
  delete d.intent
  delete d.showWhen
  if (easyKeys.has(d.key)) d.easy = true
  if (hidden.has(d.key)) { d.mode = 'hidden'; continue }
  if (d.section !== 'process') continue
  if (develop.has(d.key)) d.mode = 'develop'
  else if (d.mode === 'develop') d.mode = 'develop'
  else d.mode = simple.has(d.key) ? 'simple' : advanced.has(d.key) ? 'advanced' : 'expert'
  if (d.mode !== 'develop') d.intent = intentOf(d)
  const multi = d.group === 'multimaterial' || t.showWhenMulticolorKeys.includes(d.key) || t.showWhenMulticolorPrefix.some((p) => d.key.startsWith(p))
  if (multi) d.showWhen = 'multicolor'
}
const out = JSON.stringify(schema, null, 1) + '\n'
if (checkOnly) {
  // Entries are compared with their key order, since the file keeps it.
  const differs = []
  const describe = (a, b) => {
    const ka = Object.keys(a), kb = Object.keys(b)
    const gone = ka.filter((k) => !kb.includes(k)).map((k) => `drops ${k}`)
    const added = kb.filter((k) => !ka.includes(k)).map((k) => `adds ${k}`)
    const changed = kb.filter((k) => ka.includes(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => `changes ${k}`)
    const parts = [...gone, ...added, ...changed]
    return parts.length ? parts.join(', ') : `field order differs, a run writes ${kb.slice(kb.findIndex((k, i) => k !== ka[i])).join(', ')} last`
  }
  for (const d of list) {
    const old = before.get(d.key)
    if (!old) differs.push(`${d.key}: new entry`)
    else if (JSON.stringify(old) !== JSON.stringify(d)) differs.push(`${d.key}: ${describe(old, d)}`)
  }
  if (!differs.length && out !== schemaText) differs.push('schema.json: text differs outside the settings entries')
  if (differs.length) {
    // check-generated shows the last 15 lines of a failing generator, so a long list is cut to its first 12.
    const shown = differs.slice(0, 12).map((l) => `  ${l}`)
    if (differs.length > shown.length) shown.push(`  and ${differs.length - shown.length} more`)
    console.log(`apply-tiers would change ${differs.length} schema.json ${differs.length === 1 ? 'entry' : 'entries'}:\n${shown.join('\n')}`)
    process.exit(1)
  }
  console.log('apply-tiers: schema.json is current')
  process.exit(0)
}
writeFileSync(url('../schema.json'), out)
const counts = {}
for (const d of list) if (d.section === 'process') counts[d.mode] = (counts[d.mode] ?? 0) + 1
console.log(counts)
