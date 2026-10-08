// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Knows whether the project has changes that were never saved, and asks before anything throws them
// away: starting over, opening another project, closing the tab or quitting the desktop app.
import { allPlates } from '../plate/plates'
import { appStore, get, set, type AppState } from '../state/store'

/** What counts as a project change; slicing state does not. */
const INPUTS = ['plate', 'plates', 'objectSettings', 'slotSetup', 'layerMarks', 'overrides', 'easy', 'bed'] as const satisfies readonly (keyof AppState)[]

let dirty = false
let tracking = false
let pending: ((proceed: boolean) => void) | null = null
/** Project changes so far, except those made while `quiet` (not edits at all). Opens compare it to tell their own changes from the person's. */
let edits = 0
let quiet = 0

/** The project matches what was saved or opened (or is the untouched starting plate). */
export function markClean(): void {
  dirty = false
  notify()
}

/** Runs a store change that is not an edit of the project (setup choosing the bed): a project that was clean stays clean. */
export function withoutDirtying(change: () => void): void {
  const clean = !isDirty()
  quiet++
  try {
    change()
  } finally {
    quiet--
  }
  if (clean) markClean()
}

/** An open in progress. Changes it makes through `run` or `during` are its own; `finish` marks the project clean only when nothing else changed it meanwhile. */
export interface OpenScope {
  /** Runs changes the open makes. Throws OpenSuperseded once a newer open has taken over. */
  run<T>(fn: () => T): T
  /** Waits for work of the open whose changes cannot be wrapped one by one (an arrange); changes until it settles are the open's. */
  during<T>(work: Promise<T>): Promise<T>
  /** A newer open has taken over the project; this one's remaining work stops. */
  readonly superseded: boolean
  /** The open is done: clean, unless the person edited the project while it ran. `ok` false (it failed) leaves the state as it is. */
  finish(ok?: boolean): void
}

/** Thrown into an open that a newer open took over while it was still running. */
export class OpenSuperseded extends Error {
  constructor() {
    super('A newer open took over the project')
    this.name = 'OpenSuperseded'
  }
}

interface LiveOpen {
  start: number
  own: number
  settling: number
  superseded: boolean
  /** The project was clean when the open started. */
  clean: boolean
}

const live = new Set<LiveOpen>()

/** Every change since a still running open started is that open's own, and the project was clean before it. */
function onlyOpening(): boolean {
  for (const o of live) if (!o.superseded && o.clean && o.settling === 0 && edits - o.start === o.own) return true
  return false
}

/** Starts an open: from here, a project change that is not the open's own (a model dropped while it loads) keeps the project unsaved. An open still running stops: this one replaces what it was opening. */
export function beginOpen(): OpenScope {
  for (const o of live) o.superseded = true
  const me: LiveOpen = { start: edits, own: 0, settling: 0, superseded: false, clean: !dirty }
  live.add(me)
  const alive = () => {
    if (me.superseded) throw new OpenSuperseded()
  }
  return {
    run(fn) {
      alive()
      const before = edits
      try {
        return fn()
      } finally {
        me.own += edits - before
      }
    },
    async during(work) {
      const before = edits
      me.settling++
      try {
        return await work
      } finally {
        me.settling--
        me.own += edits - before
        alive()
      }
    },
    get superseded() {
      return me.superseded
    },
    finish(ok = true) {
      live.delete(me)
      if (ok && !me.superseded && me.settling === 0 && edits - me.start === me.own) markClean()
      else notify()
    },
  }
}

const listeners = new Set<(unsaved: boolean) => void>()
let reported = false

function notify(): void {
  const now = isDirty()
  if (now === reported) return
  reported = now
  for (const l of listeners) l(now)
}

/** Calls `listener` with the current answer and again whenever "unsaved changes exist" changes. Returns a stop function. */
export function onDirtyChange(listener: (unsaved: boolean) => void): () => void {
  listeners.add(listener)
  listener(isDirty())
  return () => listeners.delete(listener)
}

/** Starts watching the store. Safe to call more than once. */
export function startDirtyTracking(): void {
  if (tracking) return
  tracking = true
  appStore.subscribe((s, prev) => {
    if (INPUTS.some((k) => s[k] !== prev[k])) {
      dirty = true
      if (!quiet) edits++
    }
    if (dirty || reported) notify()
  })
}

/** Unsaved changes exist and there is something on the plates to lose. */
export function isDirty(): boolean {
  // An open still running is not unsaved work: its changes are the file's.
  return dirty && !onlyOpening() && allPlates(get()).some((p) => p.objects.length > 0)
}

/**
 * Asks to save, discard or cancel when there are unsaved changes. Resolves true when the caller may go
 * on (nothing to lose, saved, or discarded) and false when the person canceled.
 */
export function confirmDiscard(what: string): Promise<boolean> {
  if (!isDirty()) return Promise.resolve(true)
  pending?.(false)
  return new Promise<boolean>((resolve) => {
    pending = resolve
    set({ unsavedPrompt: { what } })
  })
}

/** The dialog's answer. */
export function answerUnsaved(proceed: boolean): void {
  const r = pending
  pending = null
  set({ unsavedPrompt: null })
  if (proceed) markClean()
  r?.(proceed)
}
