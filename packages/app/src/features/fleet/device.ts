// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The device page's logic: what the hub offers (link-client `device`), when a jog is allowed, and
// how a start from the printer's own file list asks its two questions (is the plate clear, and do
// you trust a file SlicerX did not upload). The hub enforces every limit; these rules only keep the
// buttons honest.
import type { Host, PrinterState, PrinterStatus, StartOptions } from '@slicerx/contracts'
import { appName } from '../../edition'

export interface StoredFile { path: string; name: string; size?: number; modified?: number }
export interface PrintRecord { name: string; outcome: 'completed' | 'canceled' | 'failed'; detail?: string; startedAt?: number; durationS?: number; filamentMm?: number }
export interface PrintObject { id: string; name: string; skipped: boolean; center?: [number, number]; polygon?: [number, number][] }
/** `stale`: left over from a job that is no longer running, shown as history rather than a problem now. */
export interface PrinterIssue { code: string; severity: 'fatal' | 'serious' | 'common' | 'info'; module: string; text: string; helpUrl?: string; stale?: boolean }

/** The hub methods the page uses (link-client `LinkHost.device` and `bed`). */
export interface DeviceHub {
  device: {
    files(printerId: string): Promise<StoredFile[]>
    history(printerId: string): Promise<PrintRecord[]>
    issues(printerId: string): Promise<PrinterIssue[]>
    objects(printerId: string): Promise<PrintObject[]>
    jog(printerId: string, axis: 'x' | 'y' | 'z', distanceMm: number, feedMmMin?: number): Promise<void>
    /** `epoch` is the bed epoch read with the list, so a click never skips in a later print. */
    skipObject(printerId: string, id: string, epoch: number): Promise<void>
    startFile(printerId: string, path: string, o?: { opts?: StartOptions; bedClear?: boolean; unverifiedOk?: boolean }): Promise<unknown>
  }
  bed: { state(printerId: string): Promise<{ askOnPrint: boolean; epoch?: number }> }
}

/** The printer host as a hub with the device page methods, or null (a demo or cloud host). */
export function deviceHub(host: Host): DeviceHub | null {
  const p = host.printers as Partial<DeviceHub> | undefined
  return p?.device && typeof p.device.jog === 'function' && p.bed ? (p as DeviceHub) : null
}

/** The hub's note on a paused print whose printer keeps its heaters on, or null when there is none to show. */
export function pauseNoteOf(status: Pick<PrinterStatus, 'state' | 'pauseNote'>): string | null {
  return status.state === 'paused' && status.pauseNote?.trim() ? status.pauseNote.trim() : null
}

/** The jog steps the hub allows (0.1 to 10 mm either way). */
export const JOG_STEPS_MM = [0.1, 1, 10] as const
export type JogStep = (typeof JOG_STEPS_MM)[number]

/** Why the head cannot be moved by hand now, or null when it can. Mirrors the hub: idle or finished only. */
export function jogBlockedReason(state: PrinterState): string | null {
  if (state === 'idle' || state === 'finished') return null
  if (state === 'offline') return 'The printer is not reachable.'
  if (state === 'error') return 'The printer reports an error. Clear it on the printer first.'
  return 'The head only moves by hand while the printer is idle.'
}

/** Why a file cannot be started now, or null. */
export function startBlockedReason(state: PrinterState): string | null {
  if (state === 'idle' || state === 'finished') return null
  return state === 'offline' ? 'The printer is not reachable.' : 'The printer is busy.'
}

/** What a hub refusal means to the person, or the hub's own message. */
export function deviceError(e: unknown): string {
  const code = (e as { code?: string } | null)?.code
  const message = e instanceof Error ? e.message : 'The printer did not answer.'
  // A print sent some other way to a printer that cannot list its objects: the hub says so.
  if (code === 'not_supported' && /printer's screen/.test(message)) return sentence(message)
  if (code === 'forbidden' || code === 'not_supported') return `This is only available from the ${appName()} app on your own network.`
  if (code === 'job_changed') return 'Another print started since this list was loaded. Look at the objects again.'
  return message
}

const sentence = (m: string) => `${m.charAt(0).toUpperCase()}${m.slice(1)}${/[.!?]$/.test(m) ? '' : '.'}`

export { plateObjectsFromGcode, type PlateObject } from '@slicerx/threemf/gcode-objects'

/** Issues the printer has now, and ones left over from an earlier job, each in the order the hub sent. */
export function splitIssues(rows: readonly PrinterIssue[]): { now: PrinterIssue[]; earlier: PrinterIssue[] } {
  return { now: rows.filter((i) => !i.stale), earlier: rows.filter((i) => i.stale) }
}

/**
 * How the card shows the printer's message. A message is a live problem only while a job runs, is paused,
 * is being prepared or failed; on a finished or idle printer it is history from the last job and reads muted,
 * as Bambu Studio keeps leftover HMS codes off its task panel.
 */
export function messageTone(state: PrinterState): 'warn' | 'muted' {
  return state === 'printing' || state === 'paused' || state === 'preparing' || state === 'error' ? 'warn' : 'muted'
}

export const SEVERITY_LABEL: Record<PrinterIssue['severity'], string> = { fatal: 'Fatal', serious: 'Serious', common: 'Needs attention', info: 'Notice' }

/** "3 h 5 min" or "42 s", for a finished print's length. */
export function recordDuration(s: number | undefined): string {
  if (s === undefined || !Number.isFinite(s)) return ''
  const t = Math.round(s)
  if (t < 60) return `${t} s`
  const m = Math.round(t / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

/** Filament length in meters, as the printer reports millimeters. */
export function filamentText(mm: number | undefined): string {
  return mm === undefined ? '' : `${(mm / 1000).toFixed(1)} m of filament`
}

export type StartAnswer = { kind: 'started' } | { kind: 'ask-bed' } | { kind: 'ask-unverified' } | { kind: 'error'; message: string }

/**
 * Starts a file already on the printer. The first call sends what has been confirmed so far; the hub's
 * refusal says which question is still open (`bed_check`, `unverified_file`), and the caller asks it and
 * calls again with the answer. Nothing starts without both.
 */
export async function startStored(
  hub: DeviceHub,
  printerId: string,
  path: string,
  confirmed: { bedClear: boolean; unverifiedOk: boolean },
  opts?: StartOptions,
): Promise<StartAnswer> {
  try {
    await hub.device.startFile(printerId, path, { ...(opts ? { opts } : {}), ...(confirmed.bedClear ? { bedClear: true } : {}), ...(confirmed.unverifiedOk ? { unverifiedOk: true } : {}) })
    return { kind: 'started' }
  } catch (e) {
    const code = (e as { code?: string } | null)?.code
    if (code === 'bed_check') return { kind: 'ask-bed' }
    if (code === 'unverified_file') return { kind: 'ask-unverified' }
    return { kind: 'error', message: deviceError(e) }
  }
}

/** The bed rule of the Print sheet: ask unless the hub knows the plate is clear. */
export async function bedKnownClear(hub: DeviceHub, printerId: string): Promise<boolean> {
  try {
    return !(await hub.bed.state(printerId)).askOnPrint
  } catch {
    return false
  }
}
