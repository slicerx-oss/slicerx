// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which filament slot each color of a model prints with: the colors a file gives its bodies (a STEP or IGES solid's
// color, a texture's colors) against the colors of the slots a project already has. A color close enough to a slot
// prints with it; one that is not gets a slot of its own while the slot limit allows, else the nearest slot. Colors
// close to each other share a new slot. Plain data in and out, no app state, so the app, the MCP server and any other
// importer plan the same way.

/** A slot the project has now. */
export interface ColorSlot {
  /** 1-based, as the plate and the engine number filaments. */
  index: number
  /** #rrggbb */
  color: string
  /** Nothing prints with it and nobody set it up, so a new color may take it over. Default false. */
  free?: boolean
}

export interface ColorSlotOptions {
  /** The most slots the project may end up with: the printer's slot count, else the project's limit (COLOR_SLOT_MAX). */
  limit: number
  /** CIEDE2000 distance at or under which two colors count as the same filament. Default COLOR_MATCH_DELTA_E. */
  threshold?: number
}

/**
 * Where one color goes. `match`: a slot the project has, within the threshold. `new`: a slot this plan fills with a
 * color (listed in `add`). `nearest`: no slot is close and the limit leaves no room, so the closest one.
 */
export interface ColorSlotPick {
  slot: number
  match: 'match' | 'new' | 'nearest'
  /** CIEDE2000 distance from the color to the slot's color. */
  deltaE: number
}

export interface ColorSlotPlan {
  /** One entry per input color, in order; null where the input had no color. */
  picks: (ColorSlotPick | null)[]
  /** The slots the plan fills, each with the color it takes: a free slot taken over, or one after the last. */
  add: { slot: number; color: string }[]
}

/**
 * The distance at or under which a model color and a slot color count as the same filament. About 2 is the least
 * difference people see side by side. CAD colors are often pure ones that no spool has: #ff0000 is 11.9 from a red
 * filament's #c12e1f and pure black 13 from a near-black #282a36, while red and orange (#ff0000, #ff8000) are 21.2 apart
 * and silver and gray (#c0c0c0, #808080) 19.7. 12 matches the red pair and keeps red from orange and silver from gray;
 * the black pair just misses.
 */
export const COLOR_MATCH_DELTA_E = 12

/** The most slots a project holds. */
export const COLOR_SLOT_MAX = 32

/** The highest filament paint names: every filament a project holds. */
export const PAINT_FILAMENT_MAX = 32

/** A CIELAB color: L, a, b. */
export type Lab = readonly [number, number, number]

/** #rrggbb (or rrggbb, any case, with or without alpha) as lower case #rrggbb; null when it is not a color. */
export function normalizeHex(c: string | null | undefined): string | null {
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec((c ?? '').trim())
  return m ? `#${m[1]!.toLowerCase()}` : null
}

function lab(hex: string): Lab {
  const n = parseInt(hex.slice(1), 16)
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const r = lin((n >> 16) & 255)
  const g = lin((n >> 8) & 255)
  const b = lin(n & 255)
  // sRGB to XYZ (D65), then CIELAB
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047)
  const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b)
  const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

const rad = Math.PI / 180

/** CIEDE2000 (Sharma, Wu and Dalal, 2005) between two CIELAB colors. */
export function deltaE2000Lab(p: Lab, q: Lab): number {
  const [l1, a1, b1] = p
  const [l2, a2, b2] = q
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)))
  const a1p = (1 + g) * a1
  const a2p = (1 + g) * a2
  const c1 = Math.hypot(a1p, b1)
  const c2 = Math.hypot(a2p, b2)
  const hue = (b: number, a: number) => (b === 0 && a === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360)
  const h1 = hue(b1, a1p)
  const h2 = hue(b2, a2p)
  const dL = l2 - l1
  const dC = c2 - c1
  let dh = 0
  if (c1 * c2 !== 0) {
    dh = h2 - h1
    if (dh > 180) dh -= 360
    else if (dh < -180) dh += 360
  }
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin((dh / 2) * rad)
  const lBar = (l1 + l2) / 2
  const cBarP = (c1 + c2) / 2
  let hBar = h1 + h2
  if (c1 * c2 !== 0) {
    if (Math.abs(h1 - h2) <= 180) hBar = (h1 + h2) / 2
    else hBar = h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2
  }
  const t = 1 - 0.17 * Math.cos((hBar - 30) * rad) + 0.24 * Math.cos(2 * hBar * rad) + 0.32 * Math.cos((3 * hBar + 6) * rad) - 0.2 * Math.cos((4 * hBar - 63) * rad)
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2)
  const sc = 1 + 0.045 * cBarP
  const sh = 1 + 0.015 * cBarP * t
  const rt = -2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hBar - 275) / 25) ** 2)) * rad)
  return Math.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + (dH / sh) ** 2 + rt * (dC / sc) * (dH / sh))
}

/** CIEDE2000 between two #rrggbb colors; Infinity when either is not a color. */
export function colorDeltaE(a: string, b: string): number {
  const x = normalizeHex(a)
  const y = normalizeHex(b)
  return x && y ? deltaE2000Lab(lab(x), lab(y)) : Number.POSITIVE_INFINITY
}

/**
 * Plans a slot for each color. `colors` holds one entry per body (or per texture color), null or undefined for one
 * without a color. Each distinct color, in the order it first appears, goes to the closest slot within the threshold:
 * one the project has that is not free, or one this plan already filled. Failing that it fills a slot of its own (the
 * lowest free one, else the one after the last) while that stays within `limit`, and failing that it takes the closest
 * slot there is. With no slot at all to fall back on, its pick is null.
 */
export function planColorSlots(colors: readonly (string | null | undefined)[], slots: readonly ColorSlot[], options: ColorSlotOptions): ColorSlotPlan {
  const threshold = options.threshold ?? COLOR_MATCH_DELTA_E
  const limit = Math.max(0, Math.min(COLOR_SLOT_MAX, Math.floor(options.limit)))
  const taken = slots.filter((s) => !s.free && normalizeHex(s.color)).map((s) => ({ index: s.index, lab: lab(normalizeHex(s.color)!), added: false }))
  const free = slots.filter((s) => s.free && s.index >= 1 && s.index <= limit).map((s) => s.index).sort((a, b) => a - b)
  let next = Math.max(0, ...slots.map((s) => s.index)) + 1
  const add: ColorSlotPlan['add'] = []
  const byColor = new Map<string, ColorSlotPick | null>()
  const pick = (hex: string): ColorSlotPick | null => {
    const c = lab(hex)
    let best: { index: number; added: boolean; d: number } | null = null
    for (const s of taken) {
      const d = deltaE2000Lab(c, s.lab)
      if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && s.index < best.index)) best = { index: s.index, added: s.added, d }
    }
    if (best && best.d <= threshold) return { slot: best.index, match: best.added ? 'new' : 'match', deltaE: best.d }
    const room = free.length ? free.shift()! : next <= limit ? next++ : null
    if (room !== null) {
      taken.push({ index: room, lab: c, added: true })
      add.push({ slot: room, color: hex })
      return { slot: room, match: 'new', deltaE: 0 }
    }
    return best ? { slot: best.index, match: 'nearest', deltaE: best.d } : null
  }
  const picks = colors.map((raw) => {
    const hex = normalizeHex(raw)
    if (!hex) return null
    if (!byColor.has(hex)) byColor.set(hex, pick(hex))
    return byColor.get(hex)!
  })
  return { picks, add }
}

/**
 * The nearest filament for each color by CIEDE2000, with no threshold and no new slots: a 1-based slot number into
 * `filaments` (filament 1 first), a tie going to the lower slot. 0 for a color that cannot be read or when there are no
 * filaments that can be read. The planner above decides when a color deserves a slot of its own; this is the plain
 * nearest match, kept to the same distance so other importers agree with it.
 */
export function nearestSlots(colors: readonly string[], filaments: readonly string[]): number[] {
  const labs = filaments.map((f) => normalizeHex(f)).map((f) => (f ? lab(f) : null))
  return colors.map((c) => {
    const hex = normalizeHex(c)
    if (!hex) return 0
    const x = lab(hex)
    let best = 0
    let d = Number.POSITIVE_INFINITY
    labs.forEach((l, i) => {
      if (!l) return
      const e = deltaE2000Lab(x, l)
      if (e < d - 1e-9) [best, d] = [i + 1, e]
    })
    return best
  })
}
