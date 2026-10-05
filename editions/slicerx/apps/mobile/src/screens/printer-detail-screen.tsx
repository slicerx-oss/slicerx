// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One printer: the camera, the job's progress, temperatures and filament, and the controls. Pause
// and resume are one tap. Stop asks once, since it ends the print. An approval waiting on this
// printer sits above the controls and is answered with a tap. mimir is one tap away when the
// printer needs diagnosis.
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import type { ApprovalRequest, PrinterStatus, Temp } from '@slicerx/contracts'
import type { FeedView } from '../camera/use-feed'
import { ApproveSheet } from '../components/approve-sheet'
import { Button, IconButton } from '../components/button'
import { Hairline, Row, Screen, ScreenHeader, SectionLabel, Stat } from '../components/layout'
import { ApprovalCard } from '../components/pilot/approval-card'
import { LiveView } from '../components/printers/live-view'
import { fmtEta, fmtLeft, Slots, StatePill, type PrinterView } from '../components/printers/printer-bits'
import { ProgressBar } from '../components/status'
import { Txt } from '../components/text'
import { useApproval } from '../components/use-approval'
import { t } from '../components/theme'

export type PrinterControl = 'pause' | 'resume' | 'stop'

export interface WaitingApproval {
  id: string
  request: ApprovalRequest
  /** Who asked: mimir on a computer, another phone, the computer itself. */
  heading: string
  requestedBy?: string | undefined
  /** Why this phone may not approve it here (it came over the relay). */
  blocked?: string | undefined
  /** A G-code line the hub checked, shown whole in a monospace font. */
  code?: string | undefined
  decide: (decision: 'approve' | 'deny', opts?: { bedClear?: boolean }) => Promise<void>
}

export interface PrinterDetailScreenProps {
  printer: PrinterView
  feed: FeedView
  refreshing: boolean
  onRefresh: () => void
  /** Pause and resume run at once; stop is called after the person confirms. The host mints the token. */
  onControl: (action: PrinterControl) => Promise<void>
  onSendPrint: () => void
  /** Approvals waiting on this printer, oldest first. */
  approvals?: WaitingApproval[] | undefined
  /** Opens mimir with a question about this printer. */
  onAskPilot: (prompt: string) => void
  onBack: () => void
  /** Clock for "done by", for tests. */
  now?: number | undefined
}

/** The question mimir gets when the person asks about this printer. */
export function pilotPrompt(p: PrinterView): string {
  const s = p.status
  const name = p.info.name
  if (s?.state === 'paused') return `Why did ${name} pause${s.message ? ` (${s.message})` : ''}, and what should I check before resuming?`
  if (s?.state === 'error') return `${name} reports an error${s.message ? `: ${s.message}` : ''}. What should I check?`
  if (s?.state === 'offline') return `${name} is offline. How do I get it back?`
  return `How is ${name} doing?`
}

function stopCopy(printer: PrinterView): { title: string; lines: string[] } {
  const s = printer.status
  const job = s?.jobName ?? 'the current print'
  const at = s?.progress !== undefined ? ` at ${Math.round(s.progress * 100)}%` : ''
  return { title: `Stop the print on ${printer.info.name}?`, lines: [`Stops ${job}${at}`, 'This cannot be undone. The part stays on the bed'] }
}

function tempValue(v: Temp | undefined): { value: string; target: string | null; heating: boolean } {
  if (!v) return { value: '--', target: null, heating: false }
  const heating = v.target > 0 && Math.abs(v.target - v.current) > 2
  return { value: `${Math.round(v.current)} °C`, target: v.target > 0 ? `of ${Math.round(v.target)} °C` : null, heating }
}

function TempStat({ label, temp, off }: { label: string; temp: Temp | undefined; off: boolean }) {
  const v = off ? { value: '--', target: null, heating: false } : tempValue(temp)
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Stat label={label} value={v.value} color={v.heating ? t.color.orange : t.color.fg} />
      {v.target ? (
        <Txt variant="mono" tone="dim" numberOfLines={1}>
          {v.target}
        </Txt>
      ) : null}
    </View>
  )
}

function Progress({ status, now }: { status: PrinterStatus; now: number }) {
  if (status.progress === undefined) return null
  const warn = status.state === 'paused' || status.state === 'error'
  const pct = Math.round(status.progress * 100)
  return (
    <View style={{ gap: 8 }} testID="job-progress">
      <View style={styles.pctRow}>
        <Txt variant="monoLarge" color={warn ? t.color.orange : t.color.fg}>{`${pct}%`}</Txt>
        {status.timeLeftS !== undefined ? (
          <Txt variant="mono" tone="muted">
            {status.state === 'printing' ? `${fmtLeft(status.timeLeftS)} left` : `about ${fmtLeft(status.timeLeftS)} to go`}
          </Txt>
        ) : null}
      </View>
      <ProgressBar value={status.progress} tone={warn ? 'attention' : 'live'} height={6} label={`${status.jobName ?? 'Job'} progress`} />
      <View style={styles.pctRow}>
        {status.layer !== undefined && status.layerCount !== undefined ? <Txt variant="mono" tone="dim">{`Layer ${status.layer} of ${status.layerCount}`}</Txt> : <View />}
        {status.state === 'printing' && status.timeLeftS !== undefined ? (
          <Txt variant="mono" tone="dim">
            {fmtEta(status.timeLeftS, now)}
          </Txt>
        ) : null}
      </View>
    </View>
  )
}

export function PrinterDetailScreen(p: PrinterDetailScreenProps) {
  const [stopping, setStopping] = useState(false)
  const control = useApproval()
  const { info, status } = p.printer
  const state = status?.state
  const now = p.now ?? Date.now()
  const busy = state === 'printing' || state === 'preparing'
  const waiting = p.approvals ?? []
  const diagnose = state === 'paused' || state === 'error' || state === 'offline'

  const header = (
    <ScreenHeader
      title={info.name}
      subtitle={`${info.vendor} ${info.model}${info.filamentSystem ? `, ${info.filamentSystem.toUpperCase()}` : ''}`}
      leading={<IconButton icon="chevron-left" label="Back to printers" onPress={p.onBack} color={t.color.fg} />}
      actions={<StatePill status={status} />}
    />
  )

  return (
    <Screen header={header} refreshing={p.refreshing} onRefresh={p.onRefresh} testID="printer-detail">
      <View style={styles.pad}>
        <LiveView {...p.feed} name={info.name} available={status?.cameraAvailable === true && state !== 'offline'} testID="camera-live" />
      </View>

      {status ? (
        <>
          <View style={[styles.pad, { gap: 12, paddingTop: t.space(2.5) }]}>
            {status.jobName ? (
              <Txt variant="heading" numberOfLines={2}>
                {status.jobName}
              </Txt>
            ) : state === 'idle' ? (
              <Txt variant="heading" tone="muted">
                Ready for a print
              </Txt>
            ) : null}
            {status.message ? (
              <Txt variant="caption" color={state === 'offline' ? t.color.dim : t.color.orange} testID="printer-message">
                {status.message}
              </Txt>
            ) : null}
            <Progress status={status} now={now} />
          </View>

          {waiting.map((a) => (
            <View key={a.id} style={[styles.pad, { paddingTop: t.space(2) }]} testID={`waiting-${a.id}`}>
              <ApprovalCard
                request={a.request}
                resolution={null}
                actionable
                heading={a.heading}
                requestedBy={a.requestedBy}
                blocked={a.blocked}
                code={a.code}
                onApprove={(_r, o) => a.decide('approve', o)}
                onDeny={() => a.decide('deny')}
              />
            </View>
          ))}

          <View style={[styles.pad, styles.controls]}>
            {busy ? <Button label="Pause" icon="pause" busy={control.busy} onPress={() => void control.approve(() => p.onControl('pause'))} block testID="control-pause" /> : null}
            {state === 'paused' ? <Button label="Resume" icon="play" kind="primary" busy={control.busy} onPress={() => void control.approve(() => p.onControl('resume'))} block testID="control-resume" /> : null}
            {busy || state === 'paused' || state === 'error' ? <Button label="Stop" icon="stop" kind="danger" disabled={control.busy} onPress={() => setStopping(true)} block testID="control-stop" /> : null}
            {state === 'idle' || state === 'finished' ? <Button label="Print here" icon="send-to-printer" kind="primary" onPress={p.onSendPrint} block testID="control-send" /> : null}
          </View>
          {control.error ? (
            <Txt variant="caption" color={t.color.orange} style={[styles.pad, { paddingTop: t.space(1) }]} aria-live="polite" testID="control-error">
              {control.error}
            </Txt>
          ) : null}

          {diagnose ? (
            <View style={{ paddingTop: t.space(1.5) }}>
              <Row icon="pilot" iconColor={t.color.purple} title="Ask mimir" detail={pilotPrompt(p.printer)} chevron onPress={() => p.onAskPilot(pilotPrompt(p.printer))} testID="ask-pilot" />
            </View>
          ) : null}

          <SectionLabel label="Temperatures" />
          <View style={[styles.pad, styles.temps]}>
            {status.nozzles.map((n, i) => (
              <TempStat key={i} label={status.nozzles.length > 1 ? `Nozzle ${i + 1}` : 'Nozzle'} temp={n} off={state === 'offline'} />
            ))}
            <TempStat label="Bed" temp={status.bed} off={state === 'offline'} />
            {status.chamber ? <TempStat label="Chamber" temp={status.chamber} off={state === 'offline'} /> : null}
          </View>

          {status.slots.length > 0 ? (
            <>
              <SectionLabel label={info.filamentSystem ? `Filament, ${info.filamentSystem.toUpperCase()}` : 'Filament'} />
              <View style={styles.pad}>
                <Slots slots={status.slots} />
              </View>
            </>
          ) : null}

          {!diagnose ? (
            <>
              <Hairline style={{ marginTop: t.space(3) }} />
              <Row icon="pilot" title="Ask mimir" detail="Plan a print, compare settings, or ask about this printer" chevron onPress={() => p.onAskPilot(pilotPrompt(p.printer))} testID="ask-pilot" />
            </>
          ) : null}

          <Hairline />
          <Txt variant="mono" tone="dim" style={[styles.pad, { paddingTop: t.space(1.5), fontSize: 12 }]}>
            {`${info.plugin}${info.host ? `  ${info.host}` : ''}`}
          </Txt>
        </>
      ) : null}

      {stopping ? (
        <ApproveSheet
          open
          onClose={() => setStopping(false)}
          title={stopCopy(p.printer).title}
          lines={stopCopy(p.printer).lines}
          confirmLabel="Stop print"
          danger
          onConfirm={() => p.onControl('stop')}
          testID="control-sheet"
        />
      ) : null}
    </Screen>
  )
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: t.gutter },
  controls: { flexDirection: 'row', gap: 8, paddingTop: t.space(2.5) },
  pctRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  temps: { flexDirection: 'row', gap: t.space(2) },
})
