// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 3D mouse's shared state: the registered desktop reader, the device's status and the listeners for its motion. It
// is small and loads with the app. The device driver itself (spacemouse.ts: WebHID, report parsing, buttons) loads
// only once the setting is on or the Connect button is pressed, so the app's startup code stays small.
import type { SpaceFrame } from '@slicerx/viewport/spacemouse'
import { appStore } from '../state/store'

/** Where the device stands, for the setting's status line. */
export type SpaceMouseStatus =
  | { state: 'unsupported' }
  | { state: 'off' }
  | { state: 'none' }
  | { state: 'connected'; name: string }
  | { state: 'busy'; name?: string }
  | { state: 'error'; message: string }

/** A way to reach the device: WebHID here, or the desktop shell's reader. */
export interface SpaceMouseSource {
  kind: 'webhid' | 'desktop'
  /** Starts reading: each raw report with its id as the first byte, and each status change. Returns the stop. */
  start(onReport: (bytes: Uint8Array) => void, onStatus: (s: SpaceMouseStatus) => void): () => void
  /** Asks the person to pick a device (WebHID; must run from a click or key press). Absent where no picking is needed. */
  connect?(): Promise<void>
}

let registered: (() => SpaceMouseSource | null) | null = null
let desktop: SpaceMouseSource | null | undefined
/** Fixed objects, so a status read twice is the same value (React's useSyncExternalStore needs that). */
const UNSUPPORTED: SpaceMouseStatus = Object.freeze({ state: 'unsupported' })
export const SPACE_MOUSE_OFF: SpaceMouseStatus = Object.freeze({ state: 'off' })
let status: SpaceMouseStatus = SPACE_MOUSE_OFF
const statusListeners = new Set<() => void>()
const frameListeners = new Set<(f: SpaceFrame) => void>()

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

/** Whether this browser has WebHID (Chromium-based browsers; not Firefox, Safari or the macOS and Linux web views). */
export function browserHasWebHid(nav: unknown = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  const hid = (nav as { hid?: unknown } | undefined)?.hid
  return !!hid && typeof (hid as { getDevices?: unknown }).getDevices === 'function'
}

export function setSpaceMouseStatus(s: SpaceMouseStatus): void {
  status = s
  for (const l of statusListeners) l()
}

export function spaceMouseStatus(): SpaceMouseStatus {
  const reg = registeredSpaceMouseSource()
  if (reg === null || (reg === undefined && !browserHasWebHid())) return UNSUPPORTED
  return status
}

export function subscribeSpaceMouseStatus(l: () => void): () => void {
  statusListeners.add(l)
  return () => {
    statusListeners.delete(l)
  }
}

/** The 3D view listens here for the device's six axes. */
export function onSpaceMouseFrame(l: (f: SpaceFrame) => void): () => void {
  frameListeners.add(l)
  return () => {
    frameListeners.delete(l)
  }
}

/** Hands one motion frame to every listener (the driver calls it). */
export function emitSpaceFrame(f: SpaceFrame): void {
  for (const l of frameListeners) l(f)
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

/** Tests only: forgets the registered reader's instance and the status, as a fresh page load would. */
export function resetSpaceMouseStateForTests(): void {
  desktop = undefined
  status = SPACE_MOUSE_OFF
}
