// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The developer flag for the new Model feel: picking (an edge near the pointer wins over the face under it, Face as
// the default filter) and select-first push and pull. Off unless a developer turns it on with the palette command
// "Developer: new Model feel (on or off)"; it lasts on this device only and counts only in developer mode.
// The flag reads no app state, so the store can ask it while it starts.

export const MODEL_FEEL_KEY = 'sx.modelFeel'

/** Whether the flag is stored on this device, in any settings mode. */
export function modelFeelStored(): boolean {
  try {
    return localStorage.getItem(MODEL_FEEL_KEY) === '1'
  } catch {
    return false
  }
}

/** True when the new Model feel is on: developer mode, with the flag stored. */
export function modelFeelFor(settingsMode: string): boolean {
  return settingsMode === 'developer' && modelFeelStored()
}

const listeners = new Set<(on: boolean) => void>()

/** Calls `fn` with the stored value each time the palette command turns the flag over. Returns the unsubscribe. */
export function onModelFeel(fn: (on: boolean) => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** Turns the flag over and says whether it is on now. */
export function toggleModelFeel(): boolean {
  const on = !modelFeelStored()
  try {
    if (on) localStorage.setItem(MODEL_FEEL_KEY, '1')
    else localStorage.removeItem(MODEL_FEEL_KEY)
  } catch {
    return false
  }
  for (const fn of listeners) fn(on)
  return on
}
