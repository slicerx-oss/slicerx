// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Motion, in one place. The root carries data-motion="full" or "reduced"; every reduced motion rule in the
// stylesheets keys on it, and every script asks motionReduced(). The person's choice decides it: follow
// the system's reduce motion setting, or always on, or always reduced. Remote Desktop often turns the
// system setting on, which is why the app offers the other two.
export type MotionPreference = 'system' | 'full' | 'reduced'

const QUERY = '(prefers-reduced-motion: reduce)'
let preference: MotionPreference = 'system'
const listeners = new Set<() => void>()

function media(): MediaQueryList | null {
  try {
    return typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(QUERY) : null
  } catch {
    return null
  }
}

/** What the system asks for, regardless of the in-app choice. */
export function systemReducesMotion(): boolean {
  return media()?.matches ?? false
}

/** Full or reduced, from a preference and what the system asks for. */
export function resolveMotion(pref: MotionPreference, systemReduced: boolean): 'full' | 'reduced' {
  return pref === 'system' ? (systemReduced ? 'reduced' : 'full') : pref
}

function apply(): void {
  if (typeof document === 'undefined') return
  const next = resolveMotion(preference, systemReducesMotion())
  if (document.documentElement.dataset['motion'] !== next) document.documentElement.dataset['motion'] = next
  for (const cb of listeners) cb()
}

/** Sets the person's choice and applies it to the root at once. */
export function setMotionPreference(pref: MotionPreference): void {
  preference = pref
  apply()
}

export function motionPreference(): MotionPreference {
  return preference
}

/** True when motion is reduced now: by the root's data-motion, else by the system. */
export function motionReduced(): boolean {
  const on = typeof document === 'undefined' ? undefined : document.documentElement.dataset['motion']
  if (on === 'reduced') return true
  if (on === 'full') return false
  return systemReducesMotion()
}

export function subscribeMotion(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// Follow the system from the moment the kit loads, so the stylesheets have the attribute before any
// choice is read; a system change only matters while the choice is Follow system.
if (typeof document !== 'undefined') {
  apply()
  media()?.addEventListener?.('change', () => {
    if (preference === 'system') apply()
  })
}
