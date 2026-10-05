// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Validation (types, ranges, enums) and conflict detection across keys. src/validate.rs mirrors it;
// fixtures/validate-cases.json holds the shared cases.
import type { PrintConfig, SettingDef, SettingIssue, SettingValue } from '@slicerx/contracts/settings'
import { numberOf as numberWith, scalarOf as scalarWith, widthOf as widthWith } from './config'
import { K } from './knowledge'
import { SETTINGS, settingDef } from './schema'
import { isSmartLayerOn, smartLayerLimits, smartLayerWindow } from './smartlayer'
import { heatCreepWarning, layerTimeGuard } from './thinlayers'
import { isVectorType } from './value'

function numbersIn(v: SettingValue): number[] | undefined {
  if (typeof v === 'number') return [v]
  if (Array.isArray(v) && v.every((x) => typeof x === 'number')) return v as number[]
  if (typeof v === 'string') {
    const t = v.endsWith('%') ? v.slice(0, -1) : v
    const n = Number(t)
    return t.trim() !== '' && Number.isFinite(n) ? [n] : undefined
  }
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
    const out: number[] = []
    for (const s of v as string[]) {
      const t = s.endsWith('%') ? s.slice(0, -1) : s
      const n = Number(t)
      if (t.trim() === '' || !Number.isFinite(n)) return undefined
      out.push(n)
    }
    return out
  }
  return undefined
}

function typeMatches(def: SettingDef, v: SettingValue): boolean {
  switch (def.type) {
    case 'float': case 'int': case 'percent': return typeof v === 'number'
    case 'bool': return typeof v === 'boolean'
    case 'floatOrPercent': case 'enum': case 'string': case 'gcode': return typeof v === 'string'
    case 'point': return Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number')
    default: return Array.isArray(v)
  }
}

/** Schema level checks for every key present: type, range, enum membership. */
export function checkValues(config: PrintConfig): SettingIssue[] {
  const issues: SettingIssue[] = []
  for (const key of Object.keys(config)) {
    const def = settingDef(key)
    const v = config[key]
    if (!def || v === undefined) {
      issues.push({ code: 'unknown_key', severity: 'info', keys: [key], message: `${key} is not a known setting.` })
      continue
    }
    if (!typeMatches(def, v)) {
      issues.push({ code: 'wrong_type', severity: 'error', keys: [key], message: `${def.label} has the wrong type for ${def.type}.` })
      continue
    }
    if ((def.type === 'enum' || def.type === 'enums') && def.enumValues && def.enumValues.length > 0) {
      const items = Array.isArray(v) ? (v as unknown[]) : [v]
      const bad = items.find((x) => typeof x === 'string' && !def.enumValues?.includes(x) && !(def.enumAliases && x in def.enumAliases))
      if (bad !== undefined) {
        issues.push({ code: 'bad_enum', severity: 'error', keys: [key], message: `${def.label}: "${String(bad)}" is not one of ${def.enumValues.join(', ')}.` })
        continue
      }
      const missing = items.find((x) => typeof x === 'string' && def.unavailableValues?.includes(x))
      if (missing !== undefined) {
        issues.push({ code: 'enum_value_unavailable', severity: 'warning', keys: [key], message: `${def.label}: "${String(missing)}" is not supported by the SlicerX engine yet, so it prints with the default.` })
      }
    }
    if ((def.min !== undefined || def.max !== undefined || def.orcaMin !== undefined || def.orcaMax !== undefined) && !isVectorType(def.type) === !Array.isArray(v)) {
      if (def.type === 'floatOrPercent' && typeof v === 'string' && v.endsWith('%')) continue
      const nums = numbersIn(v)
      if (nums && def.auto && nums.every((n) => n === 0)) continue
      if (nums) {
        const unit = def.unit ? ' ' + def.unit : ''
        const hardLo = def.orcaMin === undefined ? def.min : (def.orcaMin ?? undefined)
        const hardHi = def.orcaMax === undefined ? def.max : (def.orcaMax ?? undefined)
        const bad = nums.find((n) => (hardLo !== undefined && n < hardLo) || (hardHi !== undefined && n > hardHi))
        if (bad !== undefined) {
          const fixed = hardLo !== undefined && bad < hardLo ? hardLo : (hardHi ?? bad)
          issues.push({
            code: 'out_of_range',
            severity: 'error',
            keys: [key],
            message: `${def.label} is ${bad}, outside ${hardLo ?? '-inf'} to ${hardHi ?? 'inf'}${unit}.`,
            ...(typeof v === 'number' ? { fix: { key, value: fixed } } : {}),
          })
          continue
        }
        const soft = nums.find((n) => (def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max))
        if (soft !== undefined) {
          issues.push({
            code: 'outside_recommended_range',
            severity: 'warning',
            keys: [key],
            message: `${def.label} is ${soft}, outside the usual ${def.min ?? '-inf'} to ${def.max ?? 'inf'}${unit}.`,
          })
        }
      }
    }
  }
  return issues
}

const SPEED_WIDTH: [string, string][] = [
  ['outer_wall_speed', 'outer_wall_line_width'],
  ['inner_wall_speed', 'inner_wall_line_width'],
  ['sparse_infill_speed', 'sparse_infill_line_width'],
  ['internal_solid_infill_speed', 'internal_solid_infill_line_width'],
  ['top_surface_speed', 'top_surface_line_width'],
]

function r2(n: number): number {
  return Math.round(n * 100) / 100
}

// Conflict checks look only at keys the config sets: a partial config is not judged by defaults it never chose.
const numberOf = (c: PrintConfig, k: string) => numberWith(c, k, false)
const scalarOf = (c: PrintConfig, k: string) => scalarWith(c, k, false)
const widthOf = (c: PrintConfig, k: string, n: number) => widthWith(c, k, n, false)

/** Conflicts between keys that Orca would silently override or that print badly. */
export function checkConflicts(config: PrintConfig, opts: { filament?: string } = {}): SettingIssue[] {
  const issues: SettingIssue[] = []
  const nozzle = numberOf(config, 'nozzle_diameter') ?? 0.4
  const lh = numberOf(config, 'layer_height')
  const first = numberOf(config, 'initial_layer_print_height')
  if (lh !== undefined) {
    if (lh > nozzle) {
      issues.push({ code: 'layer_above_nozzle', severity: 'error', keys: ['layer_height', 'nozzle_diameter'], message: `Layer height ${lh} mm is larger than the ${nozzle} mm nozzle.`, fix: { key: 'layer_height', value: r2(nozzle * 0.75) } })
    } else if (lh > nozzle * 0.75 + 1e-9) {
      issues.push({ code: 'layer_over_75pct', severity: 'warning', keys: ['layer_height', 'nozzle_diameter'], message: `Layer height ${lh} mm is above 75 percent of the ${nozzle} mm nozzle; layers bond poorly.` })
    }
    const lo = numberOf(config, 'min_layer_height')
    const hi = numberOf(config, 'max_layer_height')
    if (lo !== undefined && lo > lh) issues.push({ code: 'layer_below_min', severity: 'warning', keys: ['layer_height', 'min_layer_height'], message: `Layer height ${lh} mm is below the printer minimum ${lo} mm.` })
    if (hi !== undefined && hi > 0 && lh > hi) issues.push({ code: 'layer_above_max', severity: 'warning', keys: ['layer_height', 'max_layer_height'], message: `Layer height ${lh} mm is above the printer maximum ${hi} mm.` })
  }
  if (first !== undefined && first > nozzle) {
    issues.push({ code: 'first_layer_above_nozzle', severity: 'error', keys: ['initial_layer_print_height', 'nozzle_diameter'], message: `First layer height ${first} mm is larger than the ${nozzle} mm nozzle.`, fix: { key: 'initial_layer_print_height', value: r2(nozzle * 0.75) } })
  }
  for (const wk of ['line_width', 'outer_wall_line_width', 'inner_wall_line_width', 'sparse_infill_line_width', 'top_surface_line_width']) {
    if (!(wk in config)) continue
    const w = widthOf(config, wk, nozzle)
    if (w < nozzle * 0.5 - 1e-9 || w > nozzle * 2 + 1e-9) {
      issues.push({ code: 'line_width_range', severity: 'warning', keys: [wk, 'nozzle_diameter'], message: `${wk} of ${r2(w)} mm is far from the ${nozzle} mm nozzle (0.5x to 2x is usable).` })
    }
  }
  if (scalarOf(config, 'spiral_mode') === true) {
    if (scalarOf(config, 'enable_support') === true) issues.push({ code: 'spiral_with_support', severity: 'warning', keys: ['spiral_mode', 'enable_support'], message: 'Spiral vase mode prints one continuous wall and cannot use supports.', fix: { key: 'enable_support', value: false } })
    const walls = numberOf(config, 'wall_loops')
    if (walls !== undefined && walls > 1) issues.push({ code: 'spiral_walls', severity: 'info', keys: ['spiral_mode', 'wall_loops'], message: 'Spiral vase mode prints a single wall; extra wall loops are ignored.' })
    if (scalarOf(config, 'sparse_infill_density') !== undefined && (numberOf(config, 'sparse_infill_density') ?? 0) > 0) issues.push({ code: 'spiral_infill', severity: 'info', keys: ['spiral_mode', 'sparse_infill_density'], message: 'Spiral vase mode has no infill; the infill density is ignored.' })
  }
  const maxFlow = numberOf(config, 'filament_max_volumetric_speed')
  if (maxFlow !== undefined && maxFlow > 0 && lh !== undefined) {
    for (const [sk, wk] of SPEED_WIDTH) {
      const s = numberOf(config, sk)
      if (s === undefined) continue
      const flow = s * widthOf(config, wk, nozzle) * lh
      if (flow > maxFlow * 1.05) {
        issues.push({ code: 'flow_limit', severity: 'warning', keys: [sk, 'filament_max_volumetric_speed'], message: `${sk} of ${s} mm/s needs ${r2(flow)} mm3/s, above the filament limit of ${maxFlow} mm3/s; the printer will slow down or under-extrude.`, fix: { key: sk, value: Math.floor(maxFlow / (widthOf(config, wk, nozzle) * lh)) } })
      }
    }
  }
  const t = numberOf(config, 'nozzle_temperature')
  const tLo = numberOf(config, 'nozzle_temperature_range_low')
  const tHi = numberOf(config, 'nozzle_temperature_range_high')
  if (t !== undefined && tLo !== undefined && tHi !== undefined && tHi > 0 && (t < tLo || t > tHi)) {
    issues.push({ code: 'temp_outside_range', severity: 'warning', keys: ['nozzle_temperature', 'nozzle_temperature_range_low', 'nozzle_temperature_range_high'], message: `Nozzle temperature ${t} C is outside the filament range ${tLo} to ${tHi} C.` })
  }
  const acc = numberOf(config, 'default_acceleration')
  const accMax = numberOf(config, 'machine_max_acceleration_extruding')
  if (acc !== undefined && accMax !== undefined && accMax > 0 && acc > accMax) {
    issues.push({ code: 'accel_over_machine', severity: 'warning', keys: ['default_acceleration', 'machine_max_acceleration_extruding'], message: `Acceleration ${acc} mm/s2 is above the machine limit ${accMax} mm/s2.`, fix: { key: 'default_acceleration', value: accMax } })
  }
  if (scalarOf(config, 'enable_arc_fitting') === true && (numberOf(config, 'max_volumetric_extrusion_rate_slope') ?? 0) > 0) {
    issues.push({ code: 'arc_fitting_with_slope', severity: 'warning', keys: ['enable_arc_fitting', 'max_volumetric_extrusion_rate_slope'], message: 'Arc fitting is turned off while extrusion rate smoothing is on.', fix: { key: 'enable_arc_fitting', value: false } })
  }
  if (scalarOf(config, 'use_firmware_retraction') === true && (numberOf(config, 'retraction_length') ?? 0) > 0) {
    issues.push({ code: 'firmware_retraction', severity: 'info', keys: ['use_firmware_retraction', 'retraction_length'], message: 'Firmware retraction is on; the slicer retraction length is not used.' })
  }
  const smart = scalarOf(config, 'smart_layer')
  if (smart !== undefined && smart !== 'off') {
    const sMin = numberOf(config, 'smart_layer_min_height')
    const sMax = numberOf(config, 'smart_layer_max_height')
    const material = opts.filament ? K.materials[opts.filament] : undefined
    const mode = isSmartLayerOn(smart) ? smart : undefined
    const limits = smartLayerLimits(material, mode)
    const window = smartLayerWindow(nozzle, material, mode)
    const research = limits.note ? ` (${limits.note})` : ''
    if (sMin !== undefined && sMax !== undefined && sMin >= sMax) {
      issues.push({ code: 'smart_layer_bounds_order', severity: 'error', keys: ['smart_layer_min_height', 'smart_layer_max_height'], message: `sleipnir thinnest layer ${sMin} mm is not below the thickest ${sMax} mm.` })
    }
    if (sMin !== undefined && sMin < limits.minRatio * nozzle - 1e-9) {
      issues.push({ code: 'smart_layer_min_low', severity: 'warning', keys: ['smart_layer_min_height', 'nozzle_diameter'], message: `sleipnir thinnest layer ${sMin} mm is below ${Math.round(limits.minRatio * 100)} percent of the ${nozzle} mm nozzle${research}; layers that thin print poorly.`, fix: { key: 'smart_layer_min_height', value: window.min } })
    }
    if (sMax !== undefined && sMax > limits.maxRatio * nozzle + 1e-9) {
      issues.push({ code: 'smart_layer_max_high', severity: 'warning', keys: ['smart_layer_max_height', 'nozzle_diameter'], message: `sleipnir thickest layer ${sMax} mm is above ${Math.round(limits.maxRatio * 100)} percent of the ${nozzle} mm nozzle${research}; layers that thick bond poorly.`, fix: { key: 'smart_layer_max_height', value: window.max } })
    }
    if (scalarOf(config, 'spiral_mode') === true) {
      issues.push({ code: 'smart_layer_spiral', severity: 'warning', keys: ['smart_layer', 'spiral_mode'], message: 'Vase mode prints at one layer height, so sleipnir has no effect.', fix: { key: 'smart_layer', value: 'off' } })
    }
    if (lh !== undefined && sMin !== undefined && sMax !== undefined && (lh < sMin - 1e-9 || lh > sMax + 1e-9)) {
      issues.push({ code: 'smart_layer_outside_layer_height', severity: 'info', keys: ['layer_height', 'smart_layer_min_height', 'smart_layer_max_height'], message: `Layer height ${lh} mm is outside the sleipnir range ${sMin} to ${sMax} mm.` })
    }
  }
  // Thin layers and the cooling slowdown.
  const material = opts.filament ? K.materials[opts.filament] : undefined
  const guard = isSmartLayerOn(smart) ? layerTimeGuard(material) : undefined
  const layerTime = numberOf(config, 'slow_down_layer_time')
  if (guard && material && layerTime !== undefined && layerTime < guard.minLayerTime - 1e-9) {
    issues.push({ code: 'smart_layer_min_layer_time', severity: 'warning', keys: ['slow_down_layer_time', 'smart_layer'], message: `sleipnir prints thin layers, and ${material.name.split(' (')[0]} needs at least ${guard.minLayerTime} s per layer to cool them; the minimum layer time is ${layerTime} s.`, fix: { key: 'slow_down_layer_time', value: guard.minLayerTime } })
  }
  const minSpeed = numberOf(config, 'slow_down_min_speed')
  if (scalarOf(config, 'slow_down_for_layer_cooling') !== false && minSpeed !== undefined && maxFlow !== undefined) {
    const sMinH = isSmartLayerOn(smart) ? numberOf(config, 'smart_layer_min_height') : undefined
    const heights = [lh, sMinH].filter((h): h is number => h !== undefined)
    const thinnest = heights.length > 0 ? Math.min(...heights) : undefined
    const warn = thinnest === undefined ? undefined : heatCreepWarning({ minSpeed, width: widthOf(config, 'outer_wall_line_width', nozzle), thinnest, maxFlow })
    if (warn) issues.push({ code: 'heat_creep_thin_layers', severity: 'warning', keys: ['slow_down_min_speed', 'layer_height', 'filament_max_volumetric_speed'], message: warn })
  }
  const top = numberOf(config, 'top_shell_layers')
  const bottom = numberOf(config, 'bottom_shell_layers')
  const walls = numberOf(config, 'wall_loops')
  const density = numberOf(config, 'sparse_infill_density')
  if (walls === 0 && density === 0 && top === 0 && bottom === 0) {
    issues.push({ code: 'nothing_to_print', severity: 'error', keys: ['wall_loops', 'sparse_infill_density', 'top_shell_layers', 'bottom_shell_layers'], message: 'No walls, infill or shells: nothing would print.' })
  }
  return issues
}

/** Value checks plus conflicts, errors first. */
export function validate(config: PrintConfig, opts: { filament?: string } = {}): SettingIssue[] {
  const rank = { error: 0, warning: 1, info: 2 } as const
  return [...checkValues(config), ...checkConflicts(config, opts)].sort((a, b) => rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code) || (a.keys[0] ?? '').localeCompare(b.keys[0] ?? ''))
}

/** Every schema key missing from `config`, for a completeness report. */
export function missingKeys(config: PrintConfig): string[] {
  return SETTINGS.filter((d) => !(d.key in config)).map((d) => d.key)
}
