// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The camera wall's logic: which printers need a person first, the count strip over the tiles, the bays
// printers stand in, and the one line each tile shows. Pure functions over the fleet rows.
import type { FleetRow } from '../../lib/queries'
import { isExportOnly } from '../../lib/hand-printers'
import type { PrinterBay } from '../../state/prefs'
import { recordDuration } from './device'
import { doneAt, jobTitle, running } from './hud'

/** Where a printer stands on the wall: needs a person, printing, ready for a job, offline, or export only. */
export type WallKind = 'need' | 'print' | 'ready' | 'off' | 'export'

const RANK: Record<WallKind, number> = { need: 0, print: 1, ready: 2, off: 3, export: 4 }

/** A slot under this share of its spool counts as low. */
export const LOW_FILAMENT_PCT = 25

export function wallKind(r: FleetRow): WallKind {
  if (isExportOnly(r)) return 'export'
  const s = r.status.state
  if (s === 'paused' || s === 'error') return 'need'
  if (s === 'printing' || s === 'preparing') return 'print'
  if (s === 'offline') return 'off'
  return 'ready'
}

/** Needs you, then printing with the soonest done first, then ready, then offline. Ties keep the name order. */
export function wallOrder<T extends FleetRow>(rows: readonly T[]): T[] {
  const left = (r: FleetRow) => r.status.timeLeftS ?? Infinity
  return [...rows].sort((a, b) => {
    const ka = wallKind(a)
    const kb = wallKind(b)
    if (ka !== kb) return RANK[ka] - RANK[kb]
    if (ka === 'print' && left(a) !== left(b)) return left(a) - left(b)
    return a.name.localeCompare(b.name)
  })
}

export interface WallCount {
  id: 'print' | 'need' | 'ready' | 'off' | 'low'
  label: string
  value: number
  sub: string
}

/** "Atlas", "Atlas and Mini", "Atlas and 2 more". */
function names(rows: readonly FleetRow[]): string {
  if (rows.length === 0) return ''
  if (rows.length === 1) return rows[0]!.name
  if (rows.length === 2) return `${rows[0]!.name} and ${rows[1]!.name}`
  return `${rows[0]!.name} and ${rows.length - 1} more`
}

/** Slots that report under a quarter of their spool left, on printers that are reachable. */
export function lowSlots(rows: readonly FleetRow[]): { printer: FleetRow; slot: FleetRow['status']['slots'][number] }[] {
  return rows.flatMap((r) =>
    wallKind(r) === 'off' || wallKind(r) === 'export' ? [] : r.status.slots.filter((s) => s.material && s.remainingPct !== undefined && s.remainingPct < LOW_FILAMENT_PCT).map((slot) => ({ printer: r, slot })),
  )
}

/** The count strip: Printing, Needs you, Ready, Offline and Filament low, each with its one-line sub. */
export function wallCounts(rows: readonly FleetRow[], now: number): WallCount[] {
  const ordered = wallOrder(rows)
  const of = (k: WallKind) => ordered.filter((r) => wallKind(r) === k)
  const printing = of('print')
  const need = of('need')
  const ready = of('ready')
  const off = of('off')
  const low = lowSlots(rows)
  const next = printing.find((r) => r.status.timeLeftS !== undefined && r.status.timeLeftS > 0)
  const first = need[0]
  return [
    { id: 'print', label: 'Printing', value: printing.length, sub: next ? `Next done ${doneAt(next.status.timeLeftS!, now)}, ${next.name}` : printing.length ? names(printing) : 'Nothing printing' },
    { id: 'need', label: 'Needs you', value: need.length, sub: first ? `${first.name}: ${needText(first)}` : 'All clear' },
    { id: 'ready', label: 'Ready', value: ready.length, sub: ready.length ? names(ready) : 'None free' },
    { id: 'off', label: 'Offline', value: off.length, sub: off.length ? names(off) : 'All reachable' },
    { id: 'low', label: 'Filament low', value: low.length, sub: `Slots under ${LOW_FILAMENT_PCT}%` },
  ]
}

/** What a printer that needs you wants, in a few words. */
function needText(r: FleetRow): string {
  const st = r.status
  if (st.message) return st.message
  return st.state === 'error' ? 'error' : 'paused'
}

/** The tile's pill: label and tone. */
export function wallPill(r: FleetRow): { label: string; tone: 'ok' | 'run' | 'warn' | 'bad' | 'off' } {
  const k = wallKind(r)
  if (k === 'export') return { label: 'Export only', tone: 'off' }
  if (k === 'need') return r.status.state === 'error' ? { label: 'Error', tone: 'bad' } : { label: 'Needs you', tone: 'warn' }
  if (k === 'print') return { label: r.status.state === 'preparing' ? 'Preparing' : 'Printing', tone: 'run' }
  if (k === 'off') return { label: 'Offline', tone: 'off' }
  return { label: r.status.state === 'finished' ? 'Finished' : 'Ready', tone: 'ok' }
}

/** The corner over the camera: time left while printing, Paused while paused, else nothing. */
export function timeLeftText(r: FleetRow): string {
  const st = r.status
  if (isExportOnly(r)) return ''
  if (st.state === 'paused') return 'Paused'
  if (running(st.state) && st.timeLeftS !== undefined && st.timeLeftS > 0) return `${recordDuration(st.timeLeftS)} left`
  return ''
}

/** The share of the job done, 0 to 1, or null when no bar shows. */
export function progressOf(r: FleetRow): number | null {
  const st = r.status
  if (isExportOnly(r) || !running(st.state) || st.progress === undefined) return null
  return Math.min(1, Math.max(0, st.progress))
}

/** The tile's one plain status line. */
export function statusLine(r: FleetRow, now: number): string {
  const st = r.status
  if (isExportOnly(r)) return 'No connection. Export the G-code for USB or SD card.'
  const job = st.jobName ? jobTitle(st.jobName) : ''
  const layer = st.layer !== undefined && st.layerCount ? `layer ${st.layer} of ${st.layerCount}` : ''
  switch (st.state) {
    case 'printing':
    case 'preparing': {
      const done = st.timeLeftS !== undefined && st.timeLeftS > 0 ? `done ${doneAt(st.timeLeftS, now)}` : ''
      return [job || 'Printing', layer, done].filter(Boolean).join(' · ')
    }
    case 'paused':
      return [st.message ?? 'Paused', job, layer].filter(Boolean).join(' · ')
    case 'error':
      return [st.message ?? 'The printer reports an error', job].filter(Boolean).join(' · ')
    case 'finished':
      return job ? `Finished ${job}` : 'Finished'
    case 'offline':
      return 'Not reachable'
    default:
      return 'Plate clear, ready for a job'
  }
}

export type Bay = PrinterBay

export interface WallGroup<T extends FleetRow> {
  /** The bay id, or null for printers with no bay. */
  id: string | null
  name: string
  place?: string
  rows: T[]
  summary: string
}

/** "2 printing · 1 offline": the states in a bay that have printers, in wall order. */
export function baySummary(rows: readonly FleetRow[]): string {
  const n = (k: WallKind) => rows.filter((r) => wallKind(r) === k).length
  const parts: [number, string][] = [
    [n('print'), 'printing'],
    [n('need'), 'needs you'],
    [n('ready'), 'ready'],
    [n('off'), 'offline'],
    [n('export'), 'export only'],
  ]
  return parts.filter(([c]) => c > 0).map(([c, w]) => `${c} ${w}`).join(' · ')
}

/**
 * One group per bay in the bays' own order, then Unassigned for printers with no bay or one that is gone.
 * A bay with no printers shows too, so a new bay is there to fill; Unassigned shows only when it holds some.
 */
export function bayGroups<T extends FleetRow>(rows: readonly T[], bays: readonly Bay[], printerBays: Readonly<Record<string, string>>): WallGroup<T>[] {
  const known = new Set(bays.map((b) => b.id))
  const bayOf = (r: FleetRow) => {
    const id = printerBays[r.id]
    return id && known.has(id) ? id : null
  }
  const ordered = wallOrder(rows)
  const out: WallGroup<T>[] = bays.map((b) => {
    const mine = ordered.filter((r) => bayOf(r) === b.id)
    return { id: b.id, name: b.name, ...(b.place ? { place: b.place } : {}), rows: mine, summary: baySummary(mine) }
  })
  const loose = ordered.filter((r) => bayOf(r) === null)
  if (loose.length) out.push({ id: null, name: 'Unassigned', rows: loose, summary: baySummary(loose) })
  return out
}

/** A new bay id that no bay uses yet. */
export function newBayId(bays: readonly Bay[], name: string): string {
  const base = `bay-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'new'}`.slice(0, 40)
  const used = new Set(bays.map((b) => b.id))
  let id = base
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`
  return id
}
