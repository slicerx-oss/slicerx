// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Home: every paired printer with its camera and progress at a glance. What needs the person sorts
// to the top; offline printers fold into plain rows at the bottom. Fleets are optional filters.
import { useMemo, useState, type ComponentType } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import type { Fleet } from '@slicerx/contracts'
import type { FeedQuality } from '../camera/feed'
import { Button, Chip, IconButton } from '../components/button'
import { EmptyState, Screen, ScreenHeader } from '../components/layout'
import { LiveView } from '../components/printers/live-view'
import { PrinterRow, PrinterStage, STATE_ORDER, showsStage, type PrinterView } from '../components/printers/printer-bits'
import { SkeletonRows } from '../components/status'
import { t } from '../components/theme'

export interface VideoProps {
  printer: PrinterView
  quality: FeedQuality
}

export interface PrintersScreenProps {
  printers: PrinterView[]
  fleets: Fleet[]
  /** True until the first list arrives. */
  loading: boolean
  refreshing: boolean
  onRefresh: () => void
  onOpenPrinter: (printerId: string) => void
  onOpenNotifications: () => void
  unreadNotifications: number
  /** Opens pairing when no computer is paired yet, since printers come from the paired host. */
  onAddPrinter: () => void
  /** Draws one printer's camera. The route binds this to the live feed; tests take the still default. */
  Video?: ComponentType<VideoProps> | undefined
  /** Approvals waiting per printer id. */
  approvals?: Record<string, number> | undefined
  /** Clock for "done by" times, for tests. */
  now?: number | undefined
}

/** "2 printing, 1 idle, 1 needs you, 1 offline" */
export function summarize(list: PrinterView[]): string {
  let printing = 0
  let idle = 0
  let needs = 0
  let offline = 0
  for (const p of list) {
    const s = p.status?.state
    if (s === 'printing' || s === 'preparing') printing++
    else if (s === 'idle' || s === 'finished') idle++
    else if (s === 'paused' || s === 'error') needs++
    else if (s === 'offline') offline++
  }
  const parts: string[] = []
  if (printing) parts.push(`${printing} printing`)
  if (idle) parts.push(`${idle} idle`)
  if (needs) parts.push(`${needs} need${needs === 1 ? 's' : ''} you`)
  if (offline) parts.push(`${offline} offline`)
  return parts.join(', ')
}

/** Without a feed (tests, previews) the tile shows the printer's camera state and nothing else. */
function StillVideo({ printer }: VideoProps) {
  return <LiveView name={printer.info.name} available={printer.status?.cameraAvailable ?? false} frame={null} mode={null} stats={null} loading={false} stale={false} unavailable={false} aspect={9 / 16} />
}

export function PrintersScreen(p: PrintersScreenProps) {
  const [fleetId, setFleetId] = useState<string | null>(null)
  const fleet = fleetId ? p.fleets.find((f) => f.id === fleetId) : undefined
  const Video = p.Video ?? StillVideo

  const shown = useMemo(() => {
    const inFleet = fleet ? p.printers.filter((x) => fleet.printerIds.includes(x.info.id)) : p.printers
    return [...inFleet].sort((a, b) => {
      const d = STATE_ORDER[a.status?.state ?? 'offline'] - STATE_ORDER[b.status?.state ?? 'offline']
      return d !== 0 ? d : a.info.name.localeCompare(b.info.name, undefined, { numeric: true })
    })
  }, [p.printers, fleet])

  const header = (
    <ScreenHeader
      title="Printers"
      subtitle={p.loading ? 'Loading' : summarize(shown) || 'No printers yet'}
      actions={
        <>
          <IconButton icon="notification" label="Notifications" onPress={p.onOpenNotifications} badge={p.unreadNotifications > 0} testID="open-notifications" />
          <IconButton icon="plus" label="Add a printer" onPress={p.onAddPrinter} />
        </>
      }
    />
  )

  return (
    <Screen header={header} refreshing={p.refreshing} onRefresh={p.onRefresh} testID="printers-screen">
      {p.fleets.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          <Chip label="All printers" selected={fleetId === null} onPress={() => setFleetId(null)} testID="fleet-all" />
          {p.fleets.map((f) => (
            <Chip key={f.id} label={f.name} icon="fleet" selected={fleetId === f.id} onPress={() => setFleetId(f.id)} testID={`fleet-${f.id}`} />
          ))}
        </ScrollView>
      ) : null}
      <View style={styles.list}>
        {p.loading ? (
          <SkeletonRows count={4} />
        ) : shown.length === 0 ? (
          <EmptyState
            icon="printer"
            title={fleet ? `No printers in ${fleet.name}` : 'No printers yet'}
            detail={fleet ? 'Add printers to this fleet from SlicerX on your computer.' : 'Pair the computer that runs SlicerX and its printers show up here, camera and all.'}
            action={fleet ? undefined : <Button label="Pair a computer" icon="qr" kind="primary" onPress={p.onAddPrinter} />}
          />
        ) : (
          shown.map((x) =>
            showsStage(x.status) ? (
              <PrinterStage
                key={x.info.id}
                printer={x}
                video={<Video printer={x} quality="low" />}
                approvalWaiting={(p.approvals?.[x.info.id] ?? 0) > 0}
                onPress={() => p.onOpenPrinter(x.info.id)}
                now={p.now}
              />
            ) : (
              <PrinterRow key={x.info.id} printer={x} onPress={() => p.onOpenPrinter(x.info.id)} />
            ),
          )
        )}
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  chips: { gap: 8, paddingHorizontal: t.gutter, paddingBottom: t.space(1.5) },
  list: { borderTopWidth: 1, borderTopColor: t.color.lineSoft },
})
