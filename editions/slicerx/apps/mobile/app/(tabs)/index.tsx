// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Home: every printer with its camera and progress.
import { router } from 'expo-router'
import { useMemo, useState } from 'react'
import { LiveVideo } from '../../src/data/live-video'
import { useFleets, usePrinterViews } from '../../src/data/queries'
import { useRefreshPrinters } from '../../src/data/send'
import { usePocket, waitingByPrinter } from '../../src/state/store'
import { PrintersScreen } from '../../src/screens/printers-screen'

export default function PrintersRoute() {
  const { views, loading } = usePrinterViews()
  const { data: fleets = [] } = useFleets()
  const refresh = useRefreshPrinters()
  const [refreshing, setRefreshing] = useState(false)
  const unread = usePocket((s) => s.alerts.filter((a) => !a.read).length)
  const waiting = usePocket((s) => s.waiting)
  const approvals = useMemo(() => waitingByPrinter(waiting), [waiting])
  return (
    <PrintersScreen
      printers={views}
      fleets={fleets}
      loading={loading}
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true)
        void refresh().finally(() => setRefreshing(false))
      }}
      onOpenPrinter={(id) => router.push({ pathname: '/printer/[id]', params: { id } })}
      onOpenNotifications={() => router.push('/notifications')}
      unreadNotifications={unread}
      onAddPrinter={() => router.push('/pair')}
      Video={LiveVideo}
      approvals={approvals}
    />
  )
}
