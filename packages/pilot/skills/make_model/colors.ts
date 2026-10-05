// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Color names to filament colors, and filament presets for a slot.
import { listFilamentFamilies } from '@slicerx/settings'
import { parseColor } from '../d_common/index'

/** The SlicerX brand kit (design/tokens.css, editions/slicerx/brand). Black is the kit's ink-1. */
export const BRAND_COLORS: Record<string, { hex: string; label: string }> = {
  'slicerx black': { hex: '#17181f', label: 'SlicerX black' },
  'slicerx ink': { hex: '#17181f', label: 'SlicerX black' },
  'slicerx white': { hex: '#f8f8f2', label: 'SlicerX white' },
  'slicerx purple': { hex: '#bd93f9', label: 'SlicerX purple' },
  'x purple': { hex: '#bd93f9', label: 'SlicerX purple' },
  'slicerx pink': { hex: '#ff79c6', label: 'X pink' },
  'x pink': { hex: '#ff79c6', label: 'X pink' },
  'slicerx cyan': { hex: '#8be9fd', label: 'SlicerX cyan' },
  'slicerx green': { hex: '#50fa7b', label: 'SlicerX green' },
  'slicerx orange': { hex: '#ffb86c', label: 'SlicerX orange' },
  'slicerx yellow': { hex: '#f1fa8c', label: 'SlicerX yellow' },
  'slicerx red': { hex: '#ff5555', label: 'SlicerX red' },
}

export interface ResolvedColor {
  hex: string
  label: string
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0')

/** A brand name ("SlicerX black", "X pink"), a plain name ("blue") or a hex value. Null when unknown. */
export function resolveColor(text: string): ResolvedColor | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ')
  const brand = BRAND_COLORS[t]
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
