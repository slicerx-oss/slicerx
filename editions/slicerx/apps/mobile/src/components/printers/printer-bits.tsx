// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printer status as rows and readouts: state pill, job progress, temperatures, filament slots and
// the camera snapshot.
import { useState, type ReactNode } from 'react'
import { Image, Pressable, StyleSheet, View } from 'react-native'
import { SvgXml } from 'react-native-svg'
import type { FilamentSlot, PrinterInfo, PrinterState, PrinterStatus, Temp } from '@slicerx/contracts'
import { IconButton } from '../button'
import { haptic } from '../feedback'
import { Icon, type IconName } from '../icon'
import { Pill, ProgressBar, Skeleton, type StatusTone } from '../status'
import { Txt } from '../text'
import { alpha, font, t } from '../theme'

export interface PrinterView {
  info: PrinterInfo
  /** Null until the first status arrives. */
  status: PrinterStatus | null
}

export function fmtLeft(s: number): string {
  const m = Math.max(0, Math.round(s / 60))
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

export function fmtTemp(v: Temp | undefined): string {
  if (!v) return '--'
  const cur = Math.round(v.current)
  return v.target > 0 ? `${cur} / ${Math.round(v.target)} \u00b0C` : `${cur} \u00b0C`
}

const STATE: Record<PrinterState, { tone: StatusTone; label: string }> = {
  idle: { tone: 'ok', label: 'Idle' },
  preparing: { tone: 'live', label: 'Preparing' },
  printing: { tone: 'live', label: 'Printing' },
  paused: { tone: 'attention', label: 'Paused' },
  finished: { tone: 'ok', label: 'Finished' },
  error: { tone: 'error', label: 'Error' },
  offline: { tone: 'off', label: 'Offline' },
}

export function stateTone(s: PrinterState): StatusTone {
  return STATE[s].tone
}

/** Sort key: what needs the person first, then live work, then ready, offline last. */
export const STATE_ORDER: Record<PrinterState, number> = { error: 0, paused: 1, printing: 2, preparing: 3, finished: 4, idle: 5, offline: 6 }

export function StatePill({ status }: { status: PrinterStatus | null }) {
  if (!status) return <Skeleton width={72} height={24} radius={12} />
  const s = STATE[status.state]
  const pct = status.state === 'printing' && status.progress !== undefined ? ` ${Math.round(status.progress * 100)}%` : ''
  return <Pill tone={s.tone} label={`${s.label}${pct}`} pulse={status.state === 'printing' || status.state === 'preparing'} testID="printer-state" />
}

export function JobProgress({ status, large }: { status: PrinterStatus; large?: boolean }) {
  if (status.progress === undefined) return null
  const warn = status.state === 'paused' || status.state === 'error'
  return (
    <View style={{ gap: 6 }}>
      <ProgressBar value={status.progress} tone={warn ? 'attention' : 'live'} height={large ? 6 : 4} label={`${status.jobName ?? 'Job'} progress`} />
      <View style={styles.progLine}>
        <Txt variant="mono" style={{ fontFamily: font.monoMedium }}>{`${Math.round(status.progress * 100)}%`}</Txt>
        {status.layer !== undefined && status.layerCount !== undefined ? (
          <Txt variant="mono" tone="muted">{`Layer ${status.layer} of ${status.layerCount}`}</Txt>
        ) : null}
        {status.timeLeftS !== undefined ? (
          <Txt variant="mono" tone="muted">
            {status.state === 'printing' ? `${fmtLeft(status.timeLeftS)} left` : `about ${fmtLeft(status.timeLeftS)} to go`}
          </Txt>
        ) : null}
      </View>
    </View>
  )
}

function TempItem({ icon, label, temp, offline }: { icon: IconName; label: string; temp: Temp | undefined; offline: boolean }) {
  const heating = temp !== undefined && temp.target > 0 && Math.abs(temp.target - temp.current) > 2
  return (
    <View style={styles.temp} accessible aria-label={`${label} ${offline ? 'unknown' : fmtTemp(temp)}`}>
      <Icon name={icon} size={16} color={heating ? t.color.orange : t.color.dim} />
      <Txt variant="mono" tone="muted">
        {offline ? '--' : fmtTemp(temp)}
      </Txt>
    </View>
  )
}

export function Temps({ status }: { status: PrinterStatus }) {
  const off = status.state === 'offline'
  return (
    <View style={styles.temps}>
      {status.nozzles.map((n, i) => (
        <TempItem key={i} icon="nozzle" label={status.nozzles.length > 1 ? `Nozzle ${i + 1}` : 'Nozzle'} temp={n} offline={off} />
      ))}
      <TempItem icon="bed-temp" label="Bed" temp={status.bed} offline={off} />
      {status.chamber ? <TempItem icon="chamber-temp" label="Chamber" temp={status.chamber} offline={off} /> : null}
    </View>
  )
}

export function Slots({ slots }: { slots: FilamentSlot[] }) {
  if (slots.length === 0) return null
  return (
    <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
      {slots.map((s) => (
        <View key={s.id} style={styles.slot} accessible aria-label={`Slot ${s.id}, ${s.material ?? 'empty'}${s.remainingPct !== undefined ? `, ${s.remainingPct}% left` : ''}`}>
          {/* The swatch is the spool's own color, reported by the printer. */}
          <View style={[styles.swatch, { backgroundColor: s.color ?? t.color.ink3 }]} />
          <View>
            <Txt variant="mono" style={{ fontSize: 12 }}>
              {s.material ?? 'Empty'}
            </Txt>
            <Txt variant="mono" tone="dim" style={{ fontSize: 11 }}>
              {s.remainingPct !== undefined ? `${s.id}  ${s.remainingPct}%` : s.id}
            </Txt>
          </View>
        </View>
      ))}
    </View>
  )
}

export interface PrinterRowProps {
  printer: PrinterView
  onPress: () => void
}

/** One printer in the list. Rows, not cards: hairlines between them and the status on the right. */
export function PrinterRow({ printer, onPress }: PrinterRowProps) {
  const { info, status } = printer
  const off = status?.state === 'offline'
  return (
    <Pressable
      role="button"
      accessibilityHint="Opens status, camera and controls"
      onPress={() => {
        haptic.tap()
        onPress()
      }}
      style={({ pressed }) => [styles.row, pressed ? { backgroundColor: t.color.ink1 } : null]}
      testID={`printer-${info.id}`}
    >
      <View style={styles.rowHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Txt variant="heading" numberOfLines={1} color={off ? t.color.muted : t.color.fg}>
            {info.name}
          </Txt>
          <Txt variant="caption" tone="muted" numberOfLines={1}>
            {`${info.vendor} ${info.model}${info.filamentSystem ? `, ${info.filamentSystem.toUpperCase()}` : ''}`}
          </Txt>
        </View>
        <StatePill status={status} />
      </View>
      {status ? (
        <>
          {status.jobName ? (
            <Txt variant="mono" tone={off ? 'dim' : 'fg'} numberOfLines={1}>
              {status.jobName}
            </Txt>
          ) : null}
          {status.message ? (
            <Txt variant="caption" color={status.state === 'offline' ? t.color.dim : t.color.orange} numberOfLines={2}>
              {status.message}
            </Txt>
          ) : null}
          {status.state === 'printing' || status.state === 'paused' || status.state === 'error' ? <JobProgress status={status} /> : null}
          <Temps status={status} />
        </>
      ) : (
        <View style={{ gap: 8 }}>
          <Skeleton width="60%" height={13} />
          <Skeleton width="40%" height={12} />
        </View>
      )}
    </Pressable>
  )
}

/** "Done by 15:29", from the time left and the clock. */
export function fmtEta(timeLeftS: number, now: number): string {
  const d = new Date(now + timeLeftS * 1000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const days = Math.floor((d.setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000)
  return days <= 0 ? `Done by ${hh}:${mm}` : days === 1 ? `Done tomorrow ${hh}:${mm}` : `Done in ${days} days`
}

/** Printers that show a camera tile on the Printers tab: anything but offline. */
export function showsStage(status: PrinterStatus | null): boolean {
  return status !== null && status.state !== 'offline'
}

export interface PrinterStageProps {
  printer: PrinterView
  /** The camera picture. The screen hands in a LiveView bound to the feed. */
  video: ReactNode
  /** An approval is waiting on this printer. */
  approvalWaiting?: boolean | undefined
  onPress: () => void
  now?: number | undefined
}

/**
 * One printer on the Printers tab: the camera with the state and time left over it, the job
 * progress along its bottom edge, then the name, the job and the temperatures underneath.
 */
export function PrinterStage({ printer, video, approvalWaiting, onPress, now = Date.now() }: PrinterStageProps) {
  const { info, status } = printer
  const s = status
  const running = s?.state === 'printing' || s?.state === 'preparing'
  const warn = s?.state === 'paused' || s?.state === 'error'
  const pct = s?.progress !== undefined ? Math.round(s.progress * 100) : null
  return (
    <Pressable
      role="button"
      accessibilityHint="Opens the camera, progress and controls"
      onPress={() => {
        haptic.tap()
        onPress()
      }}
      style={({ pressed }) => [styles.stage, pressed ? { opacity: 0.92 } : null]}
      testID={`printer-${info.id}`}
    >
      <View style={styles.stageVideo}>
        {video}
        <View style={styles.stagePill}>
          {approvalWaiting ? <Pill tone="accent" label="Approval waiting" testID="approval-pill" /> : <StatePill status={status} />}
        </View>
        {s && pct !== null && (running || warn) ? (
          <>
            <View style={styles.stageCaption}>
              {s.timeLeftS !== undefined ? (
                <Txt variant="mono" color={t.color.fg} style={{ fontFamily: font.monoMedium }}>
                  {running ? `${fmtLeft(s.timeLeftS)} left` : s.message ?? 'Waiting for you'}
                </Txt>
              ) : (
                <View />
              )}
              <Txt variant="mono" color={t.color.fg} style={{ fontFamily: font.monoMedium }}>{`${pct}%`}</Txt>
            </View>
            <View style={styles.stageTrack} accessible role="progressbar" aria-label={`${s.jobName ?? 'Job'} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <View style={{ width: `${pct}%`, height: '100%', backgroundColor: warn ? t.color.orange : t.color.cyan }} />
            </View>
          </>
        ) : null}
      </View>
      <View style={styles.stageHead}>
        <Txt variant="heading" numberOfLines={1} style={{ flexShrink: 0 }}>
          {info.name}
        </Txt>
        <Txt variant="caption" tone="muted" numberOfLines={1} style={{ flex: 1, textAlign: 'right' }}>
          {`${info.vendor} ${info.model}`}
        </Txt>
      </View>
      {s?.jobName ? (
        <Txt variant="mono" tone="fg" numberOfLines={1}>
          {s.jobName}
        </Txt>
      ) : s?.state === 'idle' ? (
        <Txt variant="caption" tone="muted">
          Ready for a print
        </Txt>
      ) : null}
      {s?.message && !(warn && pct !== null) ? (
        <Txt variant="caption" color={t.color.orange} numberOfLines={2}>
          {s.message}
        </Txt>
      ) : null}
      {s ? (
        <View style={styles.stageFoot}>
          <Temps status={s} />
          {running && s.timeLeftS !== undefined ? (
            <Txt variant="mono" tone="dim">
              {fmtEta(s.timeLeftS, now)}
            </Txt>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  )
}

const SVG_DATA = /^data:image\/svg\+xml((?:;[^,;]*)*),/

/**
 * The SVG markup inside a data:image/svg+xml URI, or null for any other URI. The demo fleet sends
 * its snapshots this way; React Native's Image cannot draw SVG, so these go through SvgXml.
 */
export function svgFromDataUri(uri: string): string | null {
  const m = SVG_DATA.exec(uri)
  if (!m) return null
  const body = uri.slice(m[0].length)
  try {
    return (m[1] ?? '').split(';').includes('base64') ? atob(body) : decodeURIComponent(body)
  } catch {
    // A malformed payload shows the same empty state as a failed JPEG.
    return null
  }
}

export interface SnapshotProps {
  uri: string | null
  /** When the frame was taken, shown on the image. */
  takenAt: string | null
  loading: boolean
  available: boolean
  onRefresh: () => void
}

export function CameraSnapshot({ uri, takenAt, loading, available, onRefresh }: SnapshotProps) {
  const [failed, setFailed] = useState(false)
  const svg = uri ? svgFromDataUri(uri) : null
  return (
    <View style={styles.cam} testID="camera-snapshot">
      {!available ? (
        <View style={styles.camEmpty}>
          <Icon name="camera-off" size={26} color={t.color.dim} />
          <Txt variant="caption" tone="dim">
            No camera on this printer
          </Txt>
        </View>
      ) : loading && !uri ? (
        <Skeleton width="100%" height={220} radius={0} />
      ) : svg ? (
        <View style={styles.camImg} accessible role="img" aria-label="Latest camera snapshot" testID="snapshot-svg">
          <SvgXml xml={svg} width="100%" height="100%" preserveAspectRatio="xMidYMid slice" />
        </View>
      ) : uri && !failed && !SVG_DATA.test(uri) ? (
        <Image source={{ uri }} style={styles.camImg} resizeMode="cover" aria-label="Latest camera snapshot" onError={() => setFailed(true)} />
      ) : (
        <View style={styles.camEmpty}>
          <Icon name="camera" size={26} color={t.color.dim} />
          <Txt variant="caption" tone="dim">
            No snapshot yet
          </Txt>
        </View>
      )}
      {available ? (
        <View style={styles.camBar}>
          <Txt variant="mono" color={t.color.fg} style={{ fontSize: 12 }}>
            {takenAt ?? ''}
          </Txt>
          <IconButton
            icon="refresh"
            label="Take a new snapshot"
            color={t.color.fg}
            disabled={loading}
            onPress={() => {
              setFailed(false)
              onRefresh()
            }}
            testID="snapshot-refresh"
          />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: t.gutter, paddingVertical: t.space(2), gap: 10, borderBottomWidth: 1, borderBottomColor: t.color.lineSoft },
  stage: { paddingHorizontal: t.gutter, paddingTop: t.space(2), paddingBottom: t.space(2.5), gap: 6, borderBottomWidth: 1, borderBottomColor: t.color.lineSoft },
  stageVideo: { marginBottom: t.space(1) },
  stagePill: { position: 'absolute', top: 10, right: 10 },
  stageCaption: { position: 'absolute', left: 12, right: 12, bottom: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  stageTrack: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: alpha('#000000', 0.35) },
  stageHead: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  stageFoot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', paddingTop: 2 },
  rowHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  progLine: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  temps: { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
  temp: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  slot: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 72 },
  swatch: { width: 14, height: 22, borderRadius: 4, borderWidth: 1, borderColor: t.color.line },
  cam: { height: 220, backgroundColor: t.color.ink1, borderRadius: t.radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: t.color.lineSoft },
  camImg: { width: '100%', height: '100%' },
  camEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  camBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 12,
    backgroundColor: t.color.scrim,
  },
})
