// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What has been typed into the command bar, and whether Enter has been pressed, kept outside the bar itself. The bar's
// code and its search results download on first use, so a small stand-in palette (command-bar-pending.tsx) takes the
// keys until they arrive and the real bar picks up the same draft.
import { useSyncExternalStore } from 'react'
import { hostSlices } from '../state/model-mode'
import { get, set } from '../state/store'

let query = ''
let submit = false
const listeners = new Set<() => void>()

function changed(): void {
  for (const l of [...listeners]) l()
}

/** The text in the bar's input. */
export function useCommandQuery(): string {
  return useSyncExternalStore((l) => { listeners.add(l); return () => void listeners.delete(l) }, () => query, () => '')
}

/**
 * Types into the bar. Any edit after a waiting Enter (typing, deleting or a paste) drops that Enter: the person
 * changed their mind, so nothing runs until they press Enter again for the new text.
 */
export function setCommandQuery(value: string): void {
  if (value === query) return
  query = value
  submit = false
  changed()
}

/** Enter was pressed with no row to run yet: run the first match for the text as it is then, once the list has loaded. */
export function queueCommandSubmit(): void {
  submit = true
}

/** True once when an Enter is waiting, then false until the next one. */
export function takeCommandSubmit(): boolean {
  const queued = submit
  submit = false
  return queued
}

/** Drops a waiting Enter without running it. */
export function dropCommandSubmit(): void {
  submit = false
}

/** Closes the bar and forgets the draft, so the next open starts empty. */
export function closeCommandBar(): void {
  submit = false
  query = ''
  set({ commandOpen: false })
  changed()
}

/** The input's hint, the same in the stand-in and the real bar. */
export function commandPlaceholder(): string {
  return hostSlices() ? 'Type a command, a setting or a printer' : 'Type a command'
}

/**
 * Whether the bar may open now. A modal dialog sits in the top layer over the bar and keeps everything behind it inert, so
 * a bar opened under one would be unseen and could not take the focus; the key does nothing until the dialog has gone.
 * The projects dialog (the restore offer among them) counts from the moment it is asked for: its code downloads first, so
 * for a moment it is wanted but not yet open, and a bar opened in that moment would lose the focus to it when it shows.
 */
export function commandBarMayOpen(doc: Document = document): boolean {
  return get().projectsDialog === null && doc.querySelector('dialog[open]') === null
}
