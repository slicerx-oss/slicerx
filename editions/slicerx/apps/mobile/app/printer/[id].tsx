// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { useFeed } from '../../src/camera/use-feed'
import { usePocketHost } from '../../src/data/provider'
import { usePrinterView } from '../../src/data/queries'
import { useRefreshPrinters } from '../../src/data/send'
import { EmptyState, Screen } from '../../src/components/layout'
import { headingFor } from '../../src/components/computer-approval-sheet'
import { approve, buildApproval } from '../../src/state/approval'
import { setOpenPrinter, settleWaiting, usePocket } from '../../src/state/store'
import { PrinterDetailScreen, type PrinterControl } from '../../src/screens/printer-detail-screen'

const HOST_ACTION: Record<PrinterControl, 'pause' | 'resume' | 'cancel'> = { pause: 'pause', resume: 'resume', stop: 'cancel' }
const VERB: Record<PrinterControl, string> = { pause: 'Pause', resume: 'Resume', stop: 'Stop' }

export default function PrinterRoute() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const host = usePocketHost()
  const view = usePrinterView(id)
  const camera = view?.status?.cameraAvailable === true && view.status.state !== 'offline'
  const feed = useFeed(id, camera, 'high')
  const refresh = useRefreshPrinters()
  const [refreshing, setRefreshing] = useState(false)
  const waiting = usePocket((s) => s.waiting)

  // While this page is open its approvals show here, not in the sheet.
  useEffect(() => {
    setOpenPrinter(id)
    return () => setOpenPrinter(null)
  }, [id])

  if (!view) {
    return (
      <Screen>
        <EmptyState icon="printer" title="Printer not found" detail="It may have been removed on the computer it is connected to." />
      </Screen>
    )
  }
  const { info } = view

  const onControl = async (action: PrinterControl): Promise<void> => {
    const hostAction = HOST_ACTION[action]
    const request = await buildApproval({
      tool: `printer.${hostAction}`,
      permission: 'start',
      title: `${VERB[action]} the print on ${info.name}?`,
      lines: [`${info.name}: ${info.vendor} ${info.model}`],
      printerId: info.id,
      actions: [{ action: `printer.${hostAction}`, target: info.id, params: { printerId: info.id } }],
    })
    // The tap on the control is the approval; stop has shown its confirm sheet first.
    const token = await approve(host.approvals, request)
    await host.printers[hostAction](info.id, token)
  }

  const approvals = waiting
    .filter((w) => w.request.printerId === info.id)
    .map((w) => ({
      id: w.id,
      request: w.request,
      heading: headingFor(w),
      requestedBy: w.source === 'pilot' ? w.requestedBy : undefined,
      blocked: w.blocked,
      code: w.code,
      decide: async (d: 'approve' | 'deny', o?: { bedClear?: boolean }) => {
        await w.decide(d, o)
        settleWaiting(w.id)
      },
    }))

  return (
    <PrinterDetailScreen
      printer={view}
      feed={feed}
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true)
        void refresh().finally(() => setRefreshing(false))
      }}
      onControl={onControl}
      onSendPrint={() => router.push({ pathname: '/send', params: { printer: info.id } })}
      approvals={approvals}
      onAskPilot={(prompt) => router.push({ pathname: '/pilot', params: { prompt } })}
      onBack={() => router.back()}
    />
  )
}
