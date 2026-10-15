// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { SettingValue } from '@slicerx/contracts'

export interface PrintSize { w: number; h: number; height: number }

/** First element of a per-filament list, else the value; a number or a numeric string. */
export function marginNumber(v: SettingValue | undefined, fallback: number): number {
  const x = Array.isArray(v) ? v[0] : v
  const n = typeof x === 'string' ? Number.parseFloat(x) : x
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

export function marginText(v: SettingValue | undefined): string {
  const x = Array.isArray(v) ? v[0] : v
  return typeof x === 'string' ? x : ''
}

export function marginFlag(v: SettingValue | undefined): boolean {
  const x = Array.isArray(v) ? v[0] : v
  return x === true || x === 1 || x === '1' || x === 'true'
}

/** Material coefficients used by the engine's automatic brim. */
function material(cfg: Record<string, SettingValue>): { adhesion: number; thermal: number } {
  const name = marginText(cfg['filament_type'])
  const nylon = name === 'PA' || name.startsWith('PA-') || /^PA\d/.test(name)
  const adhesion = name === 'FLEX' || name === 'TPU' ? 0.5 : ['PCTG', 'PET', 'PET-CF', 'PET-GF', 'PETG'].includes(name) ? 2 : 1
  const thermal = name === 'FLEX' || name === 'TPU' ? 1000 : name === 'PC' || name === 'PC-PBT' ? 40 : name === 'PC-ABS' || name === 'PC-CF' ? 80 : name.startsWith('ABS') || name.startsWith('ASA') || nylon || name.startsWith('PET') ? 100 : 200
  return { adhesion, thermal }
}

/**
 * The width of the engine's automatic brim for a footprint as wide and deep as the object's bounds (the
 * engine's `brim::width`, from the second moment of area, the height, the top speed and the material).
 * A real footprint can have less area than its bounds, which only makes the brim wider, so the figure is
 * raised by a quarter. Zero when the engine would print no brim.
 */
export function autoBrimWidth(cfg: Record<string, SettingValue>, size: PrintSize): number {
  const { w, h, height } = size
  if (!(w > 0 && h > 0 && height > 0)) return 0
  const diagonal = Math.hypot(w, h)
  const ixx = (w * h ** 3) / 12
  const iyy = (h * w ** 3) / 12
  const speed = Math.max(0, ...['inner_wall_speed', 'outer_wall_speed', 'sparse_infill_speed', 'internal_solid_infill_speed', 'top_surface_speed', 'support_speed'].map((k) => marginNumber(cfg[k], 0)))
  const { adhesion, thermal } = material(cfg)
  const heightToArea = (Math.max((height / ixx) * h, (height / iyy) * w) * height) / 1920
  const raw = adhesion * Math.min(18, 1.5 * diagonal, Math.max(heightToArea * speed, (diagonal * 8 * Math.min(height, 30)) / thermal / 30))
  if (raw < 5 && raw < 1.5 * diagonal) return 0
  return Math.min(18, Math.min(raw, 18) * 1.25)
}

/** How far the first layer of the object itself reaches past its outline (brim, raft, size compensation), mm. */
function growOf(cfg: Record<string, SettingValue>, size: PrintSize): number {
  const kind = marginText(cfg['brim_type']) || 'auto_brim'
  const width = Math.max(0, marginNumber(cfg['brim_width'], 0))
  const gap = Math.max(0, marginNumber(cfg['brim_object_gap'], 0))
  // Painted and ear brims are discs the width of the brim; an inner-only brim stays inside the part.
  const brim = kind === 'no_brim' || kind === 'inner_only' ? 0 : kind === 'auto_brim' ? Math.max(autoBrimWidth(cfg, size), width) : width
  let grow = brim > 0 ? brim + gap : 0
  if (marginNumber(cfg['raft_layers'], 0) > 0) grow += Math.max(0, marginNumber(cfg['raft_expansion'], 1.5), marginNumber(cfg['raft_first_layer_expansion'], 2))
  return grow + Math.max(0, marginNumber(cfg['xy_contour_compensation'], 0))
}

/**
 * How far support reaches past the outline, mm, or 0 with support off. It stays under the object, but its
 * first layer pad widens by `raft_first_layer_expansion` and a tree support has a brim of its own. Objects
 * that need no support print none, so this is a safe upper bound, used only against the bed edge.
 */
function supportOf(cfg: Record<string, SettingValue>): number {
  if (!marginFlag(cfg['enable_support'])) return 0
  const pad = Math.max(0, marginNumber(cfg['raft_first_layer_expansion'], 2), marginNumber(cfg['support_expansion'], 0)) + Math.max(0, marginNumber(cfg['support_object_xy_distance'], 0.35))
  return pad + (marginText(cfg['support_type']).startsWith('tree') ? Math.max(0, marginNumber(cfg['tree_support_brim_width'], 3)) : 0)
}

/** The skirt or draft shield: how far past the part (and its brim) the outermost loop lies, or 0 without one. */
function skirtOf(cfg: Record<string, SettingValue>, grow: number): number {
  const shield = marginText(cfg['draft_shield']) === 'enabled'
  const loops = Math.max(0, Math.floor(marginNumber(cfg['skirt_loops'], 0)))
  if (loops === 0 && !shield) return 0
  const nozzle = marginNumber(cfg['nozzle_diameter'], 0.4)
  const spacing = Math.max(marginNumber(cfg['line_width'], 0), nozzle * 1.2)
  const brim = marginText(cfg['brim_type']) === 'no_brim' ? 0 : Math.max(0, marginNumber(cfg['brim_width'], 0))
  // The engine puts the skirt at the brim width plus the skirt distance from the outline, or from the brim with a draft shield.
  return Math.max(grow, brim) + Math.max(0, marginNumber(cfg['skirt_distance'], 2)) + Math.max(1, loops) * spacing
}

/** The object's first-layer growth and the outermost printed boundary. */
export function objectPrintMargins(cfg: Record<string, SettingValue>) {
  const support = supportOf(cfg)
  return {
    grow: (size: PrintSize) => growOf(cfg, size),
    reach: (size: PrintSize) => {
      const own = Math.max(growOf(cfg, size), support)
      return Math.max(own, skirtOf(cfg, own))
    },
    skirt: skirtOf(cfg, 0) > 0,
  }
}
