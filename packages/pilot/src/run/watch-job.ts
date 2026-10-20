// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The watch on a print the chat started: one listener on that printer for that job. Status events move the job's state,
// layer, time left and progress. The job ends on job_finished, on an error event, or on a status of finished, error or
// idle once it printed, whichever comes first: that posts one line and releases the listener, so a printer that reports
// the end twice still gets one line. A flag from the print watch posts one line per job, and so does a pause the printer
// gives a reason for (a filament runout): the job stays watched, since it may resume. Closing the window releases it.
// The printers are read again at each subscribe: a dropped link lets go with no line, keeps the job as it stood and
// tries again every few seconds on the printers there are then, and a new printers object (the link came back) moves
// the listener to it. An error with a link code (a closed connection, or a subscribe that failed: unreachable, timeout,
// locked) is a link drop: only an error the printer itself reports is a failure. A watch that cannot listen for two minutes says once that it lost touch with the printer.
import type { PrinterEvent, PrinterHost, PrinterState, PrinterStatus, RunJob } from '@slicerx/contracts'

/** What a status event or the job's end changes on the run's job. */
export type RunJobPatch = Partial<Omit<RunJob, 'printerId' | 'fileName' | 'startedAt'>>

export interface JobWatchEvents {
  update(j: RunJobPatch): void
  note(text: string, tone: 'ok' | 'warn' | 'bad'): void
  /** The watch let go without an end: the printer stopped reporting. The job stays as it stood. */
  gaveUp?(): void
}

export interface JobWatchOptions {
  now?: () => number
  /** How often a watch without a listener tries again, and looks for new printers. */
  retryMs?: number
  /** How long a watch goes without a listener before it gives up. */
  giveUpMs?: number
}

/**
 * Error codes a printer host or the link gives when the connection, not the print, failed: a closed link, and a
 * subscribe that could not reach the printer or was turned away.
 */
const LINK_CODES: ReadonlySet<string> = new Set(['closed', 'unreachable', 'timeout', 'locked', 'auth', 'tls', 'unauthorized', 'forbidden', 'hub_identity', 'bad_request', 'protocol', 'credential_missing'])

/** States that mean the job is on the printer. A finished or idle status counts as the end only after one. */
const ON_PRINTER: ReadonlySet<PrinterState> = new Set(['preparing', 'printing', 'paused'])

/** The message without its last stop, so the line ends with one. */
const clause = (m: string): string => m.trim().replace(/[.!\s]+$/, '')

/** One subscribe on one printers object; dead once released or its connection closed. */
interface Link {
  host: PrinterHost | undefined
  off: (() => void) | null
  dead: boolean
  /** The printer reported something on this listener, so the subscribe worked. */
  heard: boolean
}

/**
 * Watches `job` on its printer and reports through `on` until the job ends. `printers` is the host, or a getter read at
 * each subscribe. Returns the release, which stops the watch without a line; it does nothing once the job ended.
 */
export function watchJob(printers: PrinterHost | (() => PrinterHost | undefined), job: RunJob, on: JobWatchEvents, opts: JobWatchOptions = {}): () => void {
  const now = opts.now ?? Date.now
  const retryMs = opts.retryMs ?? 5_000
  const misses = Math.max(1, Math.ceil((opts.giveUpMs ?? 120_000) / retryMs))
  const current = typeof printers === 'function' ? printers : () => printers
  let over = false
  let printed = ON_PRINTER.has(job.state)
  let flagged = job.attention === true
  // a pause with a reason is said once per job
  let pauseSaid = false
  let layers = job.layerCount
  let link: Link | null = null
  // tries in a row without a listener; anything the printer reports starts the count again
  let missed = 0
  let timer: ReturnType<typeof setInterval> | null = null
  // the printer's name for the lines, from the printers that last listened: one the host does not list is "the printer"
  let name: Promise<string> = Promise.resolve('the printer')
  const lookUp = (host: PrinterHost | undefined): void => {
    const was = name
    name = Promise.resolve()
      .then(() => host!.list())
      .then((list) => list.find((p) => p.id === job.printerId)?.name || was)
      .catch(() => was)
  }
  const say = (line: (n: string) => string, tone: 'ok' | 'warn' | 'bad'): void => {
    void name.then((n) => on.note(line(n), tone))
  }

  const g = globalThis as { addEventListener?: (t: string, fn: () => void) => void; removeEventListener?: (t: string, fn: () => void) => void }
  const drop = (l: Link): void => {
    if (l.dead) return
    l.dead = true
    if (link === l) link = null
    l.off?.()
  }
  const release = (): void => {
    if (over) return
    over = true
    g.removeEventListener?.('pagehide', release)
    if (timer !== null) clearInterval(timer)
    if (link) drop(link)
  }

  const end = (outcome: 'finished' | 'failed' | 'canceled', state: PrinterState, message?: string): void => {
    if (over) return
    release()
    on.update({ state, outcome, endedAt: new Date(now()).toISOString(), ...(outcome === 'finished' ? { progress: 100, timeLeftS: 0, ...(layers !== undefined ? { layer: layers } : {}) } : {}) })
    if (outcome === 'finished') say((n) => `${job.fileName} finished on ${n}.`, 'ok')
    else if (outcome === 'canceled') say((n) => `${job.fileName} was canceled on ${n}.`, 'warn')
    else say((n) => `${job.fileName} stopped on ${n}: ${clause(message || 'the printer reported an error')}.`, 'bad')
  }

  const giveUp = (): void => {
    if (over) return
    release()
    on.gaveUp?.()
    say((n) => `Lost touch with ${n} during ${job.fileName}. Check the printer to see how the print went.`, 'warn')
  }

  const onStatus = (s: PrinterStatus): void => {
    if (s.state === 'finished' && printed) return end('finished', 'finished')
    // an error ends the job even straight from idle: the start went through, and the printer says it stopped
    if (s.state === 'error') return end('failed', 'error', s.message)
    if (s.state === 'idle' && printed) return end('canceled', 'idle')
    if (ON_PRINTER.has(s.state)) printed = true
    const patch: RunJobPatch = { state: s.state }
    if (s.layer !== undefined) patch.layer = s.layer
    if (s.layerCount !== undefined) patch.layerCount = layers = s.layerCount
    if (s.timeLeftS !== undefined) patch.timeLeftS = s.timeLeftS
    // the printer says 0 to 1; the run's job keeps a percent
    if (s.progress !== undefined) patch.progress = Math.round(Math.min(1, Math.max(0, s.progress)) * 100)
    const flag = s.watch === 'attention' && !flagged
    if (flag) {
      flagged = true
      patch.attention = true
    }
    on.update(patch)
    if (flag) say((n) => `Print watch flagged something on ${n}. Take a look at the camera.`, 'warn')
    const reason = s.state === 'paused' && s.message ? clause(s.message) : ''
    if (reason && !pauseSaid) {
      pauseSaid = true
      say((n) => `${n} paused: ${reason}.`, 'warn')
    }
  }

  const onEvent = (e: PrinterEvent, l: Link): void => {
    if (over || l.dead) return
    // the link going away or a subscribe that failed is not the print failing: let go, keep the job and try again
    if (e.type === 'error' && LINK_CODES.has(e.code)) return drop(l)
    l.heard = true
    if (e.type === 'status') {
      if (e.status.printerId !== job.printerId) return
      missed = 0
      onStatus(e.status)
    } else if (e.printerId !== job.printerId) return
    else if (e.type === 'job_finished') end(e.ok ? 'finished' : 'canceled', e.ok ? 'finished' : 'idle')
    else if (e.type === 'error') end('failed', 'error', e.message)
  }

  /** Listens through the printers there are now; a host that cannot listen (or fails to) leaves no listener. */
  const attach = (): void => {
    const host = current()
    const l: Link = { host, off: null, dead: false, heard: false }
    link = l
    let off: () => void
    try {
      if (!host || typeof host.subscribe !== 'function') throw new Error('no printers to listen to')
      off = host.subscribe(job.printerId, (e) => onEvent(e, l))
    } catch {
      drop(l)
      return
    }
    // a host that reports at once may end the job, or close, before subscribe returns
    if (over || l.dead) return off()
    l.off = off
    lookUp(host)
  }

  /** Every few seconds: follow new printers, or try again without a listener, and give up after a while. */
  const tick = (): void => {
    if (over) return
    if (link) {
      // a listener the printer reported on is a working link; one still waiting for its subscribe may yet fail
      if (current() === link.host) {
        if (link.heard) missed = 0
        return
      }
      drop(link)
    } else if (++missed >= misses) return giveUp()
    attach()
  }

  attach()
  if (!over) {
    g.addEventListener?.('pagehide', release)
    timer = setInterval(tick, retryMs)
    ;(timer as { unref?: () => void }).unref?.()
  }
  return release
}
