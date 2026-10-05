// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Writes the user tiers into schema.json from scripts/tiers.json: mode (simple, advanced, expert, hidden), intent and
// showWhen. Idempotent. Run: node scripts/apply-tiers.mjs, then gen-defaults.mjs and gen-reference.mjs.
import { readFileSync, writeFileSync } from 'node:fs'

const url = (p) => new URL(p, import.meta.url)
const schema = JSON.parse(readFileSync(url('../schema.json'), 'utf8'))
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
writeFileSync(url('../schema.json'), JSON.stringify(schema, null, 1) + '\n')
const counts = {}
for (const d of list) if (d.section === 'process') counts[d.mode] = (counts[d.mode] ?? 0) + 1
console.log(counts)
