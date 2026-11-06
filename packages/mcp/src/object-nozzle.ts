// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which nozzle prints each object on a printer whose nozzles are not all one size, for the server's own project: the
// object's nozzle is its filament's (filament n on tool n on a tool changer; the filament map on a Bambu Lab printer
// with two extruders), and the same rules as the app's object row decide what a pick may change.
import type { SettingValue } from '@slicerx/contracts'

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v])
const same = (a: number, b: number): boolean => Math.abs(a - b) < 1e-3

/** Each extruder's nozzle size in mm, from `nozzle_diameter`. */
export function nozzleSizes(cfg: Record<string, unknown>): number[] {
  return list(cfg['nozzle_diameter']).map(Number).filter((d) => Number.isFinite(d) && d > 0)
}

/** A Bambu Lab printer with two extruders whose filaments share them by a map. */
function mapped(cfg: Record<string, unknown>): boolean {
  const model = String(list(cfg['printer_model'])[0] ?? '')
  const semm = list(cfg['single_extruder_multi_material'])[0]
  const shared = semm === undefined || semm === true || semm === 1 || semm === '1' || semm === 'true'
  return nozzleSizes(cfg).length === 2 && model.startsWith('Bambu Lab') && shared
}

/** `map` (two extruders and a filament map) or `tools` (a tool per filament) when the nozzles differ in size, else null. */
export function nozzleKind(cfg: Record<string, unknown>): 'map' | 'tools' | null {
  const s = nozzleSizes(cfg)
  if (s.length < 2 || s.every((d) => same(d, s[0]!))) return null
  return mapped(cfg) ? 'map' : 'tools'
}

/** The extruder a filament the map leaves out prints with (1-based). */
function master(cfg: Record<string, unknown>): number {
  const m = Number(list(cfg['master_extruder_id'])[0])
  return m === 1 || m === 2 ? m : 1
}

/** The filament map a slice sends: the one set by hand, else seeded with every filament on the master extruder. */
export function filamentMap(cfg: Record<string, unknown>, slots: number): { mode: 'manual' | 'seeded'; map: number[] } {
  const mode = String(list(cfg['filament_map_mode'])[0] ?? '')
  const own = list(cfg['filament_map']).map(Number)
  const manual = mode === 'Manual' || mode === 'Nozzle Manual'
  return { mode: manual ? 'manual' : 'seeded', map: Array.from({ length: Math.max(1, slots) }, (_, i) => (manual && (own[i] === 1 || own[i] === 2) ? own[i]! : master(cfg))) }
}

/** The extruder (1-based) that prints filament `slot`. */
export function extruderOf(cfg: Record<string, unknown>, map: readonly number[], slot: number): number {
  if (mapped(cfg)) return map[slot - 1] ?? master(cfg)
  return Math.min(Math.max(1, slot), Math.max(1, nozzleSizes(cfg).length))
}

/**
 * The filaments (1-based) a part's color paint uses, from its paint texts by triangle: the painted states only, not the
 * part's own filament. The texts are the 3MF's per-triangle hex trees, read from the last digit; a malformed text gives
 * what was read before it broke.
 */
export function paintedFilaments(color: Readonly<Record<number, string>> | undefined): number[] {
  const out = new Set<number>()
  for (const raw of Object.values(color ?? {})) {
    const s = raw.trim()
    let at = s.length - 1
    const next = (): number | undefined => {
      if (at < 0) return undefined
      const d = Number.parseInt(s[at--] as string, 16)
      return Number.isNaN(d) ? undefined : d
    }
    const node = (depth: number): boolean => {
      const code = next()
      if (code === undefined) return false
      const splits = code & 3
      const special = code >> 2
      if (splits === 0) {
        if (special === 3) {
          const ext = next()
          if (ext === undefined) return false
          out.add(ext + 3)
        } else if (special > 0) out.add(special)
        return true
      }
      if (depth >= 12 || special > 2) return false
      for (let i = 0; i <= splits; i++) if (!node(depth + 1)) return false
      return true
    }
    node(0)
  }
  return [...out].sort((a, b) => a - b)
}

/** "Left nozzle", "Right nozzle" or "Tool 2". */
export function nozzleName(cfg: Record<string, unknown>, extruder: number): string {
  if (mapped(cfg)) return extruder === 1 ? 'Left nozzle' : 'Right nozzle'
  return `Tool ${extruder}`
}

/**
 * The engine settings a slice adds so each object prints with its own nozzle: a two-extruder printer whose nozzles
 * differ in size sends its map by hand (the seeded one when none is set). None otherwise.
 */
export function seededMapConfig(cfg: Record<string, unknown>, slots: number): Record<string, SettingValue> {
  if (nozzleKind(cfg) !== 'map') return {}
  const m = filamentMap(cfg, slots)
  return m.mode === 'manual' ? {} : { filament_map_mode: 'Manual', filament_map: m.map }
}
