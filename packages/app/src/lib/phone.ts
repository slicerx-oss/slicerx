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
  /** A partner phone: another company's app, paired under this app name. Listed in Printer bridge, Devices. */
  partner?: string
  /** It may approve cards as our phone does, never what a partner app asked for (and answer mimir's questions). */
  approve?: boolean
  /** A partner phone may send prints and read the library. */
  send?: boolean
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
  /** The partner app name, on a partner offer. */
  partner?: string
  /** The digits both screens show. */
  sas: Promise<string>
  /** `rights`: what the paired phone may do. A partner phone starts without approve unless it is passed here. */
  confirm(rights?: { request: boolean; approve: boolean; introduce: boolean; send?: boolean }): void
  reject(): void
  /** `device` names the phone once it is paired: its own name comes inside the sealed confirm. */
  result: Promise<{ ok: boolean; reason?: string; device?: { name: string } }>
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
  /** A new pairing offer. Needs phone access on. `partner`: an offer for a partner phone under that app name. */
  offer(opts?: { partner?: string }): Promise<PhoneOffer>
  /** What a partner phone may do beyond seeing and asking to pause or stop: approve, and send prints. */
  setPartnerRights?(deviceId: string, change: { approve?: boolean; send?: boolean }): Promise<void>
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
