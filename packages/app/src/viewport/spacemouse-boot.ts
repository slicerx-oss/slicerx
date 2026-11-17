// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The part of the 3D mouse that loads with the app: the desktop shell's reader, registered before the app starts, and
// the loader that brings in the driver (spacemouse.ts) once the setting is on. Status and motion listeners are in
// spacemouse-state.ts, which loads with what reads them.
import { appStore } from '../state/store'
import type { SpaceMouseSource } from './spacemouse-state'

let registered: (() => SpaceMouseSource | null) | null = null
let desktop: SpaceMouseSource | null | undefined

/** The desktop shell's reader, registered before the app starts. Without one the browser's WebHID is used. */
export function registerSpaceMouseSource(factory: (() => SpaceMouseSource | null) | null): void {
  registered = factory
  desktop = undefined
}

/** The registered reader: undefined when nothing is registered, null when the shell has none on this system. */
export function registeredSpaceMouseSource(): SpaceMouseSource | null | undefined {
  if (!registered) return undefined
  if (desktop === undefined) desktop = registered()
  return desktop
}

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

/** Tests only: forgets the registered reader's instance, as a fresh page load would. */
export function resetSpaceMouseBootForTests(): void {
  desktop = undefined
}
