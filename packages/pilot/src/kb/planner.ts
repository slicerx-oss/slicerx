// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings planner over the knowledge base: filament pilot_defaults, printer
// profile baselines and nozzle geometry rules. Deterministic and fast (well
// under the 50 ms budget). packages/settings may replace it with its own
// planner of the same shape; mimir takes whichever the host injects.
import type { PilotMachine, SettingValue } from '@slicerx/contracts'
import type { PlannedChange, PlanResult, SettingsPlanner } from '../planner'
import type { KbDoc, KnowledgeBase } from './kb'

type Rec = Record<string, unknown>
const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const srcOf = (v: unknown): string[] => {
  const s = obj(v)['src']
  return Array.isArray(s) ? s.filter((x): x is string => typeof x === 'string') : []
}
const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Orca stores some numbers as "15%"; the planner works in plain numbers. */
function toValue(v: unknown): SettingValue | undefined {
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const m = v.match(/^(-?\d+(?:\.\d+)?)%$/)
    return m?.[1] ? Number(m[1]) : v
  }
  return undefined
}

function sectionFor(key: string): string {
  if (key.startsWith('nozzle_temperature_initial')) return 'first_layer_nozzle_temp_c'
  if (key.startsWith('nozzle_temperature')) return 'nozzle_temp_c'
  if (key.endsWith('_plate_temp')) return 'bed_temp_c'
  if (key.startsWith('fan_') || key.includes('fan') || key === 'slow_down_layer_time') return 'cooling'
  if (key === 'filament_flow_ratio') return 'extrusion.flow_ratio'
  if (key === 'filament_max_volumetric_speed') return 'extrusion.max_volumetric_speed_mm3s'
  if (key === 'retraction_length') return 'extrusion.retraction_mm'
  if (key === 'pressure_advance') return 'extrusion.pressure_advance'
  if (key === 'chamber_temperature') return 'chamber_temp_c'
  if (key === 'activate_air_filtration') return 'safety'
  return ''
}

function section(doc: KbDoc, path: string): Rec {
  let cur: unknown = doc.data
  for (const p of path.split('.').filter(Boolean)) cur = obj(cur)[p]
  return obj(cur)
}

function materialReason(key: string, doc: KbDoc, after: SettingValue): string {
  const sec = section(doc, sectionFor(key))
  const range = (r: Rec, unit: string): string => {
    const lo = n(r['min'])
    const hi = n(r['max'])
    return lo !== undefined && hi !== undefined ? `${lo} to ${hi} ${unit}` : ''
  }
  const name = doc.name
  if (key === 'nozzle_temperature') return `${name} prints at ${range(sec, 'C') || 'this temperature'}; ${String(after)} C is the documented starting point`
  if (key === 'nozzle_temperature_initial_layer') return `First layer temperature for ${name}`
  if (key.endsWith('_plate_temp')) return `Bed temperature for ${name} on this plate type${range(sec, 'C') ? ` (range ${range(sec, 'C')})` : ''}`
  if (key === 'fan_max_speed') return Number(after) >= 80 ? `${name} needs strong cooling for clean overhangs` : `Less fan keeps ${name} layers hot enough to bond`
  if (key === 'fan_min_speed') return `Minimum part cooling for ${name}`
  if (key === 'overhang_fan_speed') return `Cooling on overhangs and bridges for ${name}`
  if (key === 'close_fan_the_first_x_layers') return `Fan off for the first layers so ${name} sticks to the bed`
  if (key === 'slow_down_layer_time') return `Minimum layer time so small layers of ${name} can cool`
  if (key === 'filament_flow_ratio') return `Typical flow ratio for ${name}; confirm with a flow test`
  if (key === 'filament_max_volumetric_speed') return `${name} melts at up to about ${String(after)} mm3/s on a standard hotend`
  if (key === 'retraction_length') return `Direct drive retraction that controls ${name} stringing`
  if (key === 'pressure_advance') return `Typical pressure advance for ${name}; printer specific, calibrate`
  if (key === 'chamber_temperature') return `${name} warps without a warm chamber`
  if (key === 'activate_air_filtration') return `${name} gives off fumes; filter the chamber air`
  return `${name} default`
}

const LABEL_UNITS: Record<string, string> = {
  nozzle_temperature: 'C',
  nozzle_temperature_initial_layer: 'C',
  cool_plate_temp: 'C',
  eng_plate_temp: 'C',
  hot_plate_temp: 'C',
  textured_plate_temp: 'C',
  chamber_temperature: 'C',
  fan_min_speed: '%',
  fan_max_speed: '%',
  overhang_fan_speed: '%',
  slow_down_layer_time: 's',
  filament_max_volumetric_speed: 'mm3/s',
  retraction_length: 'mm',
  layer_height: 'mm',
  initial_layer_print_height: 'mm',
  line_width: 'mm',
  outer_wall_line_width: 'mm',
  inner_wall_line_width: 'mm',
  sparse_infill_line_width: 'mm',
  sparse_infill_density: '%',
  outer_wall_speed: 'mm/s',
  inner_wall_speed: 'mm/s',
  sparse_infill_speed: 'mm/s',
  top_surface_speed: 'mm/s',
  initial_layer_speed: 'mm/s',
  travel_speed: 'mm/s',
  bridge_speed: 'mm/s',
  default_acceleration: 'mm/s2',
  outer_wall_acceleration: 'mm/s2',
  initial_layer_acceleration: 'mm/s2',
}

const SECTION_OF = (key: string): PlannedChange['section'] =>
  /temp|fan|flow_ratio|volumetric|retraction|pressure_advance|chamber|filtration|slow_down/.test(key) ? 'filament' : /acceleration|travel_speed/.test(key) ? 'printer' : 'process'

const round = (v: number, d: number): number => Math.round(v * 10 ** d) / 10 ** d

export function createKbPlanner(kb: KnowledgeBase): SettingsPlanner {
  return {
    plan(from: PilotMachine, to: PilotMachine, current: Record<string, SettingValue> = {}): PlanResult {
      const changes = new Map<string, PlannedChange>()
      const warnings: string[] = []
      const find = (kind: 'filament' | 'printer', q: string): KbDoc | undefined => kb.get(kind, q) ?? kb.search(q, { kinds: [kind], limit: 1 })[0]?.doc
      const fromMat = find('filament', from.material)
      const toMat = find('filament', to.material)
      const fromPr = find('printer', from.printer)
      const toPr = find('printer', to.printer)
      if (!toMat) warnings.push(`No knowledge entry for material "${to.material}"; filament settings were not recomputed.`)
      if (!toPr) warnings.push(`No knowledge entry for printer "${to.printer}"; printer limits were not checked.`)

      // Values the plate uses right now: overrides, then the from-machine defaults.
      const base = (key: string): SettingValue | null => {
        if (current[key] !== undefined) return current[key] ?? null
        const fd = fromMat ? toValue(obj(fromMat.data['pilot_defaults'])[key]) : undefined
        if (fd !== undefined) return fd
        const fb = fromPr ? toValue(obj(obj(fromPr.data['profile_baseline'])['values'])[key]) : undefined
        return fb ?? null
      }
      const put = (key: string, after: SettingValue, reason: string, sources: string[]): void => {
        const before = base(key)
        const prev = changes.get(key)
        const beforeVal = prev ? prev.before : before
        if (beforeVal !== null && typeof beforeVal === 'number' && typeof after === 'number' && Math.abs(beforeVal - after) < 1e-9) {
          changes.delete(key)
          return
        }
        if (beforeVal === after) {
          changes.delete(key)
          return
        }
        const change: PlannedChange = { key, label: kb.setting(key)?.label ?? key.replaceAll('_', ' '), section: SECTION_OF(key), before: beforeVal, after, reason, sources }
        const unit = LABEL_UNITS[key] ?? kb.setting(key)?.unit
        if (unit) change.unit = unit
        changes.set(key, change)
      }

      // Printer baseline: speeds and accelerations from the target printer's default process.
      if (toPr && (from.printer !== to.printer || !fromPr)) {
        const pb = obj(toPr.data['profile_baseline'])
        const vals = obj(pb['values'])
        const sources = srcOf(pb)
        for (const [key, raw] of Object.entries(vals)) {
          if (/line_width|layer_height/.test(key)) continue
          const v = toValue(raw)
          if (v === undefined) continue
          put(key, v, `${toPr.name} default process (${String(pb['process'] ?? 'baseline')})`, sources)
        }
      }

      // Material defaults.
      if (toMat && (from.material !== to.material || !fromMat)) {
        const defs = obj(toMat.data['pilot_defaults'])
        for (const [key, raw] of Object.entries(defs)) {
          const v = toValue(raw)
          if (v === undefined) continue
          put(key, v, materialReason(key, toMat, v), srcOf(section(toMat, sectionFor(key))).slice(0, 3))
        }
        const pa = obj(section(toMat, 'extrusion.pressure_advance')['direct_drive'])
        const paTyp = n(pa['typical'])
        if (paTyp !== undefined && !(toPr && /bambu/i.test(String(toPr.data['vendor'] ?? '')))) {
          put('pressure_advance', paTyp, materialReason('pressure_advance', toMat, paTyp), srcOf(section(toMat, 'extrusion.pressure_advance')).slice(0, 3))
        }
      }

      // Nozzle geometry.
      const nozzleChanged = from.nozzle !== to.nozzle
      const lh = nozzleChanged ? round(to.nozzle * 0.5, 2) : Number(base('layer_height') ?? to.nozzle * 0.5)
      const lw = nozzleChanged ? round(to.nozzle * 1.05, 2) : Number(base('line_width') ?? to.nozzle * 1.05)
      if (nozzleChanged) {
        const src = ['orca_src:src/libslic3r/PrintConfig.cpp']
        put('layer_height', lh, `Half the ${to.nozzle} mm nozzle; keep layers between 25 and 75 percent of the nozzle`, src)
        put('initial_layer_print_height', round(Math.min(to.nozzle * 0.75, lh + 0.05), 2), 'First layer a little thicker than the rest for adhesion', src)
        for (const k of ['line_width', 'outer_wall_line_width', 'inner_wall_line_width', 'sparse_infill_line_width']) {
          put(k, k === 'sparse_infill_line_width' ? round(to.nozzle * 1.12, 2) : lw, `About 105 percent of the ${to.nozzle} mm nozzle`, src)
        }
        const pa = toMat ? obj(section(toMat, 'extrusion.pressure_advance')['direct_drive']) : {}
        const paTyp = n(pa['typical'])
        if (paTyp !== undefined && from.nozzle > 0) {
          // PA falls roughly with nozzle area (Prusa: 0.053 at 0.4 mm, 0.032 at 0.6 mm for PETG).
          put('pressure_advance', round(paTyp * Math.pow(0.4 / to.nozzle, 1.25), 3), `Larger nozzles need less pressure advance; recalibrate`, toMat ? srcOf(section(toMat, 'extrusion.pressure_advance')).slice(0, 2) : [])
        }
      }

      // Flow limit: no feature may ask for more plastic than the hotend melts.
      const mvs = Number(changes.get('filament_max_volumetric_speed')?.after ?? base('filament_max_volumetric_speed') ?? NaN)
      if (Number.isFinite(mvs) && lh > 0 && lw > 0) {
        const cap = Math.floor(mvs / (lh * lw))
        for (const k of ['outer_wall_speed', 'inner_wall_speed', 'sparse_infill_speed', 'top_surface_speed']) {
          const cur = Number(changes.get(k)?.after ?? base(k) ?? NaN)
          if (Number.isFinite(cur) && cur > cap) {
            put(k, cap, `Capped by the ${mvs} mm3/s melt limit at ${lh} mm x ${lw} mm lines`, toMat ? srcOf(section(toMat, 'extrusion.max_volumetric_speed_mm3s')).slice(0, 2) : [])
          }
        }
      }

      // Compatibility checks.
      if (toMat && toPr) {
        const hot = obj(toPr.data['hotend'])
        const nozzleNeed = obj(toMat.data['nozzle'])
        const mats = Array.isArray(hot['nozzle_materials']) ? (hot['nozzle_materials'] as string[]) : []
        if (nozzleNeed['hardened_required'] === true && !String(hot['stock_nozzle'] ?? '').match(/hardened|steel|tungsten/i)) {
          warnings.push(`${toMat.name} is abrasive and needs a hardened nozzle; the ${toPr.name} ships with ${String(hot['stock_nozzle'] ?? 'a brass nozzle')}${mats.some((m) => /hardened/.test(m)) ? ' (a hardened option exists)' : ''}.`)
        }
        const maxT = n(hot['max_temp_c'])
        const needT = n(obj(toMat.data['nozzle_temp_c'])['min'])
        if (maxT !== undefined && needT !== undefined && maxT < needT) warnings.push(`${toPr.name} hotend reaches ${maxT} C, below the ${needT} C ${toMat.name} needs.`)
        const enc = String(obj(toMat.data['enclosure'])['level'] ?? '')
        const penc = String(obj(toPr.data['enclosure'])['type'] ?? '')
        if (enc === 'required' && !/enclosed|closed|full/.test(penc)) warnings.push(`${toMat.name} needs an enclosure; the ${toPr.name} is ${penc.replaceAll('_', ' ') || 'open'}. Expect warping on tall parts.`)
        const sizes = Array.isArray(hot['nozzle_diameters_mm']) ? (hot['nozzle_diameters_mm'] as number[]) : []
        if (sizes.length && !sizes.includes(to.nozzle)) warnings.push(`${toPr.name} is not listed with a ${to.nozzle} mm nozzle.`)
      }

      return { from, to, changes: [...changes.values()], warnings }
    },
  }
}
