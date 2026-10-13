// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which printer slot feeds each filament of a print, on a printer that follows a slot map. The Print sheet and
// printer.queue both start from this match, so a person and a client get the same slots for the same plate.

/** One filament of a print: its 1 based number, as the app and the Print sheet count them, with its material and color. */
export interface MapFilament {
  index: number
  color: string
  type: string
}

/** One slot as the printer reports it. A slot with no material is empty. */
export interface MapSlot {
  id: string
  material?: string
  color?: string
}

/** The external spool as the printer drivers name it: a slot id of "1" (Bambu tray 254). */
export const EXTERNAL_SLOT = '1'

const rgb = (hex: string | undefined): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})/i.exec(hex ?? '')
  if (!m) return null
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Distance between two colors, 0 to 441. Colors that cannot be read are far apart. */
export function colorDistance(a: string | undefined, b: string | undefined): number {
  const x = rgb(a)
  const y = rgb(b)
  if (!x || !y) return 441
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

/** The material family a slot or filament names, such as "PLA" for "PLA Matte". */
export const baseMaterial = (m: string | undefined): string => (m ?? '').toUpperCase().split(/[^A-Z0-9]+/)[0] ?? ''

/**
 * Loaded slots that can take over when the mapped one runs dry: another slot with the same material and a close
 * color, not already mapped to a filament of this print. The printer's own auto refill (Bambu AMS) works the same way, so
 * this shows what it will find. Different material or color does not qualify; a change like that would show in the print.
 */
export function backupSlots(filament: MapFilament, map: Readonly<Record<number, string>>, slots: readonly MapSlot[]): MapSlot[] {
  const mapped = new Set(Object.values(map))
  const own = map[filament.index]
  return slots.filter((s) => s.id !== own && s.id !== EXTERNAL_SLOT && !mapped.has(s.id) && baseMaterial(s.material) === baseMaterial(filament.type) && colorDistance(s.color, filament.color) < 60)
}

/**
 * The starting slot for each filament on a printer that follows a slot map, the way Bambu Studio's mapping
 * dialog picks it: a loaded slot of the same material, the closest color first, each slot used once. The
 * closest pairs across the whole plate go first, so one filament cannot take the slot another matches better. A
 * filament no loaded slot matches by material stays out of the map: the sheet shows it as not loaded and the
 * person picks a slot. Keys are the filaments' 1 based numbers.
 */
export function matchSlots(filaments: readonly MapFilament[], slots: readonly MapSlot[]): Record<number, string> {
  const pairs: { f: number; s: string; d: number; order: number }[] = []
  slots.forEach((s, order) => {
    if (!s.material) return
    for (const f of filaments) if (baseMaterial(s.material) === baseMaterial(f.type)) pairs.push({ f: f.index, s: s.id, d: colorDistance(s.color, f.color), order })
  })
  pairs.sort((a, b) => a.d - b.d || a.f - b.f || a.order - b.order)
  const out: Record<number, string> = {}
  const taken = new Set<string>()
  for (const p of pairs) {
    if (out[p.f] !== undefined || taken.has(p.s)) continue
    out[p.f] = p.s
    taken.add(p.s)
  }
  return out
}

/** The slots two or more filaments of one print would end up in. Empty when every filament has a slot of its own. */
export function duplicateTargets(map: Readonly<Record<number, string>>): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const id of Object.values(map)) (seen.has(id) ? dup : seen).add(id)
  return [...dup]
}
