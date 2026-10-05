// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The device view's logic: what each part shows for one printer's status, and what it hides when the
// printer does not report it. Pure functions, so the view stays a thin layer over the status stream.
import type { FilamentSlot, PrinterLive, PrinterState, PrinterStatus, Temp } from '@slicerx/contracts'
import { filamentUnitName } from '@slicerx/printer-catalog'
import type { Prefs } from '../../state/prefs'
import { recordDuration } from './device'

/** The state pill: label and tone. */
export function statePill(s: Pick<PrinterStatus, 'state' | 'message'>): { label: string; tone: 'ok' | 'run' | 'warn' | 'bad' | 'off' } {
  const map: Record<PrinterState, { label: string; tone: 'ok' | 'run' | 'warn' | 'bad' | 'off' }> = {
    idle: { label: 'Idle', tone: 'ok' },
    finished: { label: 'Finished', tone: 'ok' },
    preparing: { label: 'Preparing', tone: 'run' },
    printing: { label: 'Printing', tone: 'run' },
    paused: { label: s.message ? 'Needs you' : 'Paused', tone: 'warn' },
    error: { label: 'Error', tone: 'bad' },
    offline: { label: 'Offline', tone: 'off' },
  }
  return map[s.state]
}

export const running = (state: PrinterState) => state === 'printing' || state === 'paused'

/** "Harbor lantern.gcode.3mf" reads as "Harbor lantern". */
export function jobTitle(name: string): string {
  return name.replace(/\.(gcode(\.3mf)?|bgcode|3mf)$/i, '')
}

/** The clock time a print ends, "7:48 PM", with the weekday when it is not today. */
export function doneAt(timeLeftS: number, now: number): string {
  const end = new Date(now + timeLeftS * 1000)
  const time = end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return new Date(now).toDateString() === end.toDateString() ? time : `${end.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
}

/** The job line of the top bar: layer, time left and when it is done. Parts the printer does not report are left out. */
export function jobLine(s: Pick<PrinterStatus, 'layer' | 'layerCount' | 'timeLeftS' | 'state'>, now: number): string {
  const parts: string[] = []
  if (s.layer !== undefined && s.layerCount) parts.push(`Layer ${s.layer} of ${s.layerCount}`)
  if (running(s.state) && s.timeLeftS !== undefined && s.timeLeftS > 0) parts.push(`${recordDuration(s.timeLeftS)} left`, `done ${doneAt(s.timeLeftS, now)}`)
  return parts.join(' · ')
}

export type GaugeKind = 'nozzle' | 'bed' | 'chamber'

export interface Gauge {
  id: string
  kind: GaugeKind
  label: string
  temp: Temp
  /** Top of the dial in °C. */
  max: number
}

const DIAL_MAX: Record<GaugeKind, number> = { nozzle: 300, bed: 120, chamber: 65 }

/**
 * The temperature gauges a printer reports: each nozzle (left first on a printer with two side by side), the bed and
 * the chamber. Nothing for a heater it does not report, and nothing at all while it is offline.
 */
export function gauges(s: Pick<PrinterStatus, 'state' | 'nozzles' | 'bed' | 'chamber' | 'live'>): Gauge[] {
  if (s.state === 'offline') return []
  const sides = s.live?.nozzleSides
  const nozzles = s.nozzles.map((t, i) => {
    const side = sides?.length === s.nozzles.length ? sides[i] : undefined
    const label = side ? `${side === 'left' ? 'Left' : 'Right'} nozzle` : s.nozzles.length > 1 ? `Nozzle ${i + 1}` : 'Nozzle'
    return { id: `nozzle-${side ?? i}`, kind: 'nozzle' as const, label, temp: t, max: DIAL_MAX.nozzle, order: side === 'left' ? -1 : i }
  })
  nozzles.sort((a, b) => a.order - b.order)
  const out: Gauge[] = nozzles.map(({ order: _order, ...g }) => g)
  if (s.bed) out.push({ id: 'bed', kind: 'bed', label: 'Bed', temp: s.bed, max: DIAL_MAX.bed })
  if (s.chamber) out.push({ id: 'chamber', kind: 'chamber', label: 'Chamber', temp: s.chamber, max: DIAL_MAX.chamber })
  return out
}

/** The 270 degree dial: the share of the arc the current temperature fills, and where the target mark sits (null with the heater off). */
export function dial(g: Gauge): { fill: number; target: number | null } {
  const share = (c: number) => Math.min(1, Math.max(0, c / g.max))
  return { fill: share(g.temp.current), target: g.temp.target > 0 ? share(g.temp.target) : null }
}

export interface Fan {
  id: 'part' | 'aux' | 'chamber'
  label: string
  percent: number
}

/** The fans a printer reports, in the order Bambu Studio lists them. */
export function fans(live: PrinterLive | undefined): Fan[] {
  const f = live?.fans
  if (!f) return []
  const rows: Fan[] = []
  if (f.part !== undefined) rows.push({ id: 'part', label: 'Part cooling', percent: f.part })
  if (f.aux !== undefined) rows.push({ id: 'aux', label: 'Auxiliary', percent: f.aux })
  if (f.chamber !== undefined) rows.push({ id: 'chamber', label: 'Chamber', percent: f.chamber })
  return rows
}

const UNIT_KIND: Record<string, string> = { ams: 'AMS', 'ams-lite': 'AMS lite', 'ams-2-pro': 'AMS 2 Pro', 'ams-ht': 'AMS HT', mmu: 'MMU' }

export interface SlotGroup {
  /** The slot letter (`A`), or `external`. */
  id: string
  label: string
  /** The nozzle it feeds on a printer with two, as words: "left nozzle". */
  feeds?: string
  slots: FilamentSlot[]
}

/** True when the printer has an AMS or another unit whose slots are lettered (A1 to A4). */
export function hasUnits(slots: readonly FilamentSlot[]): boolean {
  return slots.some((s) => /^[A-Z]\d+$/.test(s.id))
}

/**
 * The filament slots grouped as the printer's units: each AMS in slot order, then the external spool. Units are named
 * as the printer's maker names them ("AMS", "AMS HT", "AMS lite"), numbered when there are two of a kind.
 */
export function slotGroups(slots: readonly FilamentSlot[], live: PrinterLive | undefined, model: string): SlotGroup[] {
  const groups: SlotGroup[] = []
  for (const s of slots) {
    const letter = /^([A-Z])\d+$/.exec(s.id)?.[1] ?? 'external'
    let g = groups.find((x) => x.id === letter)
    if (!g) {
      const unit = live?.units?.find((u) => u.id === letter)
      g = { id: letter, label: letter === 'external' ? 'External spool' : (UNIT_KIND[unit?.kind ?? ''] ?? filamentUnitName(model, 'ams')), ...(unit?.feeds ? { feeds: `${unit.feeds} nozzle` } : {}), slots: [] }
      groups.push(g)
    }
    g.slots.push(s)
  }
  // Two units of one kind read "AMS 1" and "AMS 2".
  const kinds = groups.map((g) => g.label)
  groups.forEach((g, i) => {
    const same = kinds.filter((k, j) => k === kinds[i] && groups[j]!.id !== 'external')
    if (same.length > 1) g.label = `${kinds[i]} ${kinds.slice(0, i + 1).filter((k) => k === kinds[i]).length}`
  })
  const ext = groups.findIndex((g) => g.id === 'external')
  if (ext >= 0) groups.push(...groups.splice(ext, 1))
  return groups
}

/** "A1 · PLA Basic", or "A4 · Empty"; the external spool by its filament alone. */
export function slotName(s: FilamentSlot): string {
  return /^[A-Z]\d+$/.test(s.id) ? `${s.id} · ${s.material ?? 'Empty'}` : (s.material ?? 'Empty')
}

/** The slot feeding the nozzle now, shown only while a print runs. */
export function printingSlot(s: Pick<PrinterStatus, 'state' | 'live'>): string | undefined {
  return running(s.state) ? s.live?.activeSlot : undefined
}

/** The speed profiles of Bambu Lab printers, with the speed factor each one sets. */
export const SPEED_PROFILES = [
  { id: 'silent', label: 'Silent', percent: 50 },
  { id: 'standard', label: 'Standard', percent: 100 },
  { id: 'sport', label: 'Sport', percent: 124 },
  { id: 'ludicrous', label: 'Ludicrous', percent: 166 },
] as const

export type SpeedLimits = { min: number; max: number } | { levels: number[] }

/** The profiles the hub takes on this printer: its own levels, or those inside its speed range. All four when the limits are not known yet. */
export function speedChoices(limits: SpeedLimits | null): (typeof SPEED_PROFILES)[number][] {
  if (!limits) return [...SPEED_PROFILES]
  return SPEED_PROFILES.filter((p) => ('levels' in limits ? limits.levels.includes(p.percent) : p.percent >= limits.min && p.percent <= limits.max))
}

/** The profile a reported speed factor is, or null for one between them. */
export function speedProfile(percent: number | undefined): (typeof SPEED_PROFILES)[number] | null {
  return SPEED_PROFILES.find((p) => p.percent === percent) ?? null
}

/** The bottom bar's layer line: "Layer 62 of 100", with the height when the printer reports it. */
export function layerLine(s: Pick<PrinterStatus, 'layer' | 'layerCount' | 'live'>): { layer: string; height: string | null } | null {
  if (s.layer === undefined || !s.layerCount) return null
  const z = s.live?.layerZMm
  return { layer: `Layer ${s.layer} of ${s.layerCount}`, height: z !== undefined ? `Z ${z.toFixed(2).replace(/0$/, '')} mm` : null }
}

/** The key the drawers are kept under in the per-user rail memory. */
export const HUD_RAIL = 'printer-hud'

/** Which drawers this person last left open. Both start closed. */
export function drawersOf(rails: Prefs['rails']): { left: boolean; right: boolean } {
  const r = rails[HUD_RAIL]
  return { left: r?.left ?? false, right: r?.right ?? false }
}
