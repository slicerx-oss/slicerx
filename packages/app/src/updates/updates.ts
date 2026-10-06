// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// In-app updates, for a desktop shell that registers an updater (apps/desktop/src/host/updater.ts). It checks at
// launch and once a day, downloads a newer version in the background, then asks: Restart to update, or Later. It
// never restarts on its own, and holds the restart while a print is being sent or a job is starting. A Linux
// package install only says the new version is out and links to it. Help, Check for updates asks at once.
import { useSyncExternalStore } from 'react'
import { held, holdUpdates, onHoldChange, registerUpdater, resetHolds, updater, updaterRegistered } from './hold'

export { holdUpdates, registerUpdater, updaterRegistered }

export interface FoundUpdate {
  version: string
  /** The release's highlights, one per line (latest.json `notes`). */
  notes: string
  date?: string | null
  /** The full release notes. */
  releaseUrl?: string | null
  /** Where a package install downloads the new version. */
  downloadUrl?: string | null
}

export interface UpdaterHost {
  /** install: downloads, installs and restarts itself. download: links to the new version instead. */
  mode: 'install' | 'download'
  check(): Promise<FoundUpdate | null>
  download(onProgress: (got: number, total: number | null) => void): Promise<void>
  /** Installs the downloaded update and restarts into it. */
  restart(): Promise<void>
}

export type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current' }
  | { kind: 'available'; update: FoundUpdate }
  | { kind: 'downloading'; update: FoundUpdate; got: number; total: number | null }
  | { kind: 'ready'; update: FoundUpdate }
  | { kind: 'installing'; update: FoundUpdate }
  | { kind: 'error'; message: string; update?: FoundUpdate }

export interface UpdateState {
  phase: UpdatePhase
  /** The dialog is showing. */
  open: boolean
}

/** At most this many highlights, each at most this long, in the dialog. publish.sh trims the same way. */
export const NOTE_LINES = 5
export const NOTE_CHARS = 100
/** How long after launch the first check waits, so it never competes with startup. */
export const FIRST_CHECK_MS = 15_000
export const DAY_MS = 24 * 60 * 60 * 1000
const TICK_MS = 60 * 60 * 1000

/** The highlights in latest.json's notes: list marks dropped, blank lines skipped, the first five, each kept short. */
export function noteLines(notes: string): string[] {
  return notes
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
    .filter((l) => l && !l.startsWith('#'))
    .slice(0, NOTE_LINES)
    .map((l) => shorten(l, NOTE_CHARS))
}

/** Cuts a line at a word boundary to at most `max` characters, with an ellipsis. */
export function shorten(line: string, max: number): string {
  if (line.length <= max) return line
  const cut = line.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`
}

let state: UpdateState = { phase: { kind: 'idle' }, open: false }
const listeners = new Set<() => void>()
let busyCheck: () => boolean = () => false
let quietCheck: () => boolean = () => false
let lastCheck = 0
let dismissedAt = 0
let timers: ReturnType<typeof setTimeout>[] = []

function put(next: Partial<UpdateState>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

export function updateMode(): UpdaterHost['mode'] | null {
  return updater()?.mode ?? null
}

export function getUpdateState(): UpdateState {
  return state
}

export function subscribeUpdates(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribeUpdates, getUpdateState, getUpdateState)
}

/** Whether the dialog is showing, without re-rendering on download progress. */
export function useUpdateOpen(): boolean {
  return useSyncExternalStore(subscribeUpdates, () => state.open, () => false)
}

// a send that starts or ends may open a ready update or free the restart
let unhold = onHoldChange(() => notifyBusy())

/** Whether a restart now would cut into a print being sent. */
export function updatesHeld(): boolean {
  return held() || busyCheck()
}

/**
 * What else holds the restart (`busy`) and what keeps the dialog from opening by itself (`quiet`: first run, the
 * agreement). Called again whenever either may have changed.
 */
export function watchBusy(busy: () => boolean, quiet: () => boolean = () => false): void {
  busyCheck = busy
  quietCheck = quiet
}

/** The app tells the updater that busy or quiet may have changed: a ready update the person has not seen opens now. */
export function notifyBusy(): void {
  maybeOpen()
  for (const l of listeners) l()
}

function maybeOpen(): void {
  if (state.open || updatesHeld() || quietCheck()) return
  const k = state.phase.kind
  const offer = k === 'ready' || (k === 'available' && updater()?.mode === 'download')
  if (offer && Date.now() - dismissedAt >= DAY_MS) put({ open: true })
}

async function download(update: FoundUpdate): Promise<void> {
  const host = updater()
  if (!host) return
  put({ phase: { kind: 'downloading', update, got: 0, total: null } })
  try {
    await host.download((got, total) => {
      if (state.phase.kind === 'downloading') put({ phase: { kind: 'downloading', update, got, total } })
    })
    put({ phase: { kind: 'ready', update } })
    maybeOpen()
  } catch (e) {
    put({ phase: { kind: 'error', message: reason(e), update } })
  }
}

function reason(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return m.trim() || 'Something went wrong.'
}

/**
 * Asks for a newer version. `manual` (Help, Check for updates) opens the dialog at once and shows every outcome,
 * the newest version and errors included; a scheduled check stays silent until an update is ready.
 */
export async function checkForUpdates(opts: { manual?: boolean } = {}): Promise<void> {
  const host = updater()
  if (!host) return
  const manual = opts.manual === true
  const k = state.phase.kind
  // a download in flight or one waiting for the restart is already the answer
  if (k === 'downloading' || k === 'ready' || k === 'installing' || k === 'checking') {
    if (manual) put({ open: true })
    else maybeOpen()
    return
  }
  lastCheck = Date.now()
  put({ phase: { kind: 'checking' }, ...(manual ? { open: true } : {}) })
  let found: FoundUpdate | null
  try {
    found = await host.check()
  } catch (e) {
    put({ phase: manual ? { kind: 'error', message: reason(e) } : { kind: 'idle' } })
    return
  }
  if (!found) {
    put({ phase: manual ? { kind: 'current' } : { kind: 'idle' } })
    return
  }
  if (manual) dismissedAt = 0
  if (host.mode === 'download') {
    put({ phase: { kind: 'available', update: found } })
    maybeOpen()
    return
  }
  await download(found)
}

/** Later: closes the dialog. A ready update asks again after a day, or at the next launch. */
export function laterUpdate(): void {
  const k = state.phase.kind
  if (k === 'ready' || k === 'available') dismissedAt = Date.now()
  put({ open: false, ...(k === 'current' || k === 'error' ? { phase: { kind: 'idle' } } : {}) })
}

/** Restart to update, after `confirm` (unsaved changes) says yes. Refused while a print is being sent. */
export async function restartToUpdate(confirm: () => Promise<boolean> = async () => true): Promise<void> {
  const host = updater()
  const phase = state.phase
  if (!host || phase.kind !== 'ready' || updatesHeld()) return
  if (!(await confirm())) return
  // a send that started while the unsaved changes question was open still wins
  if (updatesHeld()) return
  put({ phase: { kind: 'installing', update: phase.update } })
  try {
    await host.restart()
  } catch (e) {
    put({ phase: { kind: 'error', message: reason(e), update: phase.update } })
  }
}

/** Try again after an error: the download when the update was found, else a new check. */
export function retryUpdate(): void {
  const phase = state.phase
  if (phase.kind !== 'error') return
  if (phase.update && updater()?.mode === 'install') void download(phase.update)
  else void checkForUpdates({ manual: true })
}

/** Checks a little after launch, then once a day while the app runs (hourly ticks, so a sleeping laptop catches up). */
export function startUpdates(): () => void {
  const host = updater()
  if (!host) return () => undefined
  stopUpdates()
  timers.push(setTimeout(() => void checkForUpdates(), FIRST_CHECK_MS))
  timers.push(
    setInterval(() => {
      if (Date.now() - lastCheck >= DAY_MS) void checkForUpdates()
      else maybeOpen()
    }, TICK_MS),
  )
  return stopUpdates
}

function stopUpdates(): void {
  for (const t of timers) clearTimeout(t)
  timers = []
}

/** For tests: forget everything. */
export function resetUpdates(): void {
  stopUpdates()
  resetHolds()
  unhold()
  unhold = onHoldChange(() => notifyBusy())
  busyCheck = () => false
  quietCheck = () => false
  lastCheck = 0
  dismissedAt = 0
  state = { phase: { kind: 'idle' }, open: false }
  listeners.clear()
}
