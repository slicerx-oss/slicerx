// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// After the desktop shell reloaded a window whose web view stopped (apps/desktop/src-tauri/src/recover.rs): the work
// autosave kept is put back on the plates without asking, and a short notice says what came back and what did not.
import type { Host } from '@slicerx/contracts'
import { set, toast } from '../state/store'
import { findRecovery, nothingToLose, openSnapshot, type Snapshot } from './autosave'

/** What the shell says about the stop this page load follows. */
export interface ViewCrash {
  /** The project had unsaved changes when the view stopped. */
  unsaved: boolean
  /** When it stopped, in ms since the epoch. */
  at: number
}

/** What the restore did, which picks the notice. */
export type ViewCrashOutcome =
  /** The autosave is back on the plates; anything after `savedAt` was not in it. */
  | { kind: 'restored'; savedAt: number }
  /** The autosave is there but needs a person (locked to the account, or it would replace work): the restore dialog asks. */
  | { kind: 'offered' }
  /** There were unsaved changes and no autosave of them yet. */
  | { kind: 'lost' }
  /** Nothing was unsaved. */
  | { kind: 'clean' }

const PREFIX = 'The view stopped and was reloaded.'

const clock = (t: number): string => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })

/** The notice for an outcome: one or two plain sentences, saying what was lost when something was. */
export function viewCrashNote(o: ViewCrashOutcome): string {
  switch (o.kind) {
    case 'restored':
      return `${PREFIX} Your work was restored as autosaved at ${clock(o.savedAt)}. Changes after that, if any, were lost.`
    case 'offered':
      return `${PREFIX} Your unsaved work was kept. Restore it from the dialog.`
    case 'lost':
      return `${PREFIX} Your latest changes had not been autosaved yet and were lost.`
    case 'clean':
      return `${PREFIX} Nothing unsaved was lost.`
  }
}

/**
 * Puts the autosave back after a stop and says so. `found` is the autosave the page found at start, if any. `open` is
 * openSnapshot, replaced in tests.
 */
export async function recoverAfterViewCrash(host: Host, crash: ViewCrash, found?: Snapshot | null, open: typeof openSnapshot = openSnapshot): Promise<ViewCrashOutcome> {
  const snap = found === undefined ? await findRecovery() : found
  let outcome: ViewCrashOutcome
  if (!crash.unsaved) {
    // Any autosave is from an earlier session, not the work that just stopped: offered as at any start.
    if (snap && nothingToLose()) set({ projectsDialog: 'recover' })
    outcome = { kind: 'clean' }
  } else if (!snap) outcome = { kind: 'lost' }
  else if (snap.locked || !nothingToLose()) outcome = { kind: 'offered' }
  else {
    try {
      // It was unsaved when the view stopped, and it still is.
      await open(host, { ...snap, dirty: true })
      outcome = { kind: 'restored', savedAt: snap.savedAt }
    } catch {
      outcome = { kind: 'offered' }
    }
  }
  if (outcome.kind === 'offered') set({ projectsDialog: 'recover' })
  toast(viewCrashNote(outcome), outcome.kind === 'restored' || outcome.kind === 'clean' ? 'info' : 'warn', undefined, {})
  return outcome
}
