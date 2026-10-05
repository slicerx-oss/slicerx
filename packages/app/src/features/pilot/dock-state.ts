// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether the assistant's docked panel is open. Kept outside the app store: it is a view choice,
// remembered per browser, and nothing else reads it.
import { useSyncExternalStore } from 'react'

const KEY = 'sx-mimir-dock'
let open = false
try {
  open = globalThis.localStorage?.getItem(KEY) === '1'
} catch {
  open = false
}
const listeners = new Set<() => void>()

function write(v: boolean): void {
  open = v
  try {
    globalThis.localStorage?.setItem(KEY, v ? '1' : '0')
  } catch {
    // Private windows can refuse storage; the choice still holds for this page.
  }
  for (const l of listeners) l()
}

export const dockOpen = (): boolean => open
export const openDock = (): void => write(true)
export const closeDock = (): void => write(false)
export const toggleDock = (): void => write(!open)

export function useDockOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => open,
    () => false,
  )
}
