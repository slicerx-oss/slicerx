// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Filament slots. A slot is what the plate calls "filament 1, 2, 3": a material, a brand and a color.
// Where a slot's values come from, first match wins: what the person set, what the connected printer
// reports for its AMS or MMU, the color the model file carries, a default.
import type { FilamentSlot, PlateObject } from '@slicerx/contracts'
import type { FlushSettings } from './flush-defaults'
import { allPlates } from '../plate/plates'
import { get, set, type AppState, type PlateEntry, type PlateMeta } from '../state/store'
import { brandAccent } from '../edition'

export const MAX_SLOTS = 16

export interface SlotSetup {
  /** Material type: PLA, PETG, TPU. */
  type: string
  brand: string
  /** The product within the brand, such as "Bambu PLA Basic", when picked from our presets. */
  family?: string
  /** Preset file the family lives in (see @slicerx/settings listFilamentFamilies). */
  vendor?: string
  color: string
}

export type SlotSource = 'user' | 'printer' | 'model' | 'default'

export interface ResolvedSlot extends SlotSetup {
  /** 1-based, as the engine numbers filaments. */
  index: number
  /** The printer's name for it ("A1") or the number. */
  label: string
  source: SlotSource
  remainingPct?: number
  /** Exact grams left, when the printer reports them. */
  remainingG?: number
  /** Parts on any plate use it. */
  used: boolean
}

// the seventh slot takes the edition's accent
const defaultColors = () => ['#f8f8f2', '#282a36', '#ff5555', '#50fa7b', '#8be9fd', '#ffb86c', brandAccent(), '#f1fa8c']

const TYPES = ['PLA', 'PETG', 'PET', 'ABS', 'ASA', 'PC', 'PA', 'TPU', 'PVA', 'HIPS', 'PP', 'PPS', 'PEEK', 'BVOH', 'EVA']

/** "PLA Basic" gives "PLA"; anything unrecognized gives "PLA", the safe default. */
export function materialType(material: string | undefined): string {
  if (!material) return 'PLA'
  const words = material.toUpperCase().split(/[^A-Z0-9]+/)
  return words.find((w) => TYPES.includes(w)) ?? 'PLA'
}

const isHex = (c: string | undefined): c is string => Boolean(c && /^#[0-9a-f]{6}$/i.test(c.slice(0, 7)))

export function normalizeColor(c: string | undefined, fallback: string): string {
  return isHex(c) ? c.slice(0, 7).toLowerCase() : fallback
}

/** How many slots the project needs: the printer's, the highest a part uses, the highest set by hand. */
export function slotCount(s: Pick<AppState, 'printerSlots' | 'plates' | 'plate' | 'activePlate' | 'slotSetup'>): number {
  let n = s.printerSlots.length
  for (const p of allPlates(s)) for (const o of p.objects) for (const part of o.handle.parts) n = Math.max(n, effectiveSlot(o, part))
  for (const k of Object.keys(s.slotSetup)) n = Math.max(n, Number(k))
  return Math.min(MAX_SLOTS, Math.max(1, n))
}

/** The slot every part of every plate ends up in, after the plate's own color swaps. */
export function usedSlots(s: Pick<AppState, 'plates' | 'plate' | 'activePlate'>): Set<number> {
  const out = new Set<number>()
  for (const p of allPlates(s)) for (const o of p.objects) if (o.printable !== false) for (const part of o.handle.parts) out.add(mapSlot(p, effectiveSlot(o, part)))
  return out
}

/** The slot a part prints in on its object: the person's choice for that part, else the file's. */
export function effectiveSlot(o: Pick<PlateEntry, 'slotOverrides'>, part: { name: string; slot: number }): number {
  return o.slotOverrides?.[part.name] ?? part.slot
}

export function mapSlot(plate: Pick<PlateMeta, 'settings'> | undefined, slot: number): number {
  return plate?.settings.slotMap?.[slot] ?? slot
}

type SlotInputs = Pick<AppState, 'printerSlots' | 'plates' | 'plate' | 'activePlate' | 'slotSetup'> & Partial<Pick<AppState, 'slotMatch' | 'fileSlotColors'>>

/**
 * The model's color for each slot: the project file's filament colors, then for slots the file does not name, the color
 * of the first part the file put in that slot (an entry's colors are per part, so part i's color goes to part i's slot).
 */
export function modelSlotColors(s: Pick<SlotInputs, 'plates' | 'plate' | 'activePlate' | 'fileSlotColors'>): (string | undefined)[] {
  const out: (string | undefined)[] = [...(s.fileSlotColors ?? [])]
  for (const p of allPlates(s)) for (const o of p.objects) {
    const parts = o.parts.length ? o.parts : o.handle.parts
    parts.forEach((part, i) => (out[part.slot - 1] ??= o.colors[i]))
  }
  return out
}

export function resolveSlots(s: SlotInputs): ResolvedSlot[] {
  const n = slotCount(s)
  const used = usedSlots(s)
  const modelColors = modelSlotColors(s)
  return Array.from({ length: n }, (_, i) => {
    const index = i + 1
    const fallback = defaultColors()[i % 8]!
    const mine = s.slotSetup[index]
    const printer: FilamentSlot | undefined = s.printerSlots[i]
    const base = { index, used: used.has(index), ...(printer?.remainingPct !== undefined ? { remainingPct: printer.remainingPct } : {}), ...(printer?.remainingG !== undefined ? { remainingG: printer.remainingG } : {}) }
    if (mine) return { ...base, ...mine, label: printer?.id ?? String(index), source: 'user' as const }
    if (printer && (printer.material || printer.color)) {
      const match = s.slotMatch?.[index]
      return { ...base, type: materialType(printer.material), brand: match?.brand ?? '', ...(match?.family ? { family: match.family } : {}), ...(match?.vendor ? { vendor: match.vendor } : {}), color: normalizeColor(printer.color, fallback), label: printer.id, source: 'printer' as const }
    }
    const model = modelColors[i]
    if (isHex(model)) return { ...base, type: 'PLA', brand: '', color: normalizeColor(model, fallback), label: printer?.id ?? String(index), source: 'model' as const }
    return { ...base, type: 'PLA', brand: '', color: fallback, label: printer?.id ?? String(index), source: 'default' as const }
  })
}

/** How a slot's filament shines in Preview, from its name: silk, matte, glossy (PETG and PCTG), else satin. */
export function slotFinish(r: Pick<ResolvedSlot, 'type' | 'brand'> & { family?: string }): 'matte' | 'satin' | 'glossy' | 'silk' {
  const name = `${r.type} ${r.family ?? ''} ${r.brand}`
  if (/silk/i.test(name)) return 'silk'
  if (/matte?\b/i.test(name)) return 'matte'
  return /\bP(ET|CT)G\b/i.test(name) ? 'glossy' : 'satin'
}

export function resolved(): ResolvedSlot[] {
  return resolveSlots(get())
}

/** Sets a slot by hand. Changing a slot changes the slice, so a finished one goes stale (the store watchers do the rest). */
export function setSlot(index: number, patch: Partial<SlotSetup>): void {
  if (index < 1 || index > MAX_SLOTS) return
  // A slot past the current count starts from the defaults, which is how "Add filament" makes one.
  const cur = resolved().find((r) => r.index === index) ?? { type: 'PLA', brand: '', color: defaultColors()[(index - 1) % 8]! }
  const next: SlotSetup = { type: cur.type, brand: cur.brand, color: cur.color, ...('family' in cur && cur.family ? { family: cur.family } : {}), ...('vendor' in cur && cur.vendor ? { vendor: cur.vendor } : {}), ...patch }
  set((s) => ({ slotSetup: { ...s.slotSetup, [index]: next } }))
}

/** Drops the hand-set values of a slot, or of all slots, so the printer's report shows through again. */
export function resetSlots(index?: number): void {
  if (index === undefined) return void set({ slotSetup: {} })
  set((s) => {
    const { [index]: _gone, ...rest } = s.slotSetup
    return { slotSetup: rest }
  })
}

export function setFlush(patch: Partial<FlushSettings>): void {
  set((s) => ({ flush: { ...s.flush, ...patch } }))
}

/** Sets one flush value by hand, or clears it (undefined) so auto flush takes over. */
export function setFlushManual(key: string, value: number | undefined): void {
  set((s) => {
    const { [key]: _old, ...rest } = s.flush.manual
    return { flush: { ...s.flush, manual: value === undefined ? rest : { ...rest, [key]: value } } }
  })
}

/** Swaps what two slots print on one plate, the way Bambu Studio swaps colors: parts that used slot a use b and the other way round. */
export function swapPlateSlots(plateId: string, a: number, b: number): void {
  if (a === b) return
  set((s) => ({
    plates: s.plates.map((p) => {
      if (p.id !== plateId) return p
      const map: Record<number, number> = { ...p.settings.slotMap }
      const count = slotCount(s)
      for (let slot = 1; slot <= count; slot++) {
        const now = map[slot] ?? slot
        const to = now === a ? b : now === b ? a : now
        if (to === slot) delete map[slot]
        else map[slot] = to
      }
      const { slotMap: _old, ...rest } = p.settings
      return { ...p, settings: Object.keys(map).length ? { ...rest, slotMap: map } : rest }
    }),
  }))
}

/** Part name to slot, only where the plate's swaps change it. Goes into the engine's `slotOverrides`. */
export function slotOverridesFor(plate: PlateMeta | undefined, obj: { slotOverrides?: Record<string, number>; handle: { parts: { name: string; slot: number }[] } }): PlateObject['slotOverrides'] {
  const map = plate?.settings.slotMap
  const out: Record<string, number> = {}
  for (const part of obj.handle.parts) {
    const own = effectiveSlot(obj as Pick<PlateEntry, 'slotOverrides'>, part)
    const to = map?.[own] ?? own
    if (to !== part.slot) out[part.name] = to
  }
  return Object.keys(out).length ? out : undefined
}
