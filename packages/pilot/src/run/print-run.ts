// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print run record: one per chat, shared by mimir's tools and the cards. It holds the part, the plate, the printer
// and slots, the last slice, the send and the job. Whether the slice is stale is worked out on every read, so a plate
// edit, a printer change or a slot change after slicing is never missed. A job recorded with a watch host is watched
// on its printer until it ends (watch-job.ts).
import type { FilamentSlot, PilotEvent, PrinterHost, PrintRun, RunJob, RunSend, RunStepName } from '@slicerx/contracts'
import type { ToolGroups } from '../surfaces'
import { watchJob, type RunJobPatch } from './watch-job'

/** What the host gives the run book. */
export interface PrintRunHost {
  /**
   * A fingerprint of plate `plate` (1 based; the active plate when left out) as it is now: its objects, settings and
   * filaments. A slice keeps the one it was made from.
   */
  fingerprint(plate?: number): string
  /**
   * Points the app's plate at the printer and slots the chat picked. `printerSlots` is what that printer last reported
   * in its slots, so the host can place the filaments before its own status for the printer arrives. A new printer's
   * bed can be another size or have excluded areas, so parts that no longer stand on it are landed again; the host
   * says which moved and which found no room.
   */
  setTarget?(t: RunTarget): Promise<RunLanded | void>
  /**
   * The printers a started print is watched through, as they are now. The watch reads them at each subscribe, so a
   * printer connection that came back is followed without a new runtime. Without it the watch host's printers are used.
   */
  printers?(): PrinterHost | undefined
}

/** The printer and slots a chat picked. Slot keys are 1 based filament numbers; values are the printer's slot ids. */
export interface RunTarget {
  printerId: string
  slots: Record<number, string>
  printerSlots?: FilamentSlot[]
  /** The printer's make and model, so the host can load its bed before landing the parts on it. */
  model?: { vendor: string; model: string }
}

/** The parts a new printer's bed made the host move, and the ones with no room on it, which stay put. */
export interface RunLanded {
  moved: LandedPart[]
  offBed: LandedPart[]
  /** More than one plate exists, so the reply names each part's plate. */
  manyPlates?: boolean
  /** The new printer's bed did not load in time, so no part was checked against it. */
  bedNotReady?: boolean
  /** The new printer's profile did not build, so the bed is the generic one. */
  genericBed?: boolean
}

/** A part by name, and the plate it is on. */
export interface LandedPart {
  name: string
  plate: string
}

/**
 * What a tool may change with `update`: the part, the plate, the printer and slots, and the slice. The send and the job
 * have their own calls. Keys outside these, and keys set to undefined, are ignored.
 */
/**
 * Where a recorded job is watched from: the printers, and the chat's session log, which gets how the job ended (the
 * ended run and its line) and a print watch flag, whether or not anyone has the chat open.
 */
export interface RunWatchHost {
  printers: PrinterHost
  log?(sessionId: string, e: PilotEvent): void
}

export type RunPatch = Partial<Pick<PrintRun, 'designId' | 'plate' | 'printerId' | 'slots' | 'slice'>>

const PATCH_KEYS = ['designId', 'plate', 'printerId', 'slots', 'slice'] as const

/**
 * A built-in tool's handle on its chat's run. Plugin tools never get one.
 *
 * The run is a shared record for cards and tools, not an authority. Safety checks must never trust `run.send`,
 * `run.job` or a slice's freshness to allow a send or a start: the send card ledger and the guard's preflight are the
 * gate. A stale slice may make a tool refuse early, but a fresh one never lets anything through on its own.
 */
export interface RunHandle {
  get(): PrintRun
  update(patch: RunPatch): PrintRun
  /** Records the file sent to a printer, or clears it with null. */
  recordSend(send: RunSend | null): PrintRun
  /** Records the print started from the send, or clears it with null. */
  recordJob(job: RunJob | null): PrintRun
  /** Plate `plate`'s fingerprint as it is now, for a slice to keep: read it before slicing, so an edit during the slice shows. */
  fingerprint(plate?: number): string
  /** Points the host's plate at the printer and slots picked; does nothing on a host without plates. */
  setTarget?(t: RunTarget): Promise<RunLanded | void>
}

export interface RunBook {
  /** The chat's run; an empty one for a chat that has none yet. */
  get(sessionId: string): PrintRun
  update(sessionId: string, patch: RunPatch): PrintRun
  recordSend(sessionId: string, send: RunSend | null): PrintRun
  recordJob(sessionId: string, job: RunJob | null): PrintRun
  /** The host's fingerprint of plate `plate` (the active plate when left out) as it is now. */
  fingerprint(plate?: number): string
  /** Hands the printer and slots a chat picked to the host, and says which parts its bed made it move. */
  setTarget(t: RunTarget): Promise<RunLanded | void>
  /** Calls `fn` with the run after every change to it. Returns the unsubscribe. */
  subscribe(sessionId: string, fn: (run: PrintRun) => void): () => void
  /**
   * Calls `fn` with what the job watch reports for the chat: `print_run` as the job moves and ends, `run_note` for its
   * end line or a flag. Returns the unsubscribe; letting go never stops the watch itself.
   */
  watch(sessionId: string, fn: (e: PilotEvent) => void): () => void
  /**
   * Drops the chat's run from view, with its subscribers and listeners. A job still printing keeps its watch until it
   * ends, and how it ended still goes to the chat's session log.
   */
  forget(sessionId: string): void
  /**
   * Hands the book a newer watch host (a runtime made again): its log, and its printers where the book's host gives
   * none. A job still running moves to printers that changed; the same printers again change nothing.
   */
  setWatcher(watcher: RunWatchHost): void
}

/** A handle on one chat's run in `book`. */
export function runHandle(book: RunBook, sessionId: string): RunHandle {
  return {
    get: () => book.get(sessionId),
    update: (patch) => book.update(sessionId, patch),
    recordSend: (send) => book.recordSend(sessionId, send),
    recordJob: (job) => book.recordJob(sessionId, job),
    fingerprint: (plate) => book.fingerprint(plate),
    setTarget: (t) => book.setTarget(t),
  }
}

interface Entry {
  run: PrintRun
  /** The printer and slots the slice was made for, to tell when they changed after it. */
  slicedFor: { printerId: string | null; slots: string } | null
}

const slotsKey = (slots: Record<number, string>): string =>
  JSON.stringify(
    Object.entries(slots)
      .map(([k, v]) => [Number(k), v] as const)
      .sort((a, b) => a[0] - b[0]),
  )

export function emptyRun(sessionId: string, at: string): PrintRun {
  return { sessionId, designId: null, plate: 1, printerId: null, slots: {}, slice: null, send: null, job: null, updatedAt: at }
}

/** Adds `fn` to the set kept under `key`; the returned call takes it out again. */
function addTo<T>(map: Map<string, Set<T>>, key: string, fn: T): () => void {
  let set = map.get(key)
  if (!set) map.set(key, (set = new Set()))
  set.add(fn)
  return () => {
    set.delete(fn)
    if (set.size === 0 && map.get(key) === set) map.delete(key)
  }
}

/** Calls each of `fns` with `v`; one that throws never stops the others or the change that called them. */
function callEach<T>(fns: Iterable<(v: T) => void> | undefined, v: T): void {
  for (const fn of [...(fns ?? [])]) {
    try {
      fn(v)
    } catch {
      // ignored
    }
  }
}

export function createRunBook(host: PrintRunHost, now: () => number, firstWatcher?: RunWatchHost): RunBook {
  let watcher = firstWatcher
  const entries = new Map<string, Entry>()
  const subs = new Map<string, Set<(run: PrintRun) => void>>()
  const listeners = new Map<string, Set<(e: PilotEvent) => void>>()
  // the one job each chat watches: its start time and the release
  const watches = new Map<string, { startedAt: string; printerId: string; stop: () => void }>()
  // the runs of chats that are over, kept only while their job's watch runs, so the end still reaches the log
  const gone = new Map<string, Entry>()
  // the printers to watch through, read at each subscribe
  const printers = (): PrinterHost | undefined => host.printers?.() ?? watcher?.printers
  const iso = (): string => new Date(now()).toISOString()

  function read(e: Entry): PrintRun {
    const run = e.run
    const out: PrintRun = { ...run, slots: { ...run.slots } }
    if (run.slice) {
      const moved = e.slicedFor !== null && (e.slicedFor.printerId !== run.printerId || e.slicedFor.slots !== slotsKey(run.slots))
      // the slice's own plate, so showing another plate never makes it stale
      const stale = run.slice.fingerprint !== host.fingerprint(run.slice.plate) || run.plate !== run.slice.plate || moved
      out.slice = { ...run.slice, warnings: [...run.slice.warnings], stale }
    }
    return out
  }

  function write(sessionId: string, fields: Partial<PrintRun>, sliced: boolean): PrintRun {
    const prev = entries.get(sessionId)
    const run: PrintRun = { ...(prev?.run ?? emptyRun(sessionId, iso())), ...fields, sessionId, updatedAt: iso() }
    const e: Entry = { run, slicedFor: prev?.slicedFor ?? null }
    if (sliced) e.slicedFor = run.slice ? { printerId: run.printerId, slots: slotsKey(run.slots) } : null
    entries.set(sessionId, e)
    const out = read(e)
    callEach(subs.get(sessionId), out)
    return out
  }

  /** What the watch reports: to the chat's listeners, and to the session log when `logged`. */
  function report(sessionId: string, ev: PilotEvent, logged: boolean): void {
    if (logged) watcher?.log?.(sessionId, ev)
    callEach(listeners.get(sessionId), ev)
  }

  function unwatch(sessionId: string): void {
    const w = watches.get(sessionId)
    if (!w) return
    watches.delete(sessionId)
    w.stop()
  }

  /** Starts the watch for a job just recorded, stopping the chat's last one; a job that ended or no job stops it. */
  function syncWatch(sessionId: string, job: RunJob | null): void {
    if (!watcher) return
    const w = watches.get(sessionId)
    if (job && !job.outcome && w && w.startedAt === job.startedAt && w.printerId === job.printerId) return
    unwatch(sessionId)
    gone.delete(sessionId)
    if (job && !job.outcome) startWatch(sessionId, job)
  }

  /** Watches the chat's running `job` through the printers there are at each subscribe. */
  function startWatch(sessionId: string, job: RunJob): void {
    const mine = (): boolean => watches.get(sessionId)?.startedAt === job.startedAt
    const isJob = (e: Entry | undefined): e is Entry => e?.run.job?.startedAt === job.startedAt && e.run.job.printerId === job.printerId
    // the chat's run, or the one kept for a chat that is over
    const entryOf = (): Entry | undefined => [entries.get(sessionId), gone.get(sessionId)].find(isJob)
    // the watch is over: a chat that is over lets go of its run
    const over = (): void => {
      if (mine()) watches.delete(sessionId)
      if (isJob(gone.get(sessionId))) gone.delete(sessionId)
    }
    // the watch changes this job only, and quietly: a run going is not told, the chat's listeners are
    const update = (patch: RunJobPatch): void => {
      const e = entryOf()
      if (!e) return
      e.run = { ...e.run, job: { ...e.run.job!, ...patch }, updatedAt: iso() }
      // a tick of progress is for the screen; how the job ended and a flag go to the log too
      report(sessionId, { type: 'print_run', run: read(e) }, patch.outcome !== undefined || patch.attention === true)
      if (patch.outcome !== undefined) over()
    }
    const note = (text: string, tone: 'ok' | 'warn' | 'bad'): void => report(sessionId, { type: 'run_note', text, tone }, true)
    // the printer stopped reporting: the job stays as it stood, and the watch is over
    const gaveUp = (): void => over()
    const entry = { startedAt: job.startedAt, printerId: job.printerId, stop: () => undefined as void }
    watches.set(sessionId, entry)
    entry.stop = watchJob(printers, job, { update, note, gaveUp }, { now })
  }

  return {
    fingerprint: (plate) => host.fingerprint(plate),
    get(sessionId) {
      const e = entries.get(sessionId)
      return e ? read(e) : emptyRun(sessionId, iso())
    },
    update(sessionId, patch) {
      const fields: Partial<PrintRun> = {}
      for (const k of PATCH_KEYS) {
        if (!Object.hasOwn(patch, k) || patch[k] === undefined) continue
        ;(fields as Record<string, unknown>)[k] = patch[k]
      }
      return write(sessionId, fields, 'slice' in fields)
    },
    recordSend(sessionId, send) {
      return write(sessionId, { send }, false)
    },
    recordJob(sessionId, job) {
      const out = write(sessionId, { job }, false)
      syncWatch(sessionId, job)
      return out
    },
    async setTarget(t) {
      return host.setTarget?.(t)
    },
    subscribe(sessionId, fn) {
      return addTo(subs, sessionId, fn)
    },
    watch(sessionId, fn) {
      return addTo(listeners, sessionId, fn)
    },
    forget(sessionId) {
      const e = entries.get(sessionId)
      const w = watches.get(sessionId)
      // a job still printing is watched to its end; anything else of the chat goes now
      if (e && w && e.run.job && !e.run.job.outcome && e.run.job.startedAt === w.startedAt) gone.set(sessionId, e)
      else unwatch(sessionId)
      entries.delete(sessionId)
      subs.delete(sessionId)
      listeners.delete(sessionId)
    },
    setWatcher(next) {
      const before = printers()
      watcher = next
      if (printers() === before) return
      // each running job moves to the new printers as it stands now, so a print that ended meanwhile ends on the first
      // status they report
      for (const sessionId of [...watches.keys()]) {
        const w = watches.get(sessionId)
        const job = [entries.get(sessionId), gone.get(sessionId)].map((e) => e?.run.job).find((j) => j?.startedAt === w?.startedAt)
        unwatch(sessionId)
        if (job && !job.outcome) startWatch(sessionId, job)
      }
    },
  }
}

const books = new WeakMap<PrintRunHost, RunBook>()

/**
 * The run book for `host`, made on first use: one per host. A host's runtime made again (a setup change, the app's
 * commands changing as a print starts) keeps every chat's run and the watch on its started job, so the end line still
 * reaches the chat on screen. The first runtime's clock stays with the book; the newest runtime's watch host wins.
 */
export function runBookFor(host: PrintRunHost, now: () => number, watcher?: RunWatchHost): RunBook {
  let book = books.get(host)
  if (!book) books.set(host, (book = createRunBook(host, now, watcher)))
  else if (watcher) book.setWatcher(watcher)
  return book
}

export const RUN_STEPS: readonly RunStepName[] = ['design', 'plate', 'target', 'slice', 'send', 'print']

/**
 * Where a run stands, step by step: done, the one to do now, still to do, or off (the edition switched its tools off).
 * Something sliced, sent or printing means a part is on the plate, so design and plate count as done.
 */
export function runSteps(run: PrintRun, groups: ToolGroups = {}): { name: RunStepName; state: 'done' | 'now' | 'todo' | 'off' }[] {
  // loose checks: a run read back from a log may lack a key
  const hasPart = run.designId != null || run.slice != null || run.send != null || run.job != null
  const done: Record<RunStepName, boolean> = {
    design: hasPart,
    plate: hasPart,
    target: run.printerId != null,
    slice: run.slice != null && !run.slice.stale,
    send: run.send != null,
    print: run.job?.outcome === 'finished',
  }
  const off: Record<RunStepName, boolean> = {
    design: groups.design === false,
    plate: false,
    target: groups.printers === false,
    slice: groups.slicing === false,
    send: groups.printers === false,
    print: groups.printers === false,
  }
  let nowGiven = false
  return RUN_STEPS.map((name) => {
    if (off[name]) return { name, state: 'off' as const }
    if (done[name]) return { name, state: 'done' as const }
    if (nowGiven) return { name, state: 'todo' as const }
    nowGiven = true
    return { name, state: 'now' as const }
  })
}
