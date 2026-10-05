// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The strength proxy and setting checks shared by optimize_to_target and
// compare_setups.
import type { PrintConfig, SettingValue } from '@slicerx/contracts'
import type { KnowledgeBase } from '../../src/kb/kb'

/**
 * Relative strength of infill patterns per gram, for the proxy only. Gyroid,
 * honeycomb and the TPMS patterns are strong in every direction; grid and
 * rectilinear are weaker across their lines; lightning only holds up top
 * skins and carries almost no load.
 */
export const PATTERN_STRENGTH: Record<string, number> = {
  gyroid: 1,
  honeycomb: 1,
  tpmsd: 1,
  tpmsfk: 1,
  '3dhoneycomb': 0.95,
  cubic: 0.95,
  quartercubic: 0.95,
  triangles: 0.95,
  'tri-hexagon': 0.95,
  crosshatch: 0.95,
  adaptivecubic: 0.9,
  grid: 0.9,
  'lateral-honeycomb': 0.9,
  'lateral-lattice': 0.9,
  rectilinear: 0.8,
  alignedrectilinear: 0.8,
  zigzag: 0.8,
  crosszag: 0.8,
  lockedzag: 0.8,
  line: 0.75,
  concentric: 0.7,
  hilbertcurve: 0.7,
  archimedeanchords: 0.7,
  octagramspiral: 0.7,
  supportcubic: 0.6,
  lightning: 0.15,
}

export interface ProxyInput {
  wallLoops: number
  lineWidth: number
  density: number
  pattern: string
  layerHeight: number
  nozzle: number
  topLayers: number
  bottomLayers: number
}

const num = (v: SettingValue | undefined, fallback: number): number => {
  const x = Array.isArray(v) ? v[0] : v
  const n = typeof x === 'number' ? x : typeof x === 'string' ? Number.parseFloat(x) : NaN
  return Number.isFinite(n) ? n : fallback
}

export function proxyInput(cfg: Record<string, SettingValue>): ProxyInput {
  const nozzle = num(cfg['nozzle_diameter'], 0.4)
  return {
    wallLoops: num(cfg['wall_loops'], 2),
    lineWidth: num(cfg['inner_wall_line_width'], num(cfg['line_width'], nozzle * 1.05)),
    density: num(cfg['sparse_infill_density'], 15),
    pattern: String(cfg['sparse_infill_pattern'] ?? 'grid'),
    layerHeight: num(cfg['layer_height'], 0.2),
    nozzle,
    topLayers: num(cfg['top_shell_layers'], 4),
    bottomLayers: num(cfg['bottom_shell_layers'], 3),
  }
}

/**
 * Strength proxy for one box shaped part, in mm3 of load carrying plastic.
 * It is a ranking aid, not a load rating:
 *
 *   walls  = shell area x wall thickness, where thickness is wall loops x line
 *            width, capped at half the smallest side (a thin part cannot hold
 *            more walls than it has room for). Walls carry most of the load
 *            (CNC Kitchen's hook tests in knowledge/intents/strength.yaml).
 *   infill = 0.35 x inner volume x density x pattern weight. Infill backs up
 *            the walls but gives less strength per gram past about 25 percent.
 *   skins  = 0.5 x footprint x top and bottom shell thickness.
 *
 * The sum is scaled by a layer bond factor: 1 up to half the nozzle
 * diameter, falling to 0.85 at 75 percent, since tall layers bond over less
 * contact width.
 */
export function strengthProxy(box: [number, number, number], p: ProxyInput): number {
  const [x, y, z] = box.map((v) => Math.max(0, v)) as [number, number, number]
  const shellArea = 2 * (x * y + y * z + x * z)
  const t = Math.min(p.wallLoops * p.lineWidth, Math.min(x, y) / 2)
  const skin = (p.topLayers + p.bottomLayers) * p.layerHeight
  const inner = Math.max(0, x - 2 * t) * Math.max(0, y - 2 * t) * Math.max(0, z - skin)
  const walls = shellArea * t
  const infill = 0.35 * inner * (Math.min(100, Math.max(0, p.density)) / 100) * (PATTERN_STRENGTH[p.pattern] ?? 0.8)
  const skins = 0.5 * x * y * Math.min(skin, z)
  const ratio = p.layerHeight / Math.max(0.05, p.nozzle)
  const bond = ratio <= 0.5 ? 1 : Math.max(0.85, 1 - ((ratio - 0.5) / 0.25) * 0.15)
  return (walls + infill + skins) * bond
}

/** Sum of the proxy over boxes (one per object copy on the plate). */
export function plateStrength(boxes: [number, number, number][], cfg: Record<string, SettingValue>): number {
  const p = proxyInput(cfg)
  return boxes.reduce((s, b) => s + strengthProxy(b, p), 0)
}

export type ChangeValue = number | string | boolean

export interface CheckedChanges {
  accepted: Record<string, ChangeValue>
  rejected: string[]
  /** Keys mimir does not know; passed through with a note. */
  unknown: string[]
  /** Guarded keys (temperatures, flow, retraction), which always show in the settings diff. */
  guarded: string[]
}

/**
 * Validates changes against knowledge/settings.yaml the way settings.apply
 * does: read only keys and values outside the bounds are rejected, enum
 * values must be ones Orca knows. Percent strings become numbers.
 */
export function checkChanges(kb: KnowledgeBase, changes: Record<string, ChangeValue>): CheckedChanges {
  const out: CheckedChanges = { accepted: {}, rejected: [], unknown: [], guarded: [] }
  for (const [k, raw] of Object.entries(changes)) {
    const v = typeof raw === 'string' && /^-?\d+(\.\d+)?%?$/.test(raw.trim()) ? Number.parseFloat(raw) : raw
    const def = kb.setting(k)
    if (!def) {
      out.unknown.push(k)
      out.accepted[k] = v
      continue
    }
    if (def.pilot === 'read') {
      out.rejected.push(`${k} is read only for mimir`)
      continue
    }
    if (def.bounds && typeof v === 'number') {
      const { min, max } = def.bounds
      if ((min !== undefined && v < min) || (max !== undefined && v > max)) {
        out.rejected.push(`${k}=${v} is outside ${min ?? '-inf'} to ${max ?? 'inf'}`)
        continue
      }
    }
    if (def.values?.length && typeof v === 'string' && !def.values.includes(v)) {
      out.rejected.push(`${k}="${v}" is not an Orca value (${def.values.slice(0, 6).join(', ')}${def.values.length > 6 ? ', ...' : ''})`)
      continue
    }
    if (def.pilot === 'guarded') out.guarded.push(k)
    out.accepted[k] = v
  }
  return out
}

/** Plain risk notes for a resolved config, used when comparing setups. */
export function configRisks(cfg: PrintConfig | Record<string, SettingValue>, nozzle: number): string[] {
  const p = proxyInput(cfg)
  const out: string[] = []
  const ratio = p.layerHeight / nozzle
  if (ratio > 0.75) out.push(`layer height ${p.layerHeight} mm is over 75 percent of the ${nozzle} mm nozzle; layers bond poorly`)
  if (ratio < 0.25) out.push(`layer height ${p.layerHeight} mm is under 25 percent of the ${nozzle} mm nozzle; slow and prone to under extrusion`)
  if (p.wallLoops < 2) out.push('a single wall leaks and breaks easily')
  if (p.pattern === 'lightning') out.push('lightning infill only holds up the top skin; the part has little strength')
  if (p.density < 10 && p.pattern !== 'lightning' && p.topLayers < 5) out.push(`${p.density} percent infill with ${p.topLayers} top layers can pillow on the top surface`)
  return out
}
