// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Turns a job request ("12 strong PETG brackets by Friday") into goals and
// setting targets. The goals, their phrases, levels and changes come from
// knowledge/intents (intent_goal records) and are merged with the rules in
// knowledge/intents/tradeoffs.yaml, so the numbers come from the knowledge
// base rather than the model's memory.
import type { KbDoc, KnowledgeBase } from './kb/kb'

export interface SettingTarget {
  key: string
  op: 'set' | 'at_least' | 'at_most' | 'enable' | 'disable'
  value: number | string | boolean
  goal: string
  priority: 'core' | 'supporting'
  reason: string
  sources: string[]
}

export interface Intent {
  count: number | null
  part: string | null
  material: string | null
  materialSuggested?: { id: string; reason: string }
  goals: { id: string; level: string }[]
  deadline: { text: string; date: string; days: number } | null
  printers: string[]
  targets: SettingTarget[]
  /** Advice from the goals: orientation, checks, hardware levers, tradeoff notes. */
  notes: string[]
  /** Questions to ask before planning, from tradeoff pairs that need the user's call. */
  ask: string[]
  sources: string[]
}

type Rec = Record<string, unknown>
const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string')
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, dozen: 12, fifty: 50, hundred: 100,
}
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function parseCount(t: string): number | null {
  const m = t.match(/(?:^|\s)(\d{1,4})(?:\s*x)?\s+(?!mm\b|c\b|%|days?\b|hours?\b|h\b|min)/)
  if (m?.[1]) return Number(m[1])
  for (const [w, n] of Object.entries(NUMBER_WORDS)) if (new RegExp(`\\b${w}\\b`).test(t)) return n
  return null
}

function parsePart(t: string): string | null {
  const m = t.match(/\b(?:\d{1,4}|a dozen|dozen|two|three|four|five|six|ten|twelve|twenty)\s+(?:[a-z0-9]+\s+){0,3}?([a-z]{3,}s)\b/)
  const skip = new Set(['pieces', 'copies', 'pcs', 'printers', 'days', 'hours', 'plates', 'spools', 'layers', 'walls', 'minutes'])
  return m?.[1] && !skip.has(m[1]) ? m[1] : null
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function parseDeadline(t: string, today: string): Intent['deadline'] {
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay()
  const byDay = t.match(/\b(by|before|until|for|on)\s+(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/)
  if (byDay?.[3]) {
    let days = (DAYS.indexOf(byDay[3]) - dow + 7) % 7
    if (days === 0 || byDay[2]) days += 7
    return { text: `${byDay[1]} ${byDay[2] ?? ''}${byDay[3]}`.replace(/\s+/g, ' '), date: addDays(today, days), days }
  }
  if (/\btomorrow\b/.test(t)) return { text: 'tomorrow', date: addDays(today, 1), days: 1 }
  if (/\b(tonight|today|by this evening)\b/.test(t)) return { text: 'today', date: today, days: 0 }
  const inDays = t.match(/\bin\s+(\d+)\s+days?\b/)
  if (inDays?.[1]) return { text: `in ${inDays[1]} days`, date: addDays(today, Number(inDays[1])), days: Number(inDays[1]) }
  if (/\b(this|by the)\s+weekend\b/.test(t)) {
    const days = (6 - dow + 7) % 7 || 7
    return { text: 'this weekend', date: addDays(today, days), days }
  }
  return null
}

function findMaterial(t: string, kb: KnowledgeBase): string | null {
  const candidates: { id: string; alias: string }[] = []
  for (const d of kb.all('filament')) for (const a of [d.id, d.name, ...d.aliases]) candidates.push({ id: d.id, alias: a.toLowerCase() })
  candidates.sort((a, b) => b.alias.length - a.alias.length)
  for (const c of candidates) {
    const re = new RegExp(`(^|[^a-z0-9])${esc(c.alias).replace(/[_\s-]+/g, '[\\s_-]*')}($|[^a-z0-9])`)
    if (re.test(t)) return c.id
  }
  return null
}

function phraseHit(t: string, phrase: string): number {
  const re = new RegExp(`(^|[^a-z0-9])${esc(phrase.toLowerCase()).replace(/\s+/g, '\\s+')}($|[^a-z0-9])`)
  const m = re.exec(t)
  return m ? m.index : -1
}

/** Resolves a level's changes, following `extends` (base first, so the level overrides it). */
function levelChanges(goal: KbDoc, level: string, depth = 0): Rec[] {
  const levels = obj(goal.data['levels'])
  const lv = obj(levels[level])
  const base = typeof lv['extends'] === 'string' && depth < 4 ? levelChanges(goal, lv['extends'], depth + 1) : []
  const own = arr(lv['changes']).map(obj)
  const keys = new Set(own.map((c) => String(c['key'])))
  return [...base.filter((c) => !keys.has(String(c['key']))), ...own]
}

function path(v: unknown, p: string): unknown {
  let cur = v
  for (const k of p.split('.')) cur = obj(cur)[k]
  return cur
}

const roundTo = (v: number, step: number): number => Math.round(Math.round(v / step) * step * 1000) / 1000

function resolveValue(change: Rec, material: KbDoc | undefined, nozzle: number): number | string | boolean | undefined {
  if (change['op'] === 'enable') return true
  if (change['op'] === 'disable') return false
  const direct = change['value']
  if (typeof direct === 'number' || typeof direct === 'string' || typeof direct === 'boolean') return direct
  const from = obj(change['value_from'])
  if (typeof from['nozzle_factor'] === 'number') {
    const v = nozzle * from['nozzle_factor']
    return typeof from['round_to'] === 'number' ? roundTo(v, from['round_to']) : Math.round(v * 100) / 100
  }
  if (typeof from['filament_range'] === 'string' && material) {
    const r = obj(material.data[from['filament_range']])
    const lo = num(r['min'])
    const hi = num(r['max'])
    if (lo === undefined || hi === undefined) return undefined
    const v = lo + (hi - lo) * (num(from['position']) ?? 0.5)
    return typeof from['round_to'] === 'number' ? roundTo(v, from['round_to']) : v
  }
  if (typeof from['filament'] === 'string' && material) {
    const v = path(material.data, from['filament'])
    return typeof v === 'number' || typeof v === 'string' ? v : undefined
  }
  return undefined
}

export function parseIntent(text: string, kb: KnowledgeBase, today: string, opts: { nozzle?: number; material?: string } = {}): Intent {
  const t = ` ${text.toLowerCase().replace(/[’']/g, "'")} `
  const nozzle = opts.nozzle ?? 0.4
  const material = findMaterial(t, kb) ?? null
  const intent: Intent = {
    count: parseCount(t),
    part: parsePart(t),
    material,
    goals: [],
    deadline: parseDeadline(t, today),
    printers: [...t.matchAll(/\bbay[\s-]?(\d+)\b/g)].map((m) => `bay-${m[1]}`),
    targets: [],
    notes: [],
    ask: [],
    sources: [],
  }

  // Goals in the order the user stated them; earlier stated goals win set conflicts.
  const goalDocs = kb.all('intent').filter((d) => d.data['kind'] === 'intent_goal')
  const hits: { doc: KbDoc; at: number }[] = []
  for (const d of goalDocs) {
    const phrases = [d.id.replaceAll('_', ' '), String(d.data['label'] ?? ''), ...strs(d.data['phrases'])].filter((p) => p.length > 2)
    const at = Math.min(...phrases.map((p) => phraseHit(t, p)).filter((i) => i >= 0), Infinity)
    if (Number.isFinite(at)) hits.push({ doc: d, at })
  }
  hits.sort((a, b) => a.at - b.at)
  for (const h of hits) {
    const levels = Object.keys(obj(h.doc.data['levels']))
    const strongWord = new RegExp(`\\b(very|extra|max|maximum|super|really|extremely)\\s+(${strs(h.doc.data['phrases']).slice(0, 6).map(esc).join('|')})`).test(t)
    const level = strongWord && levels.includes('max') ? 'max' : /\b(draft|rough|test fit)\b/.test(t) && levels.includes('draft') ? 'draft' : String(h.doc.data['default_level'] ?? levels[0] ?? 'standard')
    intent.goals.push({ id: h.doc.id, level })
  }

  if (!material) {
    const hinted = hits.map((h) => strs(obj(h.doc.data['material_hints'])['prefer'])[0]).find(Boolean)
    const pick = opts.material ?? hinted ?? 'pla'
    const doc = kb.get('filament', pick)
    intent.materialSuggested = { id: doc?.id ?? pick, reason: opts.material ? 'Loaded on the target printer' : hinted ? `Preferred by the ${hits[0]?.doc.name ?? 'stated'} goal in the knowledge base` : 'Easiest to print when nothing in the request needs more' }
  }
  const mat = kb.get('filament', material ?? intent.materialSuggested?.id ?? 'pla')

  // Collect every goal's changes, then merge per key.
  const tradeoffs = kb.get('intent', 'tradeoffs')
  const pairs = arr(tradeoffs?.data['pairs']).map(obj)
  const goalIds = intent.goals.map((g) => g.id)
  const keepFor = new Map<string, string>()
  for (const p of pairs) {
    const gs = strs(p['goals'])
    const applies = gs.every((g) => g === 'any' || goalIds.includes(g)) && gs.some((g) => g !== 'any')
    if (!applies) continue
    for (const [k, v] of Object.entries(obj(p['keep']))) if (typeof v === 'string') keepFor.set(k, v)
    if (typeof p['tell_user'] === 'string') intent.notes.push(p['tell_user'])
    if (typeof p['ask'] === 'string' && gs.every((g) => goalIds.includes(g))) intent.ask.push(p['ask'])
  }

  const byKey = new Map<string, SettingTarget[]>()
  for (const g of intent.goals) {
    const doc = hits.find((h) => h.doc.id === g.id)?.doc
    if (!doc) continue
    const changes = levelChanges(doc, g.level)
    const rule = obj(doc.data['cooling_rule'])
    if (mat && strs(rule['applies_to']).includes(mat.id) && rule['change']) changes.push(obj(rule['change']))
    for (const c of changes) {
      const key = String(c['key'] ?? '')
      const op = String(c['op'] ?? 'set')
      if (!key || !['set', 'at_least', 'at_most', 'enable', 'disable'].includes(op)) continue
      const value = resolveValue(c, mat, nozzle)
      if (value === undefined) continue
      const target: SettingTarget = {
        key,
        op: op as SettingTarget['op'],
        value,
        goal: g.id,
        priority: c['priority'] === 'core' ? 'core' : 'supporting',
        reason: String(c['why'] ?? `${doc.name} goal`),
        sources: strs(c['src']),
      }
      byKey.set(key, [...(byKey.get(key) ?? []), target])
    }
    for (const a of arr(doc.data['orientation']).map(obj)) if (typeof a['advice'] === 'string') intent.notes.push(a['advice'])
  }

  const rank = (x: SettingTarget): number => (keepFor.get(x.key) === x.goal ? -10 : 0) + (x.priority === 'core' ? -1 : 0) + goalIds.indexOf(x.goal) * 0.01
  for (const [key, list] of byKey) {
    let pick: SettingTarget | undefined
    const numeric = list.filter((x) => typeof x.value === 'number')
    const lows = numeric.filter((x) => x.op === 'at_least')
    const highs = numeric.filter((x) => x.op === 'at_most')
    const sets = list.filter((x) => x.op === 'set' || x.op === 'enable' || x.op === 'disable')
    const preferred = [...list].sort((a, b) => rank(a) - rank(b))[0]
    if (sets.length) pick = [...sets].sort((a, b) => rank(a) - rank(b))[0]
    else if (lows.length && highs.length) {
      const lo = Math.max(...lows.map((x) => Number(x.value)))
      const hi = Math.min(...highs.map((x) => Number(x.value)))
      pick = lo <= hi ? lows.find((x) => Number(x.value) === lo) : preferred
    } else if (lows.length) pick = lows.find((x) => Number(x.value) === Math.max(...lows.map((y) => Number(y.value))))
    else if (highs.length) pick = highs.find((x) => Number(x.value) === Math.min(...highs.map((y) => Number(y.value))))
    if (!pick) continue
    const out = { ...pick }
    // Clamp to the catalog bounds and the material's range.
    const def = kb.setting(key)
    if (typeof out.value === 'number') {
      if (def?.bounds?.min !== undefined) out.value = Math.max(def.bounds.min, out.value)
      if (def?.bounds?.max !== undefined) out.value = Math.min(def.bounds.max, out.value)
      if (key === 'nozzle_temperature' && mat) {
        const r = obj(mat.data['nozzle_temp_c'])
        const lo = num(r['min'])
        const hi = num(r['max'])
        if (lo !== undefined) out.value = Math.max(lo, out.value)
        if (hi !== undefined) out.value = Math.min(hi, out.value)
      }
    }
    intent.targets.push(out)
  }
  intent.targets.sort((a, b) => a.key.localeCompare(b.key))

  if (intent.count && intent.count > 1) intent.notes.push(`Batch of ${intent.count}: spread plates across idle printers loaded with the same material before cutting quality.`)
  if (intent.deadline) {
    intent.notes.push(`Deadline ${intent.deadline.text} is ${intent.deadline.days} day${intent.deadline.days === 1 ? '' : 's'} out (${intent.deadline.date}). Slice with the goal settings first and spend quality only if the estimate misses it.`)
  }
  const matSources = mat?.sources.slice(0, 2) ?? []
  intent.sources = [...new Set([...intent.targets.flatMap((x) => x.sources), ...matSources])]
  return intent
}
