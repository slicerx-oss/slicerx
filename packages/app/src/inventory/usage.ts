// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Filament use from a finished print. When a plate starts on a printer, what it will use per linked spool
// is remembered. When the hub's alert for that printer says the job finished, the person gets the usual
// approval card to subtract it in Spoolman. A job that failed or was canceled is forgotten: how much went
// through is not known, and guessing would put wrong numbers in the inventory.
import type { Host } from '@slicerx/contracts'
import { get } from '../state/store'
import { spoolFor, spoolLabel, type Spool } from './spools'

export interface SpoolUse {
  spoolId: number
  label: string
  grams: number
}

export interface PendingUse {
  printerId: string
  /** The file name the plate went to the printer under. */
  jobName: string
  uses: SpoolUse[]
  at: number
}

const KEY = 'sx.spool-pending'
/** A plate that was never reported finished is forgotten after a week. */
export const PENDING_MAX_AGE_MS = 7 * 24 * 3600 * 1000

function read(): PendingUse[] {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? (raw as PendingUse[]).filter((p) => p && typeof p.printerId === 'string' && typeof p.jobName === 'string' && Array.isArray(p.uses)) : []
  } catch {
    return []
  }
}

function write(list: PendingUse[]): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(list))
  } catch {
    // Storage can be blocked; the person can still use Record use by hand.
  }
}

/** `Harbor lantern.gcode`, `harbor lantern` and `Harbor lantern.gcode.3mf` are one job. */
export function jobKey(name: string): string {
  return name.replace(/\.(gcode(\.3mf)?|bgcode|3mf)$/i, '').trim().toLowerCase()
}

/** What each linked spool is about to lose, from the plate's grams per slot (first slot first). */
export function usesFor(filamentG: readonly number[], spools: readonly Spool[], links: Readonly<Record<number, number>>, printerSpoolIds: readonly (number | undefined)[] = []): SpoolUse[] {
  const out: SpoolUse[] = []
  filamentG.forEach((g, i) => {
    const sp = spoolFor(i + 1, spools, links, printerSpoolIds[i])
    if (sp && g > 0) out.push({ spoolId: sp.id, label: spoolLabel(sp), grams: Math.round(g * 10) / 10 })
  })
  return out
}

/** Remembers a started plate. Nothing is kept when no spool is linked. */
export function rememberUse(p: Omit<PendingUse, 'at'>, now = Date.now()): void {
  if (p.uses.length === 0) return
  const keep = read().filter((x) => now - x.at < PENDING_MAX_AGE_MS && !(x.printerId === p.printerId))
  write([...keep, { ...p, at: now }])
}

export function pendingUses(): PendingUse[] {
  return read()
}

/** Takes the remembered plate for a printer's finished job off the list and returns it. */
export function takePending(printerId: string, jobName: string | undefined, now = Date.now()): PendingUse | null {
  const list = read().filter((x) => now - x.at < PENDING_MAX_AGE_MS)
  const i = list.findIndex((x) => x.printerId === printerId && (!jobName || jobKey(x.jobName) === jobKey(jobName)))
  if (i < 0) {
    write(list)
    return null
  }
  const [hit] = list.splice(i, 1)
  write(list)
  return hit ?? null
}

/** Forgets a printer's remembered plate (it failed or was canceled). */
export function forgetPending(printerId: string): void {
  write(read().filter((x) => x.printerId !== printerId))
}

interface AlertHub {
  onAlert(cb: (a: { printerId: string; kind: string; jobName?: string }) => void): () => void
}

/** Subscribes to the hub's alerts. `record` is the approval-gated subtraction (recordSpoolUse). */
export function watchFinishedPrints(host: Host, record: (host: Host, uses: SpoolUse[]) => Promise<void>): () => void {
  const hub = host.printers as Partial<AlertHub> | undefined
  if (!hub || typeof hub.onAlert !== 'function') return () => undefined
  return hub.onAlert((a) => {
    if (a.kind === 'finished') {
      const hit = takePending(a.printerId, a.jobName)
      if (hit && get().spoolLinks !== undefined) void record(host, hit.uses)
    } else if (a.kind === 'failed' || a.kind === 'canceled') {
      forgetPending(a.printerId)
    }
  })
}
