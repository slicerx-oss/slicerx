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

/** The project matches what was saved or opened (or is the untouched starting plate). */
export function markClean(): void {
  dirty = false
  notify()
}

/** Runs a store change that is not an edit of the project (setup choosing the bed): a project that was clean stays clean. */
export function withoutDirtying(change: () => void): void {
  const clean = !isDirty()
  change()
  if (clean) markClean()
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
    if (INPUTS.some((k) => s[k] !== prev[k])) dirty = true
    if (dirty || reported) notify()
  })
}

/** Unsaved changes exist and there is something on the plates to lose. */
export function isDirty(): boolean {
  return dirty && allPlates(get()).some((p) => p.objects.length > 0)
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
