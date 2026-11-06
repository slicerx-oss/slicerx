// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printer's chamber limit (the H3C heats its chamber to 65 C at most, from the printer catalog). The filament's
// Chamber temperature field takes no more than the limit and says it under the field; a value over it that came in
// another way (a project, a client) says what slicing uses. The engine holds the slice to the same limit
// (machineLimits) and warns.
import type { SettingValue } from '@slicerx/contracts'

/** The chamber limit in C of the printer the plate slices for, when its profile has one. */
export function chamberLimit(profile: { limits: { chamberMaxC?: number } } | null | undefined): number | undefined {
  return profile?.limits.chamberMaxC
}

/** What the field's text commits: empty clears the filament's own value, text that is not a number keeps it (null), else 0 to the limit. */
export function parseChamber(text: string, limit: number): number | undefined | null {
  const t = text.trim()
  if (t === '') return undefined
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  return Math.round(Math.min(limit, Math.max(0, n)))
}

/** The line under the field: the limit, or what slicing uses for a target over it. */
export function chamberNote(value: SettingValue | undefined, limit: number | undefined): string | undefined {
  if (limit === undefined) return undefined
  const top = Math.max(...(Array.isArray(value) ? value : [value]).map(Number).filter(Number.isFinite), 0)
  return top > limit ? `${top} C is over the ${limit} C this printer heats its chamber to. Slicing uses ${limit} C.` : `This printer heats its chamber to ${limit} C at most.`
}
