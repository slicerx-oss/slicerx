// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pocket's one client store: alerts, notification and haptics preferences, and the Pilot
// session list. Server state (printers, library, session) lives in TanStack Query
// (src/data). Preferences persist in AsyncStorage; alerts are kept for the session.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { DEFAULT_POLICY, type ApprovalRequest, type PermissionPolicy, type SessionSummary } from '@slicerx/contracts'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type AlertKind = 'finished' | 'failed' | 'attention'

export interface Alert {
  id: string
  kind: AlertKind
  printerId: string
  printerName: string
  title: string
  detail: string
  /** Epoch ms. */
  at: number
  read: boolean
}

export interface NotificationPrefs {
  printDone: boolean
  printFailed: boolean
  attention: boolean
  approvals: boolean
}

/** An approval a paired computer asked this phone to decide. Answered from the sheet or the printer page. */
export interface WaitingApproval {
  id: string
  hostName: string
  request: ApprovalRequest
  source: 'pilot' | 'pair' | 'host'
  requestedBy?: string | undefined
  /** Set when the phone is connected through the relay and this request may only be answered at home. */
  blocked?: string | undefined
  /** A G-code line the hub checked, shown whole in a monospace font. */
  code?: string | undefined
  /** The paired computer that asked, so its list of open requests can be read again. */
  pairingId?: string | undefined
  /** Set once it was answered somewhere else: the note the card shows until it closes. */
  answered?: string | undefined
  decide: (decision: 'approve' | 'deny', opts?: { bedClear?: boolean }) => Promise<void>
}

/** How alerts reach the phone while the app is closed. */
export type PushState = { kind: 'off' } | { kind: 'unsupported'; reason: string } | { kind: 'no-hub' } | { kind: 'on'; hostName: string }

export interface PocketState {
  alerts: Alert[]
  /** Approvals waiting for an answer, oldest first. */
  waiting: WaitingApproval[]
  /** The printer page on screen, so the approval sheet leaves that printer's cards to the page. */
  openPrinterId: string | null
  push: PushState
  notify: NotificationPrefs
  haptics: boolean
  /** mimir's permission policy; the device prompt still guards every approval. */
  policy: PermissionPolicy
  /** Pilot sessions started on this phone, newest first. */
  sessions: SessionSummary[]
  /** Where the paired computer would slice, or null when none is paired and online. */
  sliceLocation: { kind: 'desktop' | 'browser'; name: string; detail: string } | null
}

const MAX_ALERTS = 100

export const usePocket = create<PocketState>()(
  persist(
    (): PocketState => ({
      alerts: [],
      waiting: [],
      openPrinterId: null,
      push: { kind: 'off' },
      notify: { printDone: true, printFailed: true, attention: true, approvals: true },
      haptics: true,
      policy: DEFAULT_POLICY,
      sessions: [],
      sliceLocation: null,
    }),
    {
      name: 'sx-pocket',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ notify: s.notify, haptics: s.haptics, policy: s.policy }),
    },
  ),
)

export const get = usePocket.getState
export const set = usePocket.setState

export const PREF_FOR: Record<AlertKind, keyof NotificationPrefs> = { finished: 'printDone', failed: 'printFailed', attention: 'attention' }

export function setSliceLocation(where: PocketState['sliceLocation']): void {
  set({ sliceLocation: where })
}

export function pushAlert(a: Alert): void {
  set((s) => ({ alerts: [a, ...s.alerts].slice(0, MAX_ALERTS) }))
}

export function markAllRead(): void {
  set((s) => ({ alerts: s.alerts.map((a) => (a.read ? a : { ...a, read: true })) }))
}

export function markRead(id: string): void {
  set((s) => ({ alerts: s.alerts.map((a) => (a.id === id && !a.read ? { ...a, read: true } : a)) }))
}

export function addWaiting(a: WaitingApproval): void {
  set((s) => (s.waiting.some((x) => x.id === a.id) ? s : { waiting: [...s.waiting, a] }))
}

/** The request was answered somewhere else: its card shows `note` instead of its buttons. */
export function markAnswered(id: string, note: string): void {
  set((s) => (s.waiting.some((x) => x.id === id && x.answered === undefined) ? { waiting: s.waiting.map((x) => (x.id === id ? { ...x, answered: note } : x)) } : s))
}

export function settleWaiting(id: string): void {
  set((s) => ({ waiting: s.waiting.filter((x) => x.id !== id) }))
}

export function setOpenPrinter(id: string | null): void {
  set({ openPrinterId: id })
}

/** Approvals waiting per printer id, for badges. */
export function waitingByPrinter(list: WaitingApproval[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const w of list) {
    const id = w.request.printerId
    if (id) out[id] = (out[id] ?? 0) + 1
  }
  return out
}
