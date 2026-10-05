// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Local notifications for printer alerts while the app runs. Alerts for a closed app come as
// Expo pushes from the hub (see push.ts and SETUP.md).
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { parsePushData, pushHref } from './push'

export type NotifyPermission = 'granted' | 'denied' | 'undetermined'

export interface NotifyMessage {
  title: string
  body: string
  /** Route to open on tap, such as "/printer/bay-3". */
  href: string
}

const CHANNEL = 'printers'

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
})

export async function notifyPermission(): Promise<NotifyPermission> {
  const p = await Notifications.getPermissionsAsync()
  return p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied'
}

export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL, { name: 'Printers', importance: Notifications.AndroidImportance.HIGH })
  }
  const p = await Notifications.requestPermissionsAsync()
  return p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied'
}

export async function notify(m: NotifyMessage): Promise<void> {
  if ((await notifyPermission()) !== 'granted') return
  await Notifications.scheduleNotificationAsync({ content: { title: m.title, body: m.body, data: { href: m.href } }, trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null })
}

/** Calls `open` with the route of a tapped notification, including the one that launched the app. */
export function onNotificationOpen(open: (href: string) => void): () => void {
  const route = (r: Notifications.NotificationResponse | null): void => {
    const data = r?.notification.request.content.data
    const href = (data as { href?: unknown } | undefined)?.href
    if (typeof href === 'string' && href.startsWith('/')) return open(href)
    const push = parsePushData(data)
    if (push) open(pushHref(push))
  }
  void Notifications.getLastNotificationResponseAsync().then(route)
  const sub = Notifications.addNotificationResponseReceivedListener(route)
  return () => sub.remove()
}
