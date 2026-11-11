// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Values a printer's stock G-code reads that are not settings of ours: the filament presets carry them, and the
// settings import leaves them out (they set nothing the slicer itself does). On a printer whose G-code reads one, the
// printer layer adds it per filament slot so the G-code renders with the filament's own value.

/** The keys of this kind a printer's G-code can read. */
export const SCRIPT_KEYS = ['fins_extrude_safe_temp', 'filament_ids'] as const

/** The script keys a printer's G-code texts read. */
export function scriptKeysRead(gcode: Readonly<Record<string, unknown>>): Set<string> {
  const text = Object.values(gcode).filter((v): v is string => typeof v === 'string').join('\n')
  return new Set(SCRIPT_KEYS.filter((k) => text.includes(k)))
}

/** A value read as a number: a number, numeric text, or the first entry of a list of those. */
function num(v: unknown): number | undefined {
  const one = Array.isArray(v) ? v[0] : v
  if (one === undefined || one === null || one === '') return undefined
  const n = typeof one === 'number' ? one : Number(String(one).trim())
  return Number.isFinite(n) ? n : undefined
}

/** A key's value through a preset's inheritance chain, the preset first and then its parents: the first that sets it. */
export function chainValue(chain: readonly Readonly<Record<string, unknown>>[], key: string): unknown {
  for (const layer of chain) if (layer[key] !== undefined && layer[key] !== null) return layer[key]
  return undefined
}

/**
 * The fin extrusion safe temperature (C) a filament gives the printer's G-code (`fins_extrude_safe_temp`): its own
 * preset's value, through the preset's parents; else the value of the maker's generic preset of the same material for
 * the printer; else 0, which the stock G-code takes as the check turned off.
 *
 * The last two steps match a real H3C slice: the generic PETG and ABS presets, which set no value, write 0, and the
 * PLAs 57. Change the rule here only.
 */
export function finsSafeTemp(chain: readonly Readonly<Record<string, unknown>>[], generic: Readonly<Record<string, unknown>> | undefined): number {
  return num(chainValue(chain, 'fins_extrude_safe_temp')) ?? num(generic?.['fins_extrude_safe_temp']) ?? 0
}
