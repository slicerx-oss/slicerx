// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings lookups, validation and planning over the schema, knowledge/ and
// the Easy mapping from @slicerx/settings.
import type { EasyGoal, PrintConfig, SettingDef, SettingIssue, SettingValue } from '@slicerx/contracts'
import { EASY_GOALS } from '@slicerx/contracts'
import { applyEasy, coerce, easyControlFor, goalEasy, sameValue, validate } from '@slicerx/settings'
import { normalizeId, type DataStore, type KnowledgeEntry } from './data'

export { sameValue }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function first(v: SettingValue | undefined): unknown {
  return Array.isArray(v) ? v[0] : v
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

/**
 * Converts a value from knowledge/, a profile or a client to the schema's
 * shape with the settings package's own coercion: per-extruder keys become
 * lists, `15%` becomes 15 on percent keys, numbers become strings on
 * float-or-percent keys. Values it cannot read pass through for validation to report.
 */
export function toSchemaValue(def: SettingDef | undefined, value: unknown): SettingValue {
  if (!def) return value as SettingValue
  const c = coerce(def, value)
  return c.ok === true ? c.value : (value as SettingValue)
}

// ---------------------------------------------------------------------------
// Lookup

export interface SettingExplanation {
  key: string
  label: string
  section: string
  group: string
  type: string
  unit?: string
  default: SettingValue
  min?: number
  max?: number
  enum_values?: string[]
  /** One or two plain sentences: what the setting does and when to change it. */
  summary?: string
  help?: string
  effect?: { increase?: string; decrease?: string }
  enabled_when?: { key: string; op: string; value: unknown }[]
  first_invalidated_stage: string
  pilot_rule?: string
  guardrails?: { min?: number; max?: number }
  note?: string
}

export function explainSetting(store: DataStore, key: string): SettingExplanation | undefined {
  const def = store.setting(key)
  if (!def) return undefined
  const cat = store.catalogEntry(key)
  return {
    key: def.key,
    label: def.label,
    section: def.section,
    group: def.group,
    type: def.type,
    ...(def.unit !== undefined ? { unit: def.unit } : {}),
    default: def.default,
    ...(def.min !== undefined ? { min: def.min } : {}),
    ...(def.max !== undefined ? { max: def.max } : {}),
    ...(def.enumValues ? { enum_values: def.enumValues } : {}),
    ...(def.note !== undefined ? { summary: def.note } : {}),
    ...(def.help !== undefined ? { help: def.help } : {}),
    ...(def.effect ? { effect: def.effect } : {}),
    ...(def.enabledWhen ? { enabled_when: def.enabledWhen } : {}),
    first_invalidated_stage: def.invalidates,
    ...(cat?.pilot !== undefined ? { pilot_rule: cat.pilot } : {}),
    ...(cat?.bounds ? { guardrails: cat.bounds } : {}),
    ...(cat?.note !== undefined ? { note: cat.note } : {}),
  }
}

export interface SettingMatch {
  key: string
  label: string
  section: string
  group: string
  unit?: string
}

/** Ranks schema entries against a free-text query: exact key, key prefix, label words, then note and help text. */
export function findSettings(store: DataStore, query: string, opts: { section?: string; group?: string } = {}): SettingMatch[] {
  const q = query.trim().toLowerCase()
  const words = q.split(/[\s_]+/).filter(Boolean)
  const scored: { def: SettingDef; score: number }[] = []
  for (const def of store.settingsSchema()) {
    if (opts.section && def.section !== opts.section) continue
    if (opts.group && def.group !== opts.group) continue
    const key = def.key.toLowerCase()
    const label = def.label.toLowerCase()
    const help = `${def.note ?? ''} ${def.help ?? ''}`.toLowerCase()
    let score = 0
    if (key === q.replace(/\s+/g, '_')) score += 100
    if (key.startsWith(q)) score += 30
    for (const w of words) {
      if (key.includes(w)) score += 10
      if (label.includes(w)) score += 8
      if (help.includes(w)) score += 1
    }
    if (words.length > 0 && words.every((w) => key.includes(w) || label.includes(w))) score += 20
    if (score > 0) scored.push({ def, score })
  }
  scored.sort((a, b) => b.score - a.score || a.def.key.localeCompare(b.def.key))
  return scored.map(({ def }) => ({
    key: def.key,
    label: def.label,
    section: def.section,
    group: def.group,
    ...(def.unit !== undefined ? { unit: def.unit } : {}),
  }))
}

// ---------------------------------------------------------------------------
// Validation

function conditionHolds(cfg: Record<string, unknown>, store: DataStore, c: { key: string; op: string; value: unknown }): boolean | undefined {
  const raw = c.key in cfg ? cfg[c.key] : store.setting(c.key)?.default
  if (raw === undefined) return undefined
  const v = Array.isArray(raw) ? raw[0] : raw
  const n = num(v)
  const t = num(c.value)
  switch (c.op) {
    case 'eq': return v === c.value
    case 'ne': return v !== c.value
    case 'gt': return n !== undefined && t !== undefined ? n > t : undefined
    case 'ge': return n !== undefined && t !== undefined ? n >= t : undefined
    case 'lt': return n !== undefined && t !== undefined ? n < t : undefined
    case 'le': return n !== undefined && t !== undefined ? n <= t : undefined
    case 'in': return Array.isArray(c.value) ? c.value.includes(v) : undefined
    case 'notin': return Array.isArray(c.value) ? !c.value.includes(v) : undefined
    default: return undefined
  }
}

/** Checks a raw client value against the schema type before coercion, which would otherwise hide mistakes such as 2.5 walls. */
function rawTypeIssue(def: SettingDef, v: unknown): SettingIssue | undefined {
  const c = coerce(def, v)
  const whole = (x: unknown): boolean => typeof x !== 'number' || Number.isInteger(x)
  const intLike = def.type === 'int' || def.type === 'ints'
  if (c.ok === true && !(intLike && !(Array.isArray(v) ? v.every(whole) : whole(v)))) return undefined
  if ((def.type === 'enum' || def.type === 'enums') && def.enumValues) {
    return { code: 'bad_enum', severity: 'error', keys: [def.key], message: `${def.key}: ${JSON.stringify(v)} is not one of ${def.enumValues.join(', ')}.` }
  }
  return { code: 'wrong_type', severity: 'error', keys: [def.key], message: `${def.key}: expected ${intLike ? 'whole numbers' : `a ${def.type} value`}, got ${JSON.stringify(v)}.` }
}

/**
 * Checks a partial or full config from a client. The settings package does
 * the schema and cross-key checks (types, Orca limits, layer height against
 * the nozzle, flow limits and more). This adds what only the MCP layer knows:
 * suggestions for unknown keys, raw type mistakes, Pilot guardrails from
 * knowledge/settings.yaml, keys that have no effect, fan order, and the nozzle
 * temperature against the filament's knowledge entry. Fixes are suggestions only.
 */
export function validateConfig(store: DataStore, config: Record<string, unknown>, opts: { nozzleDiameter?: number; filament?: string } = {}): SettingIssue[] {
  const issues: SettingIssue[] = []
  const typed: Record<string, SettingValue> = {}
  for (const [key, value] of Object.entries(config)) {
    const def = store.setting(key)
    if (!def) {
      const near = findSettings(store, key.replace(/_/g, ' ')).slice(0, 3).map((m) => m.key)
      issues.push({ code: 'unknown_key', severity: 'warning', keys: [key], message: `${key} is not an OrcaSlicer setting SlicerX knows.${near.length ? ` Did you mean ${near.join(', ')}?` : ''}` })
      continue
    }
    const bad = rawTypeIssue(def, value)
    if (bad) {
      issues.push(bad)
      continue
    }
    typed[key] = toSchemaValue(def, value)
  }

  const checked = { ...typed }
  if (opts.nozzleDiameter !== undefined && !('nozzle_diameter' in checked)) checked['nozzle_diameter'] = [opts.nozzleDiameter]
  const fromPackage = validate(checked as PrintConfig).filter((i) => i.code !== 'unknown_key' && (i.keys[0] !== 'nozzle_diameter' || 'nozzle_diameter' in typed || i.keys.length > 1))
  issues.push(...fromPackage)
  const rangeKeys = new Set(fromPackage.filter((i) => i.code === 'out_of_range' || i.code === 'outside_recommended_range').map((i) => i.keys[0]))

  for (const [key, value] of Object.entries(typed)) {
    const def = store.setting(key)
    const b = store.catalogEntry(key)?.bounds
    if (b && !rangeKeys.has(key)) {
      const bad = (Array.isArray(value) ? value : [value]).find((n) => typeof n === 'number' && ((b.min !== undefined && n < b.min) || (b.max !== undefined && n > b.max)))
      if (bad !== undefined) issues.push({ code: 'outside_guardrails', severity: 'warning', keys: [key], message: `${key} is ${String(bad)}, outside the range Pilot allows (${b.min ?? '-inf'} to ${b.max ?? 'inf'}${def?.unit ? ` ${def.unit}` : ''}).` })
    }
    for (const c of def?.enabledWhen ?? []) {
      if (conditionHolds(checked, store, c) === false) {
        issues.push({ code: 'no_effect', severity: 'info', keys: [key, c.key], message: `${key} has no effect while ${c.key} ${c.op} ${JSON.stringify(c.value)}.` })
        break
      }
    }
  }

  const fanMin = num(first(typed['fan_min_speed']))
  const fanMax = num(first(typed['fan_max_speed']))
  if (fanMin !== undefined && fanMax !== undefined && fanMin > fanMax) {
    issues.push({ code: 'fan_order', severity: 'warning', keys: ['fan_min_speed', 'fan_max_speed'], message: `fan_min_speed (${fanMin}) is above fan_max_speed (${fanMax}).` })
  }

  const typeName = first(typed['filament_type'])
  const filamentName = opts.filament ?? (typeof typeName === 'string' ? typeName : undefined)
  const filament = filamentName ? store.findKnowledge(['filament'], filamentName) : undefined
  const temp = num(first(typed['nozzle_temperature']))
  const range = filament && isRecord(filament.data['nozzle_temp_c']) ? filament.data['nozzle_temp_c'] : undefined
  if (filament && temp !== undefined && range) {
    const lo = num(range['min'])
    const hi = num(range['max'])
    const typical = num(range['typical'])
    if ((lo !== undefined && temp < lo) || (hi !== undefined && temp > hi)) {
      issues.push({ code: 'temp_outside_material', severity: 'warning', keys: ['nozzle_temperature', 'filament_type'], message: `${temp} C is outside the ${lo} to ${hi} C range for ${filament.name} in the knowledge base.`, ...(typical !== undefined ? { fix: { key: 'nozzle_temperature', value: [typical] } } : {}) })
    }
  }
  const rank = { error: 0, warning: 1, info: 2 } as const
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity])
}

// ---------------------------------------------------------------------------
// Knowledge-derived configs

interface Provenance {
  reason: string
  sources: string[]
}

type Layer = Map<string, { value: SettingValue; why: Provenance }>

/** Filament keys in pilot_defaults and the knowledge field that backs each. */
const FILAMENT_FIELDS: Record<string, { path: string[]; what: string; unit?: string }> = {
  nozzle_temperature: { path: ['nozzle_temp_c'], what: 'nozzle temperature', unit: 'C' },
  nozzle_temperature_initial_layer: { path: ['first_layer_nozzle_temp_c'], what: 'first layer nozzle temperature', unit: 'C' },
  hot_plate_temp: { path: ['bed_temp_c'], what: 'bed temperature', unit: 'C' },
  hot_plate_temp_initial_layer: { path: ['bed_temp_c'], what: 'first layer bed temperature', unit: 'C' },
  textured_plate_temp: { path: ['bed_temp_c'], what: 'bed temperature on textured PEI', unit: 'C' },
  textured_plate_temp_initial_layer: { path: ['bed_temp_c'], what: 'first layer bed temperature on textured PEI', unit: 'C' },
  cool_plate_temp: { path: ['bed_temp_c'], what: 'cool plate temperature', unit: 'C' },
  eng_plate_temp: { path: ['bed_temp_c'], what: 'engineering plate temperature', unit: 'C' },
  chamber_temperature: { path: ['chamber_temp_c'], what: 'chamber temperature', unit: 'C' },
  fan_min_speed: { path: ['cooling', 'fan_min_pct'], what: 'minimum part fan', unit: '%' },
  fan_max_speed: { path: ['cooling', 'fan_max_pct'], what: 'maximum part fan', unit: '%' },
  overhang_fan_speed: { path: ['cooling', 'overhang_fan_pct'], what: 'overhang fan', unit: '%' },
  close_fan_the_first_x_layers: { path: ['cooling', 'no_fan_first_layers'], what: 'layers without fan' },
  slow_down_layer_time: { path: ['cooling', 'min_layer_time_s'], what: 'minimum layer time', unit: 's' },
  filament_flow_ratio: { path: ['extrusion', 'flow_ratio'], what: 'flow ratio' },
  filament_max_volumetric_speed: { path: ['extrusion', 'max_volumetric_speed_mm3s'], what: 'maximum volumetric speed', unit: 'mm3/s' },
  retraction_length: { path: ['extrusion', 'retraction_mm'], what: 'retraction length', unit: 'mm' },
  filament_retraction_length: { path: ['extrusion', 'retraction_mm'], what: 'retraction length', unit: 'mm' },
  pressure_advance: { path: ['extrusion', 'pressure_advance'], what: 'pressure advance' },
}

function dig(obj: unknown, path: string[]): unknown {
  let cur = obj
  for (const p of path) cur = isRecord(cur) ? cur[p] : undefined
  return cur
}

function sourcesAt(entry: KnowledgeEntry, path: string[]): string[] {
  for (let i = path.length; i >= 0; i--) {
    const node = dig(entry.data, path.slice(0, i))
    const src = isRecord(node) ? node['src'] : undefined
    if (Array.isArray(src)) return src.filter((s): s is string => typeof s === 'string')
  }
  return []
}

function rangeText(node: unknown, unit?: string): string {
  if (!isRecord(node)) return ''
  const u = unit ? ` ${unit}` : ''
  const lo = num(node['min'])
  const hi = num(node['max'])
  const typ = num(node['typical'])
  if (lo !== undefined && hi !== undefined) return ` ${lo} to ${hi}${u}${typ !== undefined ? `, typical ${typ}${u}` : ''}`
  return typ !== undefined ? ` typical ${typ}${u}` : ''
}

/** Filament settings from a knowledge entry's pilot_defaults, each with a reason and sources. */
export function filamentLayer(store: DataStore, entry: KnowledgeEntry): Layer {
  const layer: Layer = new Map()
  const defaults = isRecord(entry.data['pilot_defaults']) ? entry.data['pilot_defaults'] : {}
  const put = (key: string, value: unknown, why: Provenance): void => {
    const def = store.setting(key)
    if (def) layer.set(key, { value: toSchemaValue(def, value), why })
  }
  const orcaType = entry.data['orca_filament_type']
  if (typeof orcaType === 'string') put('filament_type', orcaType, { reason: `${entry.name} uses Orca filament type ${orcaType}.`, sources: [`knowledge:${entry.path}`] })
  const density = num(dig(entry.data, ['properties', 'density_g_cm3', 'typical']))
  if (density !== undefined) put('filament_density', density, { reason: `${entry.name} density is about ${density} g/cm3; used for weight estimates.`, sources: sourcesAt(entry, ['properties', 'density_g_cm3']) })
  for (const [key, value] of Object.entries(defaults)) {
    const field = FILAMENT_FIELDS[key]
    const node = field ? dig(entry.data, field.path) : undefined
    const range = field ? rangeText(isRecord(node) && isRecord(node['direct_drive']) ? node['direct_drive'] : isRecord(node) && isRecord(node['standard_hotend']) ? node['standard_hotend'] : node, field.unit) : ''
    const note = isRecord(node) && typeof node['note'] === 'string' ? ` ${node['note'].trim().split(/(?<=\.)\s/)[0] ?? ''}` : ''
    const label = store.setting(key)?.label.toLowerCase() ?? key.replace(/_/g, ' ')
    const reason = field ? `${entry.name} ${field.what}${range ? `:${range}` : ''}.${note}` : `Default for ${entry.name} in the knowledge base: ${label} ${JSON.stringify(value)}.`
    put(key, value, {
      reason: reason.replace(/\.\./g, '.'),
      sources: [`knowledge:${entry.path}`, ...(field ? sourcesAt(entry, field.path) : [])],
    })
  }
  return layer
}

/** Process and machine values from a printer entry's profile_baseline plus its build volume. */
export function printerLayer(store: DataStore, entry: KnowledgeEntry): Layer {
  const layer: Layer = new Map()
  const baseline = isRecord(entry.data['profile_baseline']) ? entry.data['profile_baseline'] : undefined
  const values = baseline && isRecord(baseline['values']) ? baseline['values'] : {}
  const process = baseline && typeof baseline['process'] === 'string' ? baseline['process'] : undefined
  const src = baseline && Array.isArray(baseline['src']) ? baseline['src'].filter((s): s is string => typeof s === 'string') : []
  for (const [key, value] of Object.entries(values)) {
    const def = store.setting(key)
    if (!def) continue
    layer.set(key, { value: toSchemaValue(def, value), why: { reason: `${entry.name} baseline${process ? ` from the Orca process "${process}"` : ''}.`, sources: [`knowledge:${entry.path}`, ...src] } })
  }
  const vol = isRecord(entry.data['build_volume_mm']) ? entry.data['build_volume_mm'] : undefined
  const x = num(vol?.['x'])
  const y = num(vol?.['y'])
  const z = num(vol?.['printable_z_default']) ?? num(vol?.['z'])
  const volSrc = [`knowledge:${entry.path}`, ...sourcesAt(entry, ['build_volume_mm'])]
  if (x !== undefined && y !== undefined) layer.set('printable_area', { value: [[0, 0], [x, 0], [x, y], [0, y]], why: { reason: `${entry.name} bed is ${x} by ${y} mm.`, sources: volSrc } })
  if (z !== undefined) layer.set('printable_height', { value: z, why: { reason: `${entry.name} printable height is ${z} mm.`, sources: volSrc } })
  const firmware = entry.data['firmware']
  const flavor = firmware === 'klipper' ? 'klipper' : firmware === 'bambu' ? 'marlin' : firmware === 'reprapfirmware' ? 'reprapfirmware' : firmware === 'prusa' || firmware === 'marlin' ? 'marlin2' : undefined
  const flavorDef = store.setting('gcode_flavor')
  if (flavor && flavorDef?.enumValues?.includes(flavor)) layer.set('gcode_flavor', { value: flavor, why: { reason: `${entry.name} runs ${String(firmware)} firmware.`, sources: [`knowledge:${entry.path}`] } })
  return layer
}

function nozzleLayer(store: DataStore, nozzle: number, base: PrintConfig): Layer {
  const layer: Layer = new Map()
  const src = ['knowledge:settings.yaml']
  layer.set('nozzle_diameter', { value: toSchemaValue(store.setting('nozzle_diameter'), nozzle), why: { reason: `Nozzle set to ${nozzle} mm.`, sources: src } })
  const round = (v: number): number => Math.round(v * 100) / 100
  const lh = num(base['layer_height'])
  if (lh !== undefined && (lh > nozzle * 0.75 || lh < nozzle * 0.25)) {
    layer.set('layer_height', { value: round(Math.min(Math.max(lh, nozzle * 0.25), nozzle * 0.75)), why: { reason: `Layer height kept between 25 and 75 percent of the ${nozzle} mm nozzle.`, sources: src } })
  }
  layer.set('line_width', { value: toSchemaValue(store.setting('line_width'), round(nozzle * 1.05)), why: { reason: `Line width follows the ${nozzle} mm nozzle (105 percent).`, sources: src } })
  return layer
}

/** A full config from schema defaults, used when no profile is given. */
export function defaultConfig(store: DataStore): PrintConfig {
  const cfg: Record<string, SettingValue> = {}
  for (const def of store.settingsSchema()) cfg[def.key] = def.default
  return cfg as PrintConfig
}

export function layerConfig(layer: Layer): Record<string, SettingValue> {
  return Object.fromEntries([...layer].map(([k, v]) => [k, v.value]))
}

// ---------------------------------------------------------------------------
// Planning

const INTENT_WORDS: [EasyGoal, RegExp][] = [
  ['strong', /\b(strong|strength|functional|durable|tough|load|bracket|mechanical|sturdy)\b/i],
  ['fine', /\b(fine|detail|detailed|smooth|miniature|mini|figurine|display|quality|pretty)\b/i],
  ['draft', /\b(draft|fast|quick|prototype|test fit|rough|speed)\b/i],
  ['standard', /\b(standard|normal|default|balanced|everyday)\b/i],
]

/** Maps an intent (a goal name or a short sentence) to an Easy goal. */
export function intentGoal(intent: string): EasyGoal | undefined {
  const t = intent.trim().toLowerCase()
  if (t in EASY_GOALS) return t as EasyGoal
  return INTENT_WORDS.find(([, re]) => re.test(t))?.[0]
}

export interface PlanInput {
  filament?: string
  fromFilament?: string
  printer?: string
  fromPrinter?: string
  nozzleDiameter?: number
  intent?: string
  current?: Record<string, unknown>
}

export interface PlannedChange {
  key: string
  label: string
  unit?: string
  before: SettingValue | null
  after: SettingValue
  reason: string
  sources: string[]
}

export interface Plan {
  intent_goal?: EasyGoal
  from: { printer?: string; filament?: string }
  to: { printer?: string; filament?: string; nozzle_diameter?: number }
  changes: PlannedChange[]
  unresolved: { key?: string; reason: string }[]
  issues: SettingIssue[]
  config_patch: Record<string, SettingValue>
  computed_ms: number
}

/**
 * Deterministic settings plan: base config (schema defaults, the current
 * printer and filament, then the client's current values), then the target
 * printer, nozzle, filament and intent on top. Each changed key carries the
 * reason and sources of the layer that set it.
 */
export function planSettings(store: DataStore, input: PlanInput, now: () => number = () => performance.now()): Plan {
  const started = now()
  const unresolved: Plan['unresolved'] = []
  const find = (kind: 'filament' | 'printer', q: string | undefined): KnowledgeEntry | undefined => {
    if (q === undefined) return undefined
    const e = store.findKnowledge([kind], q)
    if (!e) unresolved.push({ reason: `No ${kind} named "${q}" in the knowledge base. Use slicerx_list_profiles to see the ids.` })
    return e
  }
  const toPrinter = find('printer', input.printer)
  // Without a previous printer the user is changing something else on the same printer, so its baseline belongs to both sides.
  const fromPrinter = input.fromPrinter !== undefined ? find('printer', input.fromPrinter) : toPrinter
  const fromFilament = find('filament', input.fromFilament)
  const toFilament = find('filament', input.filament)

  const base: Record<string, SettingValue> = { ...defaultConfig(store) }
  const baseWhy = new Map<string, Provenance>()
  const apply = (target: Record<string, SettingValue>, why: Map<string, Provenance>, layer: Layer): void => {
    for (const [k, v] of layer) {
      target[k] = v.value
      why.set(k, v.why)
    }
  }
  if (fromPrinter) apply(base, baseWhy, printerLayer(store, fromPrinter))
  if (fromFilament) apply(base, baseWhy, filamentLayer(store, fromFilament))
  for (const [k, v] of Object.entries(input.current ?? {})) base[k] = toSchemaValue(store.setting(k), v)

  const next: Record<string, SettingValue> = { ...base }
  const why = new Map<string, Provenance>()
  if (toPrinter && toPrinter !== fromPrinter) apply(next, why, printerLayer(store, toPrinter))
  if (input.nozzleDiameter !== undefined) apply(next, why, nozzleLayer(store, input.nozzleDiameter, next as PrintConfig))
  if (toFilament) apply(next, why, filamentLayer(store, toFilament))

  let goal: EasyGoal | undefined
  if (input.intent !== undefined) {
    goal = intentGoal(input.intent)
    if (!goal) {
      unresolved.push({ reason: `Could not map the intent "${input.intent}" to draft, standard, fine or strong. Pass one of those words.` })
    } else {
      const before = { ...next } as PrintConfig
      const after = applyEasy(goalEasy(goal), before)
      const easy = EASY_GOALS[goal]
      for (const [k, v] of Object.entries(after)) {
        if (sameValue(before[k], v)) continue
        next[k] = v
        const control = easyControlFor(k)
        const def = store.setting(k)
        const up = num(first(v)) !== undefined && num(first(before[k])) !== undefined ? (num(first(v)) as number) > (num(first(before[k])) as number) : undefined
        const effect = up === undefined ? undefined : up ? def?.effect?.increase : def?.effect?.decrease
        why.set(k, {
          reason: `Intent "${goal}" (Easy detail ${easy.detail}, strength ${easy.strength}, speed ${easy.speed})${control ? ` via the ${control} control` : ''}.${effect ? ` ${effect}.` : ''}`,
          sources: ['slicerx:packages/settings/easy-map.json'],
        })
      }
    }
  }

  const changes: PlannedChange[] = []
  const patch: Record<string, SettingValue> = {}
  for (const [key, after] of Object.entries(next)) {
    const before = base[key]
    if (sameValue(before, after)) continue
    const def = store.setting(key)
    const w = why.get(key) ?? { reason: 'Changed by the plan.', sources: [] }
    patch[key] = after
    changes.push({ key, label: def?.label ?? key, ...(def?.unit !== undefined ? { unit: def.unit } : {}), before: before ?? null, after, reason: w.reason, sources: [...new Set(w.sources)] })
  }
  changes.sort((a, b) => a.key.localeCompare(b.key))

  if (toFilament && toPrinter) {
    const hotendMax = num(dig(toPrinter.data, ['hotend', 'max_temp_c']))
    const t = num(first(next['nozzle_temperature']))
    if (hotendMax !== undefined && t !== undefined && t > hotendMax) unresolved.push({ key: 'nozzle_temperature', reason: `${toFilament.name} wants ${t} C but the ${toPrinter.name} hotend tops out at ${hotendMax} C.` })
    const nozzleNeeds = dig(toFilament.data, ['nozzle', 'hardened_required'])
    if (nozzleNeeds === true) unresolved.push({ key: 'nozzle_diameter', reason: `${toFilament.name} is abrasive and needs a hardened steel nozzle. Check the one installed.` })
  }

  const nozzle = input.nozzleDiameter ?? num(first(next['nozzle_diameter']))
  const issues = validateConfig(store, patch, { ...(nozzle !== undefined ? { nozzleDiameter: nozzle } : {}), ...(toFilament ? { filament: toFilament.id } : {}) })
  return {
    ...(goal ? { intent_goal: goal } : {}),
    from: { ...(fromPrinter ? { printer: fromPrinter.id } : {}), ...(fromFilament ? { filament: fromFilament.id } : {}) },
    to: { ...(toPrinter ? { printer: toPrinter.id } : {}), ...(toFilament ? { filament: toFilament.id } : {}), ...(input.nozzleDiameter !== undefined ? { nozzle_diameter: input.nozzleDiameter } : {}) },
    changes,
    unresolved,
    issues,
    config_patch: patch,
    computed_ms: Math.round((now() - started) * 100) / 100,
  }
}

export { normalizeId }
