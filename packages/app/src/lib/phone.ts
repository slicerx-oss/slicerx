// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Phone access as the Settings screen sees it. The app entry registers a
// controller (see features/phone) once it has a pairing host and a LAN bridge.
import { useSyncExternalStore } from 'react'

export interface PhoneDevice {
  id: string
  name: string
  platform: string
  online: boolean
  lastSeenAt?: number
}

export interface PhoneState {
  status: 'off' | 'starting' | 'on' | 'error'
  /** Addresses phones connect to on this network, while on. */
  urls: string[]
  devices: PhoneDevice[]
  error?: string
}

/** A phone asking to pair: both people compare the digits, then the person at this computer confirms or refuses. */
export interface PhoneAttempt {
  deviceName: string
  /** The digits both screens show. */
  sas: Promise<string>
  confirm(): void
  reject(): void
  result: Promise<{ ok: boolean; reason?: string }>
}

/** A pairing offer: the phone types the code (or opens the link). It expires and works once. */
export interface PhoneOffer {
  /** Shown as XXXX-XXXX-XXXX. */
  code: string
  link: string
  expiresAt: number
  onAttempt(cb: (a: PhoneAttempt) => void): () => void
  cancel(): void
}

export interface PhoneAccess {
  getState(): PhoneState
  subscribe(cb: () => void): () => void
  /** Turns the LAN listener on or off. Off by default; not remembered across launches. */
  setEnabled(on: boolean): Promise<void>
  revoke(deviceId: string): Promise<void>
  /** A new pairing offer. Needs phone access on. */
  offer(): Promise<PhoneOffer>
}

export const PHONE_OFF: PhoneState = { status: 'off', urls: [], devices: [] }

let current: PhoneAccess | null = null
const listeners = new Set<() => void>()

/** Called by the app entry. Pass null to remove it. */
export function setPhoneAccess(p: PhoneAccess | null): void {
  current = p
  for (const l of listeners) l()
}

export function getPhoneAccess(): PhoneAccess | null {
  return current
}

function subscribeRegistry(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function usePhoneAccess(): PhoneAccess | null {
  return useSyncExternalStore(subscribeRegistry, getPhoneAccess, getPhoneAccess)
}

export function usePhoneState(p: PhoneAccess | null): PhoneState {
  return useSyncExternalStore(
    (cb) => (p ? p.subscribe(cb) : () => undefined),
    () => (p ? p.getState() : PHONE_OFF),
    () => PHONE_OFF,
  )
}
