// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Color names to filament colors, and filament presets for a slot.
import { DEFAULT_PRODUCT_NAME, productColors, productName } from '@slicerx/contracts'
import { listFilamentFamilies } from '@slicerx/settings'
import { parseColor } from '../d_common/index'

/** SlicerX's brand kit (design/tokens.css, editions/slicerx/brand), the palette of an edition without brand.colors. Black is the kit's ink-1. */
export const KIT_COLORS: Readonly<Record<string, string>> = {
  black: '#17181f',
  white: '#f8f8f2',
  purple: '#bd93f9',
  pink: '#ff79c6',
  cyan: '#8be9fd',
  green: '#50fa7b',
  orange: '#ffb86c',
  yellow: '#f1fa8c',
  red: '#ff5555',
}

/** Older names the SlicerX edition keeps taking: "<name> ink" is black, and the X mark's "X pink" and "X purple". */
const KIT_ALIASES: Readonly<Record<string, string>> = { ink: 'black', 'x purple': 'purple', 'x pink': 'pink' }

/** The kit's pink is the X mark's color, so the SlicerX edition labels it "X pink". */
const KIT_LABELS: Readonly<Record<string, string>> = { pink: 'X pink' }

const key = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * The brand colors make_model takes by name: the edition's brand.colors as "<brand name> <color>" (Acme Slicer black),
 * or SlicerX's kit under the edition's name when it has none. The SlicerX edition keeps its kit's older names too.
 */
export function brandColors(): Record<string, { hex: string; label: string }> {
  const name = productName()
  const own = productColors()
  const kit = !own && name === DEFAULT_PRODUCT_NAME
  const out: Record<string, { hex: string; label: string }> = {}
  for (const [color, hex] of Object.entries(own ?? KIT_COLORS)) {
    const label = (kit ? KIT_LABELS[color] : undefined) ?? `${name} ${color}`
    out[key(`${name} ${color}`)] = { hex, label }
    if (kit && KIT_LABELS[color]) out[key(label)] = { hex, label }
  }
  if (kit) {
    for (const [alias, color] of Object.entries(KIT_ALIASES)) {
      const c = out[key(`${name} ${color}`)]
      if (c) out[alias.includes(' ') ? alias : key(`${name} ${alias}`)] = c
    }
  }
  return out
}

/** Two brand color names for tool text, such as "Acme Slicer black" and "Acme Slicer pink". */
export function brandColorExamples(): [string, string] {
  const labels = [...new Set(Object.values(brandColors()).map((c) => c.label))]
  return [labels[0] ?? 'black', labels.find((l) => /pink/.test(l)) ?? labels[1] ?? labels[0] ?? 'pink']
}

export interface ResolvedColor {
  hex: string
  label: string
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0')

/** A brand color name (brandColors), a plain name ("blue") or a hex value. Null when unknown. */
export function resolveColor(text: string): ResolvedColor | null {
  const t = key(text)
  const brand = brandColors()[t]
  if (brand) return brand
  const rgb = parseColor(t)
  if (!rgb) return null
  const hex = `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`
  return { hex, label: /^#?[0-9a-f]{6}/.test(t) ? hex : text.trim().toLowerCase() }
}

export interface SlotPreset {
  vendor: string
  family: string
  type: string
}

/** A filament product for a material: the printer maker's basic line when it has one, else a generic preset. */
export function pickPreset(material: string, printerId: string | undefined): SlotPreset | null {
  const type = material.trim().toUpperCase()
  const all = listFilamentFamilies({ type })
  if (all.length === 0) return null
  const bambu = /^bambu/i.test(printerId ?? '')
  const pick = (bambu ? all.find((f) => f.brand === 'Bambu Lab' && /basic/i.test(f.family)) : undefined) ?? all.find((f) => /^generic/i.test(f.family)) ?? all[0]
  return pick ? { vendor: pick.vendor, family: pick.family, type: pick.type } : null
}
