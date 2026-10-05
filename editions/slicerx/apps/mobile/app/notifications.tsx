// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { router } from 'expo-router'
import { useMemo } from 'react'
import { markAllRead, markRead, usePocket, type AlertKind } from '../src/state/store'
import { NotificationsScreen, type AppNotification, type NotificationKind } from '../src/screens/notifications-screen'

const KIND: Record<AlertKind, NotificationKind> = { finished: 'print_done', failed: 'print_failed', attention: 'attention' }

export default function NotificationsRoute() {
  const alerts = usePocket((s) => s.alerts)
  const items = useMemo<AppNotification[]>(() => alerts.map((a) => ({ id: a.id, kind: KIND[a.kind], title: a.title, body: a.detail, at: new Date(a.at).toISOString(), read: a.read })), [alerts])
  return (
    <NotificationsScreen
      items={items}
      loading={false}
      refreshing={false}
      onRefresh={() => undefined}
      onOpen={(n) => {
        markRead(n.id)
        const a = alerts.find((x) => x.id === n.id)
        if (a) router.push({ pathname: '/printer/[id]', params: { id: a.printerId } })
      }}
      onMarkAllRead={markAllRead}
      onBack={() => router.back()}
    />
  )
}
