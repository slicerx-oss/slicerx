// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Mixed filaments: a filament number that prints as one of two loaded filaments per layer, in a repeating pattern
// from a ratio, so the colors blend to the eye. A plate keeps its mixes; the engine reads them from the plate's
// `mixed_filaments` setting, one entry per mix as `id:a,b:ra,rb:name` (packages/core/src/mixed.rs). The app and the
// MCP server share this module, so a mix reads, saves and estimates the same in both.
import { PAINT_FILAMENT_MAX } from '@slicerx/contracts/color-slots'
import type { SettingValue } from '@slicerx/contracts/settings'

/** The plate setting that lists the mixes. */
export const MIX_KEY = 'mixed_filaments'

/**
 * The highest filament number a mix takes. Paint keeps filament numbers up to 32, so mixes count down from there and
 * the loaded filaments count up from 1 to the lowest of them (the engine's `TOP_ID`, packages/core/src/mixed.rs).
 */
export const MIX_TOP_ID = PAINT_FILAMENT_MAX

/** The most layers of one filament a cycle prints. */
export const MAX_MIX_RATIO = 20

/** The most mixes a project holds. */
export const MAX_MIXES = 4

/** The lowest filament number a mix takes, so mixes keep to the top four numbers. */
export const MIX_LOWEST_ID = MIX_TOP_ID - MAX_MIXES + 1

export interface MixedFilament {
  /** The filament number parts and paint use for the mix. */
  id: number
  name: string
  /** The two loaded filaments it alternates, 1-based. */
  components: [number, number]
  /** Layers of each per cycle. */
  ratio: [number, number]
}

const whole = (v: number, lo: number, hi: number): boolean => Number.isInteger(v) && v >= lo && v <= hi

/** One entry of `mixed_filaments`. */
export function encodeMix(m: MixedFilament): string {
  return `${m.id}:${m.components[0]},${m.components[1]}:${m.ratio[0]},${m.ratio[1]}:${m.name}`
}

/** An entry of `mixed_filaments`, or null when it does not parse. */
export function decodeMix(e: string): MixedFilament | null {
  // The name comes last and may hold colons of its own.
  const [id = '', comps = '', ratio = '', ...rest] = e.trim().split(':')
  const name = rest.join(':')
  const pair = (s: string): [number, number] | null => {
    const v = s.split(',').map((x) => (x.trim() ? Number(x.trim()) : NaN))
    return v.length === 2 ? [v[0]!, v[1]!] : null
  }
  const c = pair(comps)
  const r = pair(ratio)
  const n = Number(id.trim())
  if (!c || !r || !whole(n, 1, 64) || !c.every((x) => whole(x, 1, 64)) || !r.every((x) => whole(x, 1, MAX_MIX_RATIO))) return null
  return { id: n, name: name.trim() || `Mix ${n}`, components: c, ratio: r }
}

/** The mixes a `mixed_filaments` value lists; entries that do not parse are left out. */
export function decodeMixes(v: SettingValue | undefined | null): MixedFilament[] {
  const list = Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? [v] : []
  return list.map(decodeMix).filter((m): m is MixedFilament => m !== null)
}

/** The `mixed_filaments` value for `mixes`. */
export function encodeMixes(mixes: readonly MixedFilament[]): string[] {
  return mixes.map(encodeMix)
}

/** The config a plate with `mixes` slices with: the setting, or nothing without a mix, so such a plate slices as before. */
export function mixConfig(mixes: readonly MixedFilament[] | undefined): Record<string, string[]> {
  return mixes?.length ? { [MIX_KEY]: encodeMixes(mixes) } : {}
}

/**
 * Which of the two filaments layer `layer` prints (0 for the first): the second's layers are spread through the cycle
 * as evenly as the ratio allows, 2:1 as A, A, B and 3:2 as A, A, B, A, B. The engine uses the same rule.
 */
export function mixLayerComponent(m: Pick<MixedFilament, 'ratio'>, layer: number): 0 | 1 {
  const [a, b] = m.ratio
  const n = a + b
  const i = ((layer % n) + n) % n
  return Math.floor(((i + 1) * b) / n) > Math.floor((i * b) / n) ? 1 : 0
}

/** The filament (1-based) layer `layer` prints. */
export function mixLayerFilament(m: MixedFilament, layer: number): number {
  return m.components[mixLayerComponent(m, layer)]
}

/** How many times one cycle switches filament, counting the switch into the next cycle. */
export function mixSwitchesPerCycle(m: Pick<MixedFilament, 'ratio'>): number {
  const n = m.ratio[0] + m.ratio[1]
  let switches = 0
  for (let i = 0; i < n; i++) if (mixLayerComponent(m, i) !== mixLayerComponent(m, i + 1)) switches++
  return switches
}

/** Tool changes a mix adds over `layers` layers of its own: one per switch of filament. */
export function mixToolChanges(m: Pick<MixedFilament, 'ratio'>, layers: number): number {
  if (layers < 2) return 0
  let switches = 0
  for (let i = 1; i < layers; i++) if (mixLayerComponent(m, i) !== mixLayerComponent(m, i - 1)) switches++
  return switches
}

const toLinear = (c: number): number => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const toSrgb = (v: number): number => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
  return Math.round(Math.min(1, Math.max(0, c)) * 255)
}

/**
 * The color a mix should read as from a distance, approximate: the two colors averaged in linear RGB, each weighted by
 * its share of the layers. Real prints differ with layer height, translucency and finish.
 */
export function mixColor(colors: readonly [string, string], ratio: readonly [number, number]): string {
  const rgb = (h: string): [number, number, number] => {
    const m = /^#?([0-9a-f]{6})/i.exec(h.trim())
    const n = m ? parseInt(m[1]!, 16) : 0x808080
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const [a, b] = [rgb(colors[0]), rgb(colors[1])]
  const w = ratio[1] / (ratio[0] + ratio[1])
  const out = a.map((c, i) => toSrgb(toLinear(c) * (1 - w) + toLinear(b[i]!) * w))
  return `#${out.map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Whether filament number `slot` may be one left on a deleted mix: with mixes, one of the numbers mixes take that no
 * mix names. Past the loaded filaments the engine prints a part on it in filament 1 and paint in it in the part's own
 * filament (packages/core/src/mixed.rs, `left_on_mix`).
 */
export function leftOnMix(mixes: readonly Pick<MixedFilament, 'id'>[], slot: number): boolean {
  return mixes.length > 0 && slot >= MIX_LOWEST_ID && !mixes.some((m) => m.id === slot)
}

/** The filament number the next mix takes: the highest free one above the loaded filaments, or null when none is free. */
export function nextMixId(mixes: readonly Pick<MixedFilament, 'id'>[], loaded: number): number | null {
  if (mixes.length >= MAX_MIXES) return null
  for (let id = MIX_TOP_ID; id > loaded; id--) if (!mixes.some((m) => m.id === id)) return id
  return null
}

/** What is wrong with mix `m` among `mixes` with `loaded` filaments, in plain words, or null when it is fine. */
export function mixProblem(m: MixedFilament, mixes: readonly MixedFilament[], loaded: number): string | null {
  if (!whole(m.id, MIX_LOWEST_ID, MIX_TOP_ID) || m.id <= loaded) return `A mix needs a number from ${Math.max(MIX_LOWEST_ID, loaded + 1)} to ${MIX_TOP_ID}, past the ${loaded} loaded filaments.`
  if (mixes.some((o) => o !== m && o.id === m.id)) return `Another mix already uses number ${m.id}.`
  if (!m.components.every((c) => whole(c, 1, loaded))) return `Pick two of the ${loaded} loaded filaments.`
  if (m.components[0] === m.components[1]) return 'Pick two different filaments.'
  if (!m.ratio.every((r) => whole(r, 1, MAX_MIX_RATIO))) return `Each side of the ratio is a whole number from 1 to ${MAX_MIX_RATIO}.`
  if (!m.name.trim()) return 'Give the mix a name.'
  if (m.name.length > 40) return 'Keep the name to 40 characters.'
  return null
}

/**
 * Tool changes at or above this count are many enough to warn about: about one every three layers of a 10 mm part at
 * 0.2 mm layers.
 */
export const MANY_MIX_CHANGES = 16

/**
 * What a mix costs over `layers` layers: the tool changes it adds and the flush they purge, grams. `flushMm3` is the
 * flush matrix's volume from the first filament to the second and back (mm3, before the multiplier), `multiplier` the
 * flush multiplier and `density` each filament's g/cm3.
 */
export function mixCost(
  m: MixedFilament,
  layers: number,
  flushMm3: readonly [number, number],
  multiplier: number,
  density: readonly [number, number] = [1.24, 1.24],
): { changes: number; grams: number; many: boolean } {
  let changes = 0
  let mm3g = 0
  for (let i = 1; i < layers; i++) {
    const from = mixLayerComponent(m, i - 1)
    const to = mixLayerComponent(m, i)
    if (from === to) continue
    changes++
    // A change to the second filament purges A to B into B; back to the first, B to A into A.
    mm3g += (to === 1 ? flushMm3[0] * density[1] : flushMm3[1] * density[0]) * multiplier
  }
  return { changes, grams: Math.round(mm3g / 100) / 10, many: changes >= MANY_MIX_CHANGES }
}
