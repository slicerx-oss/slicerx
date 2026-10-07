// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Editing a listing's colors: add, remove, reorder, rename, recolor and mark
// AMS parts. Parts point at colors by index, so every change that moves a
// color moves the parts' indexes with it. Each color keeps the file slot it
// came from, which is how the drawn cover follows the creator's edits.
import type { ListingColors } from '@slicerx/contracts'

export interface ColorDraft {
  colors: ListingColors
  /** The file slot of each color, null for one the creator added. Never stored. */
  slots: (number | null)[]
  /** Stable React keys, one per color. */
  keys: number[]
}

let nextKey = 1

export function draftOf(colors: ListingColors | null | undefined, slots: readonly (number | null)[] = []): ColorDraft {
  const c = colors ?? { colors: [], parts: [] }
  return { colors: c, slots: c.colors.map((_, i) => slots[i] ?? null), keys: c.colors.map(() => nextKey++) }
}

/** Applies a new order: `order[k]` is the old index of the color now at k. Colors left out are removed. */
function reindex(d: ColorDraft, order: number[]): ColorDraft {
  const map = new Map(order.map((old, k) => [old, k]))
  const parts = d.colors.parts.flatMap((p) => {
    const colors = p.colors.flatMap((i) => (map.has(i) ? [map.get(i)!] : [])).sort((a, b) => a - b)
    // A part whose only colors were removed goes with them; one left with a single color no longer needs the AMS.
    return colors.length ? [{ ...p, colors, ams: p.ams && colors.length > 1 }] : []
  })
  return {
    colors: { colors: order.map((i) => d.colors.colors[i]!), parts },
    slots: order.map((i) => d.slots[i] ?? null),
    keys: order.map((i) => d.keys[i]!),
  }
}

export function moveColor(d: ColorDraft, from: number, to: number): ColorDraft {
  const n = d.colors.colors.length
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return d
  const order = d.colors.colors.map((_, i) => i)
  order.splice(to, 0, order.splice(from, 1)[0]!)
  return reindex(d, order)
}

export function removeColor(d: ColorDraft, i: number): ColorDraft {
  return reindex(
    d,
    d.colors.colors.map((_, k) => k).filter((k) => k !== i),
  )
}

export function addColor(d: ColorDraft, hex = '#8e8e93'): ColorDraft {
  return { colors: { ...d.colors, colors: [...d.colors.colors, { hex }] }, slots: [...d.slots, null], keys: [...d.keys, nextKey++] }
}

export function updateColor(d: ColorDraft, i: number, patch: { hex?: string; name?: string }): ColorDraft {
  const colors = d.colors.colors.map((c, k) => {
    if (k !== i) return c
    const hex = patch.hex !== undefined ? patch.hex.toLowerCase() : c.hex
    const name = patch.name !== undefined ? patch.name : c.name
    return name ? { hex, name } : { hex }
  })
  return { ...d, colors: { ...d.colors, colors } }
}

export function setPartAms(d: ColorDraft, part: number, ams: boolean): ColorDraft {
  return { ...d, colors: { ...d.colors, parts: d.colors.parts.map((p, k) => (k === part ? { ...p, ams } : p)) } }
}

/** File slot to the color the creator gave it, for drawing the cover again. */
export function slotColors(d: ColorDraft): Record<number, string> {
  const out: Record<number, string> = {}
  d.slots.forEach((s, i) => {
    const hex = d.colors.colors[i]?.hex
    if (s !== null && hex) out[s] = hex
  })
  return out
}

/** What is stored: names trimmed and empty ones dropped, null with no colors. */
export function savedColors(d: ColorDraft): ListingColors | null {
  if (d.colors.colors.length === 0) return null
  return {
    colors: d.colors.colors.map((c) => {
      const name = c.name?.trim().replace(/\s+/g, ' ')
      return name ? { hex: c.hex, name } : { hex: c.hex }
    }),
    parts: d.colors.parts,
  }
}
