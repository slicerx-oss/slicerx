// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The filament presets as the slot editor needs them: brands, material types and products. The preset
// index is a few hundred KB, so this module loads on demand (the AMS panel imports it lazily).
import { filamentBrands, listFilamentFamilies, type FilamentFamilyInfo } from '@slicerx/settings'

export type { FilamentFamilyInfo }

export function brandList(): string[] {
  return filamentBrands().filter(Boolean)
}

export function typesFor(brand: string): string[] {
  return [...new Set(listFilamentFamilies({ brand }).map((f) => f.type))].sort((a, b) => a.localeCompare(b, 'en'))
}

export function productsFor(brand: string, type: string): FilamentFamilyInfo[] {
  return listFilamentFamilies({ brand, type }).sort((a, b) => a.family.localeCompare(b.family, 'en'))
}

export function typeList(): string[] {
  return [...new Set(listFilamentFamilies().map((f) => f.type))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'en'))
}

/**
 * The product a printer means by a material string such as "PLA Basic": the shortest product name
 * containing it, preferring the printer maker's own brand. A bare type ("PLA") matches nothing, since
 * any brand's PLA would be a guess.
 */
export function matchProduct(material: string, makerHint = ''): FilamentFamilyInfo | undefined {
  const m = material.trim().toLowerCase()
  if (!m || !m.includes(' ')) return undefined
  const hint = makerHint.trim().toLowerCase().split(/\s+/)[0] ?? ''
  const hits = listFilamentFamilies().filter((f) => f.family.toLowerCase().includes(m))
  const own = hint ? hits.filter((f) => f.brand.toLowerCase().includes(hint)) : []
  return (own.length ? own : hits).sort((a, b) => a.family.length - b.family.length)[0]
}
