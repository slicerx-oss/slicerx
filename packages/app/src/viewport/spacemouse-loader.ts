// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The only part of the 3D mouse that loads with the app: it brings in the driver (spacemouse.ts) once the setting is
// on. Kept apart from spacemouse-state.ts so that nothing else of the 3D mouse is in the app's startup code.
import { appStore } from '../state/store'

/**
 * Loads the driver once the 3D mouse setting is on, now or later; from then on the driver follows the setting itself.
 * The app calls it once at start. Returns the stop of the watch.
 */
export function startSpaceMouseWhenOn(): () => void {
  let loaded = false
  const load = () => {
    if (loaded) return
    loaded = true
    unwatch()
    void import('./spacemouse').then((m) => m.startSpaceMouse())
  }
  const unwatch = appStore.subscribe((s) => {
    if (s.spaceMouse.enabled) load()
  })
  if (appStore.getState().spaceMouse.enabled) load()
  return unwatch
}
