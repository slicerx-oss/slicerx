// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Model feel: picking starts on Face, and an edge near the pointer wins over the face under it. It is on for
// everyone. A developer can turn it off on this device with the palette command "Developer: new Model feel (on or
// off)", which brings back the old picking (whole objects first, the face always wins); the switch counts only in
// developer mode, so nobody else can be left on the old feel. The flag reads no app state, so the store can ask it
// while it starts.

export const MODEL_FEEL_KEY = 'sx.modelFeel'

/** The stored value that turns the feel off. Anything else (nothing stored, or the old "1") leaves it on. */
const OFF = '0'

/** Whether a developer turned the feel off on this device, in any settings mode. */
export function modelFeelOffStored(): boolean {
  try {
    return localStorage.getItem(MODEL_FEEL_KEY) === OFF
  } catch {
    return false
  }
}

/** True when the Model feel is on: always, unless a developer turned it off and is still in developer mode. */
export function modelFeelFor(settingsMode: string): boolean {
  return !(settingsMode === 'developer' && modelFeelOffStored())
}

const listeners = new Set<(on: boolean) => void>()

/** Calls `fn` with the new value each time the palette command turns the flag over. Returns the unsubscribe. */
export function onModelFeel(fn: (on: boolean) => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** Turns the flag over (the palette command runs only in developer mode) and says whether the feel is on now. */
export function toggleModelFeel(): boolean {
  const on = modelFeelOffStored()
  try {
    if (on) localStorage.removeItem(MODEL_FEEL_KEY)
    else localStorage.setItem(MODEL_FEEL_KEY, OFF)
  } catch {
    return !on
  }
  for (const fn of listeners) fn(on)
  return on
}
