// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Vault listing's colors from a 3MF or the open project: every filament a
// printed part uses (its own slot, a part override and painted triangles), and
// which parts use more than one, so the listing can say "8 colors, 2 parts
// multi-color" instead of reading as an 8 color AMS print.
import type { ListingColors, ListingPart } from '@slicerx/contracts'
import { coverColor } from './cover'

/** What the colors are read from: a plate object or a file's object. */
export interface ColorSource {
  name: string
  parts: readonly { name: string; slot: number }[]
  /** Paint by part index, as the file's `paint_color` texts by triangle. */
  paint?: Readonly<Record<number, { color?: Readonly<Record<number, string>> } | undefined>>
  slotOverrides?: Readonly<Record<string, number>>
  printable?: boolean
  instanceOf?: string
}

/** The colors in file slot order, with the slot each one came from (`slots[i]` for `colors.colors[i]`). */
export interface DerivedColors {
  colors: ListingColors
  slots: number[]
}

const MAX_COLORS = 32
const MAX_PARTS = 200

/** `#rrggbb` in lowercase from a file's color (`#RRGGBB` or `#RRGGBBAA`); one the file leaves out takes the drawn cover's color for its slot. */
export function normalizeHex(c: string | undefined, slot = 1): string {
  return coverColor(c, slot)
}

/**
 * The filament states a paint text uses, painted ones only (state 0 is the part's own filament).
 * Same code walk as the viewport's decodeTree; a malformed text gives what was read before it broke.
 */
export function paintStates(text: string): number[] {
  const s = text.trim()
  const out = new Set<number>()
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
  return [...out].sort((a, b) => a - b)
}

/** The slots one object prints in. */
function objectSlots(o: ColorSource): Set<number> {
  const used = new Set<number>()
  o.parts.forEach((p, i) => {
    const own = o.slotOverrides?.[p.name] ?? p.slot
    used.add(Math.max(1, Math.floor(own)))
    for (const text of Object.values(o.paint?.[i]?.color ?? {})) for (const st of paintStates(text)) used.add(st)
  })
  return used
}

/** The colors of these objects, null when there are none. `palette` is the project's filament colors by slot. */
export function deriveColors(objects: readonly ColorSource[], palette: readonly string[]): DerivedColors | null {
  const perObject: { name: string; slots: number[] }[] = []
  const seen = new Set<string>()
  for (const o of objects) {
    if (o.instanceOf || o.printable === false) continue
    const slots = [...objectSlots(o)].sort((a, b) => a - b)
    const key = `${o.name}\n${slots.join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    perObject.push({ name: o.name.trim().slice(0, 120) || 'Part', slots })
  }
  const all = [...new Set(perObject.flatMap((p) => p.slots))].sort((a, b) => a - b).slice(0, MAX_COLORS)
  if (all.length === 0) return null
  const index = new Map(all.map((s, i) => [s, i]))
  const parts: ListingPart[] = perObject.slice(0, MAX_PARTS).flatMap((p) => {
    const colors = p.slots.flatMap((s) => (index.has(s) ? [index.get(s)!] : []))
    return colors.length ? [{ name: p.name, colors, ams: colors.length > 1 }] : []
  })
  return { colors: { colors: all.map((s) => ({ hex: normalizeHex(palette[s - 1], s) })), parts }, slots: all }
}
