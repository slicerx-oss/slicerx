// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Compiles knowledge/filaments and knowledge/printers into knowledge.json: the small table
// planSettings reads. Run with `pnpm --filter @slicerx/settings gen:knowledge`.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const root = fileURLToPath(new URL('../../../knowledge/', import.meta.url))
const out = fileURLToPath(new URL('../knowledge.json', import.meta.url))

const load = (dir) =>
  readdirSync(root + dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => parse(readFileSync(root + dir + '/' + f, 'utf8')))

const n = (v) => (typeof v === 'number' ? v : undefined)
const modeRatios = (modes) => {
  if (!modes) return undefined
  const pick = (x) => (x ? { minRatio: n(x.min_ratio), maxRatio: n(x.max_ratio) } : undefined)
  return { quality: pick(modes.quality), strength: pick(modes.strength) }
}
const range = (o) => (o && typeof o === 'object' && n(o.typical) !== undefined ? { min: n(o.min), max: n(o.max), typical: o.typical, src: o.src ?? [] } : undefined)
const strip = (o) => JSON.parse(JSON.stringify(o))

/** Numeric leaves of a nested object as dotted paths, for `value_from: {filament: path}`. */
function flatten(o, prefix = '', out = {}) {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o)) {
      if (k === 'src' || k === 'note') continue
      flatten(v, prefix ? prefix + '.' + k : k, out)
    }
  } else if (typeof o === 'number') out[prefix] = o
  return out
}

const materials = {}
for (const m of load('filaments')) {
  const cool = m.cooling ?? {}
  const ext = m.extrusion ?? {}
  const vol = ext.max_volumetric_speed_mm3s ?? {}
  materials[m.id] = strip({
    name: m.name,
    category: m.category,
    orcaType: m.orca_filament_type,
    nozzleTemp: range(m.nozzle_temp_c) && { ...range(m.nozzle_temp_c), src: m.nozzle_temp_c.src ?? [] },
    firstLayerTemp: range(m.first_layer_nozzle_temp_c),
    bedTemp: range(m.bed_temp_c),
    chamberTemp: m.chamber_temp_c && typeof m.chamber_temp_c === 'object' ? range(m.chamber_temp_c) : undefined,
    enclosure: m.enclosure?.level,
    cooling: {
      fanMin: n(cool.fan_min_pct?.typical),
      fanMax: n(cool.fan_max_pct?.typical),
      overhangFan: n(cool.overhang_fan_pct?.typical),
      noFanLayers: n(cool.no_fan_first_layers?.typical),
      minLayerTime: n(cool.min_layer_time_s?.typical),
      src: cool.src ?? [],
    },
    flowRatio: range(ext.flow_ratio),
    maxFlow: { standard: n(vol.standard_hotend?.typical), highFlow: n(vol.high_flow_hotend?.typical), src: vol.src ?? [] },
    retraction: { directDrive: n(ext.retraction_mm?.direct_drive?.typical), src: ext.retraction_mm?.src ?? [] },
    pressureAdvance: { directDrive: n(ext.pressure_advance?.direct_drive?.typical), bowden: n(ext.pressure_advance?.bowden?.typical), src: ext.pressure_advance?.src ?? [] },
    density: n(m.properties?.density_g_cm3?.typical),
    nozzle: { abrasive: m.nozzle?.abrasive === true, hardenedRequired: m.nozzle?.hardened_required === true, minDiameter: n(m.nozzle?.min_diameter_mm), src: m.nozzle?.src ?? [] },
    dryingNeed: m.drying?.need,
    softeningTemp: n(m.properties?.softening_temp_c?.typical),
    layerBand: m.layer_height?.fraction_of_nozzle && { min: n(m.layer_height.fraction_of_nozzle.min), max: n(m.layer_height.fraction_of_nozzle.max), typical: n(m.layer_height.fraction_of_nozzle.typical), src: m.layer_height.src ?? [] },
    smartLayerNotes: m.layer_height?.smart_layer && { quality: m.layer_height.smart_layer.quality_mode, strength: m.layer_height.smart_layer.strength_mode, thinLayerCooling: m.layer_height.smart_layer.thin_layer_cooling, src: m.layer_height.src ?? [] },
    speeds: m.speeds && { printMin: n(m.speeds.print_speed_mm_s?.min), printMax: n(m.speeds.print_speed_mm_s?.max), outerWallMax: n(m.speeds.outer_wall_max_mm_s?.value), firstLayerMax: n(m.speeds.first_layer_mm_s?.max), firstLayerTypical: n(m.speeds.first_layer_mm_s?.typical), src: m.speeds.src ?? [] },
    smartLayer: m.smart_layer && { minRatio: n(m.smart_layer.min_ratio), maxRatio: n(m.smart_layer.max_ratio), modes: modeRatios(m.smart_layer.modes), note: m.smart_layer.note, src: m.smart_layer.src ?? [] },
    retractionSpeed: range(ext.retraction_mm?.retraction_speed_mm_s),
    firstLayer: m.first_layer && {
      fanOffLayers: n(m.first_layer.fan_off_layers),
      speed: n(m.first_layer.speed_mm_s?.typical),
      bedNote: m.first_layer.bed_first_layer_note,
      squishNote: m.first_layer.squish_note,
      src: m.first_layer.src ?? [],
    },
    structure: m.structure && {
      wallsMin: n(m.structure.walls?.min),
      wallsTypical: n(m.structure.walls?.typical),
      wallsNote: m.structure.walls?.note,
      patternHint: m.structure.infill?.pattern_hint,
      densityNote: m.structure.infill?.density_note,
      src: m.structure.src ?? [],
    },
    supports: m.supports && {
      interfaceMaterials: m.supports.interface_materials ?? [],
      solubleMaterial: m.supports.soluble_pairing?.material,
      solubleDissolve: m.supports.soluble_pairing?.dissolve,
      topZ: n(m.supports.top_z_distance_mm?.typical),
      interfaceLayers: n(m.supports.interface_layers?.typical),
      note: m.supports.note,
      src: m.supports.src ?? [],
    },
    pilotDefaults: m.pilot_defaults,
    plates: (m.plates ?? []).map((pl) => ({ plate: pl.plate, fit: pl.fit, min: n(pl.bed_temp_c?.min), max: n(pl.bed_temp_c?.max) })),
    paths: flatten({
      nozzle_temp_c: m.nozzle_temp_c,
      first_layer_nozzle_temp_c: m.first_layer_nozzle_temp_c,
      bed_temp_c: m.bed_temp_c,
      cooling: m.cooling,
      extrusion: m.extrusion,
    }),
  })
}

// The minimum layer time a thin layer needs, by material family (sleipnir research).
const smartLayerDoc = parse(readFileSync(root + 'workflows/techniques/smart_layer.yaml', 'utf8'))
for (const fam of Object.values(smartLayerDoc.modes?.families ?? {})) {
  const g = fam.cooling_guard
  if (!g || n(g.min_layer_time_s) === undefined) continue
  for (const id of fam.applies_to ?? []) {
    if (materials[id]) materials[id].coolingGuard = strip({ minLayerTime: g.min_layer_time_s, note: g.note, src: g.src ?? [] })
  }
}

const printers = {}
for (const p of load('printers')) {
  if (p.kind !== 'printer') continue
  const hot = p.hotend ?? {}
  printers[p.id] = strip({
    name: p.name,
    vendor: p.vendor,
    firmware: p.firmware,
    extruder: p.extruder?.type,
    build: p.build_volume_mm && { x: n(p.build_volume_mm.x), y: n(p.build_volume_mm.y), z: n(p.build_volume_mm.z), zDefault: n(p.build_volume_mm.printable_z_default), src: p.build_volume_mm.src ?? [] },
    hotend: { maxTemp: n(hot.max_temp_c), nozzleDiameters: hot.nozzle_diameters_mm, nozzleMaterials: hot.nozzle_materials, stockNozzle: hot.stock_nozzle && { diameter: hot.stock_nozzle.diameter_mm, material: hot.stock_nozzle.material }, highFlow: hot.high_flow_option != null && hot.high_flow_option !== false, maxFlow: n(hot.max_flow_mm3s?.value), src: hot.src ?? [] },
    bed: { maxTemp: n(p.bed?.max_temp_c), src: p.bed?.src ?? [] },
    enclosure: { type: p.enclosure?.type, chamberHeating: p.enclosure?.chamber_heating, src: p.enclosure?.src ?? [] },
    motion: { maxSpeed: n(p.motion?.max_speed_mm_s), maxAccel: n(p.motion?.max_accel_mm_s2), src: p.motion?.src ?? [] },
    materials: { recommended: p.materials?.recommended, possible: p.materials?.possible, notRecommended: p.materials?.not_recommended, unlisted: p.materials?.unlisted },
    baselineProcess: p.profile_baseline?.process,
    baseline: p.profile_baseline?.values && { values: p.profile_baseline.values, src: p.profile_baseline.src ?? [] },
  })
}

// Intent goals, the pair rules that merge them, and what each calibration writes.
const change = (c) => ({ key: c.key, op: c.op, value: c.value, valueFrom: c.value_from, priority: c.priority ?? 'supporting', why: c.why, src: c.src ?? [] })
const advice = (list, extra = {}) => (list ?? []).filter((a) => a.advice).map((a) => ({ text: a.advice, kind: a.kind ?? 'workflow', src: a.src ?? [], ...extra }))
const text = (x) => (typeof x === 'string' ? { text: x, src: [] } : { text: x.text, src: x.src ?? [] })
const goals = {}
for (const g of load('intents').filter((d) => d.kind === 'intent_goal')) {
  const levels = {}
  for (const [name, lv] of Object.entries(g.levels ?? {})) levels[name] = { extends: lv.extends, changes: (lv.changes ?? []).map(change) }
  const hints = g.material_hints ?? {}
  goals[g.id] = strip({
    label: g.label,
    defaultLevel: g.default_level,
    implies: g.implies,
    levels,
    coolingRule: g.cooling_rule && { appliesTo: g.cooling_rule.applies_to, change: change(g.cooling_rule.change) },
    materialHints: { prefer: hints.prefer ?? g.prefer, acceptable: hints.acceptable ?? g.acceptable, avoid: hints.avoid ?? g.avoid, note: hints.note },
    materialNotes: g.material_notes && !Array.isArray(g.material_notes) ? g.material_notes : undefined,
    caveats: (g.caveats ?? []).map(text),
    alwaysShowCaveats: g.always_show_caveats === true,
    advice: [...advice(g.orientation), ...advice(g.hardware_rules), ...advice(g.hardware_levers)],
    constraints: (Array.isArray(g.constraints) ? g.constraints : []).map(text),
    checks: (g.checks ?? []).map((c) => (typeof c === 'string' ? c : c.text)),
    src: g.src ?? [],
  })
}
const tradeoffs = load('intents').find((d) => d.kind === 'intent_tradeoffs')
const pairs = (tradeoffs?.pairs ?? []).map((p) => strip({ goals: p.goals, resolution: p.resolution, keep: p.keep, ask: p.ask, never: p.never, tellUser: p.tell_user }))
const calibrations = {}
for (const w of readdirSync(root + 'workflows/calibration').filter((f) => f.endsWith('.yaml')).map((f) => parse(readFileSync(root + 'workflows/calibration/' + f, 'utf8')))) {
  if (w.writes) calibrations[w.id] = w.writes.filter((x) => x.key).map((x) => strip({ key: x.key, op: x.op, value: x.value, valueFrom: x.value_from, why: x.why }))
}

writeFileSync(out, JSON.stringify({ comment: 'Generated by scripts/gen-knowledge.mjs from knowledge/.', materials, printers, goals, pairs, calibrations }, null, 1) + '\n')
console.log(Object.keys(materials).length, 'materials,', Object.keys(printers).length, 'printers,', Object.keys(goals).length, 'goals,', pairs.length, 'pairs,', Object.keys(calibrations).length, 'calibrations')
