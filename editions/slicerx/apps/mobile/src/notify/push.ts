// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Alerts while the app is closed. The hub (sx-link on the paired computer) sends Expo pushes:
// print done, print failed, needs attention, approval waiting. The visible text is content-free
// (it travels through Expo and Apple or Google), so the app loads the details over the paired
// channel when it opens. This file registers the phone's token with the hub and reacts to pushes.
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import type { NotificationPrefs, PushState } from '../state/store'
import { notifyPermission } from './notifier'

export type PushKind = 'print_done' | 'print_failed' | 'attention' | 'approval'

/** What the hub puts in a push's `data`. Everything else in the push is generic text. */
export interface PushData {
  kind: PushKind
  printerId?: string
  requestId?: string
  /** Route to open on tap, such as "/printer/bay-3". */
  href?: string
}

/** The hub side of registration, on the paired channel (`push.register`, `push.unregister`). */
export interface PushRegistrar {
  register(reg: { token: string; platform: 'ios' | 'android'; prefs: NotificationPrefs }): Promise<void>
  unregister(token: string): Promise<void>
}

/** The Expo push token for this install, or why there is none. Needs the EAS project id (SETUP.md). */
export async function pushToken(): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  if (Platform.OS === 'web') return { ok: false, reason: 'Push alerts need the iOS or Android app' }
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId
  if (!projectId) return { ok: false, reason: 'This build has no push project id' }
  if ((await notifyPermission()) !== 'granted') return { ok: false, reason: 'Notifications are off for this app' }
  try {
    const t = await Notifications.getExpoPushTokenAsync({ projectId })
    return { ok: true, token: t.data }
  } catch (e) {
    return { ok: false, reason: e instanceof Error && e.message ? e.message : 'Could not get a push token' }
  }
}

/** The platform as the hub records it. */
export const platform: 'ios' | 'android' = Platform.OS === 'android' ? 'android' : 'ios'

export function wantsPush(prefs: NotificationPrefs): boolean {
  return prefs.printDone || prefs.printFailed || prefs.attention || prefs.approvals
}

/**
 * Keeps the hub's registration in step with the preferences. Returns what the Account screen shows.
 * `registrar` is null while no paired computer with a hub is online.
 */
export async function syncPush(registrar: PushRegistrar | null, hostName: string | null, prefs: NotificationPrefs, last: { token: string; registrar: PushRegistrar } | null): Promise<{ state: PushState; last: { token: string; registrar: PushRegistrar } | null }> {
  if (!wantsPush(prefs)) {
    if (last) await last.registrar.unregister(last.token).catch(() => undefined)
    return { state: { kind: 'off' }, last: null }
  }
  const t = await pushToken()
  if (!t.ok) return { state: { kind: 'unsupported', reason: t.reason }, last }
  if (!registrar || !hostName) return { state: { kind: 'no-hub' }, last }
  await registrar.register({ token: t.token, platform, prefs })
  return { state: { kind: 'on', hostName }, last: { token: t.token, registrar } }
}

export function parsePushData(data: unknown): PushData | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const kind = d['kind']
  if (kind !== 'print_done' && kind !== 'print_failed' && kind !== 'attention' && kind !== 'approval') return null
  const out: PushData = { kind }
  if (typeof d['printerId'] === 'string') out.printerId = d['printerId']
  if (typeof d['requestId'] === 'string') out.requestId = d['requestId']
  if (typeof d['href'] === 'string' && d['href'].startsWith('/')) out.href = d['href']
  return out
}

/** Where a push leads when tapped: its printer, else the Printers tab. */
export function pushHref(d: PushData): string {
  return d.href ?? (d.printerId ? `/printer/${d.printerId}` : '/(tabs)')
}

/** Calls `onPush` for every push that arrives while the app is open, so the printer list refreshes. */
export function onPushReceived(onPush: (d: PushData) => void): () => void {
  const sub = Notifications.addNotificationReceivedListener((n) => {
    const d = parsePushData(n.request.content.data)
    if (d) onPush(d)
  })
  return () => sub.remove()
}

/** The wording the hub should use: nothing that names a file, a model or a printer. */
export const PUSH_TEXT: Record<PushKind, { title: string; body: string }> = {
  print_done: { title: 'Print finished', body: 'A printer is done. Open SlicerX to see which.' },
  print_failed: { title: 'Print stopped', body: 'A print did not finish. Open SlicerX for details.' },
  attention: { title: 'A printer needs you', body: 'Open SlicerX to see what it is waiting for.' },
  approval: { title: 'Approval waiting', body: 'Something is waiting for your answer in SlicerX.' },
}
