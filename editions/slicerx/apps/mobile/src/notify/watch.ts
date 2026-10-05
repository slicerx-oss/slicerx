// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Turns printer events into alerts: a print finished, a print failed or was
// stopped, or a printer needs attention (paused with a message, or an error).
// Printer messages are untrusted text; they are shown, never acted on.
import type { PrinterEvent, PrinterHost, PrinterInfo, PrinterState, PrinterStatus } from '@slicerx/contracts'
import type { Alert, AlertKind } from '../state/store'

export interface WatchOptions {
  onAlert: (a: Alert) => void
  now?: () => number
}

const MAX_TEXT = 160

function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > MAX_TEXT ? `${one.slice(0, MAX_TEXT - 3)}...` : one
}

/** One alert per printer, kind and job within this window, so a status stream does not repeat itself. */
const REPEAT_MS = 10 * 60_000

export function createAlertTracker(printers: PrinterInfo[], opts: WatchOptions) {
  const now = opts.now ?? (() => Date.now())
  const names = new Map(printers.map((p) => [p.id, p.name]))
  const last = new Map<string, PrinterState>()
  const jobs = new Map<string, string>()
  const recent = new Map<string, number>()
  let seq = 0

  function raise(kind: AlertKind, printerId: string, title: string, detail: string, job = ''): void {
    const key = `${printerId}|${kind}|${job}`
    const t = now()
    const prev = recent.get(key)
    if (prev !== undefined && t - prev < REPEAT_MS) return
    recent.set(key, t)
    opts.onAlert({ id: `al-${t.toString(36)}-${++seq}`, kind, printerId, printerName: names.get(printerId) ?? printerId, title: clip(title), detail: clip(detail), at: t, read: false })
  }

  function onStatus(s: PrinterStatus): void {
    const name = names.get(s.printerId) ?? s.printerId
    const was = last.get(s.printerId)
    last.set(s.printerId, s.state)
    if (s.jobName) jobs.set(s.printerId, s.jobName)
    if (was === s.state) return
    const job = s.jobName ?? jobs.get(s.printerId) ?? ''
    if (s.state === 'paused') raise('attention', s.printerId, `${name} is paused`, s.message ?? (job ? `${job} is waiting for you` : 'The print is waiting for you'), job)
    else if (s.state === 'error') raise('failed', s.printerId, `${name} reported an error`, s.message ?? 'Check the printer before the next job', job)
    else if (s.state === 'finished') raise('finished', s.printerId, `${job || 'Print'} finished`, `${name} is done. Clear the bed before the next job.`, job)
    else if (s.state === 'offline' && was !== undefined) raise('attention', s.printerId, `${name} went offline`, 'Lost contact with the printer', '')
  }

  function onEvent(e: PrinterEvent): void {
    if (e.type === 'status') onStatus(e.status)
    else if (e.type === 'job_finished') {
      const name = names.get(e.printerId) ?? e.printerId
      if (e.ok) raise('finished', e.printerId, `${e.jobName} finished`, `${name} is done. Clear the bed before the next job.`, e.jobName)
      else raise('failed', e.printerId, `${e.jobName} did not finish`, `${name} stopped the job before the end`, e.jobName)
    } else raise('failed', e.printerId, `${names.get(e.printerId) ?? e.printerId}: ${e.code}`, e.message, e.code)
  }

  return { onStatus, onEvent }
}

/** Subscribes to every printer. Returns the unsubscribe function. */
export async function watchPrinters(host: PrinterHost, opts: WatchOptions): Promise<() => void> {
  const printers = await host.list()
  const tracker = createAlertTracker(printers, opts)
  const initial = await Promise.all(printers.map((p) => host.status(p.id).catch(() => null)))
  for (const s of initial) if (s) tracker.onStatus(s)
  const offs = printers.map((p) => host.subscribe(p.id, tracker.onEvent))
  return () => {
    for (const off of offs) off()
  }
}
