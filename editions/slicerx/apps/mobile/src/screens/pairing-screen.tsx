// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pairing: scan the QR code SlicerX shows on a computer (or type its code), check the six digits
// match on both screens, join an account from a device you already use, and manage paired hosts.
// Mirrors the @slicerx/pair client: the parent turns PairingFlow and PairingOutcome into `stage`.
import { useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import type { DevicePlatform, PairedHost, RemoteQuota, SliceWhere } from '@slicerx/pair'
import { Button, IconButton } from '../components/button'
import type { IconName } from '../components/icon'
import { EmptyState, Row, Screen, ScreenHeader, SectionLabel } from '../components/layout'
import { fmtWhen } from '../components/pilot/model'
import { QrScanner } from '../components/qr-scanner'
import { Sheet } from '../components/sheet'
import { Pill, SkeletonRows } from '../components/status'
import { Txt } from '../components/text'
import { font, t } from '../components/theme'

export interface PairedHostView {
  host: PairedHost
  online: boolean
  /** conn.info.slicing once connected; empty when unknown or offline. */
  slicing: readonly SliceWhere[]
}

/** A new device asking to join the account (client.watchJoinRequests). */
export interface JoinRequestView {
  requestId: string
  name: string
  platform: DevicePlatform
  /** False when review() would return null: this phone has no hosts it may introduce. */
  canReview: boolean
}

export type PairingStage =
  | { step: 'list' }
  | { step: 'scan' }
  | { step: 'type' }
  /** client.pair() is running and `sas` has not resolved. */
  | { step: 'connecting'; hostName?: string | undefined }
  /** client.joinAccount() is waiting for a device you already use to review it. */
  | { step: 'join-waiting' }
  /** `sas` resolved: "482 913". */
  | { step: 'confirm'; sas: string; hostName?: string | undefined }
  /** confirm() was tapped; waiting for `result`. */
  | { step: 'finishing' }
  | { step: 'done'; hostNames: string[] }
  /** An outcome reason (mismatch, expired, ...) or a PairError message. */
  | { step: 'error'; reason: string }

export type CameraPermission = 'granted' | 'denied' | 'undetermined'

export interface PairingScreenProps {
  hosts: PairedHostView[]
  loading: boolean
  joinRequests: JoinRequestView[]
  stage: PairingStage
  camera: CameraPermission
  onRequestCamera: () => void
  onStartScan: () => void
  onTypeCode: () => void
  /** The scanned QR string or the typed code; goes to client.pair(). */
  onCode: (input: string) => void
  onJoinAccount: () => void
  onReviewJoin: (requestId: string) => void
  /** flow.confirm() */
  onConfirm: () => void
  /** flow.reject(), also used for Cancel while a flow runs. */
  onReject: () => void
  /** Back to the list after done or error. */
  onReset: () => void
  onUnpair: (pairingId: string) => Promise<void>
  /** Sends removals the computer has not confirmed yet; resolves with how many went through. */
  onRetryRemovals?: () => Promise<number>
  /** The hub's relay quota when the phone reaches it away from home; null or absent at home. */
  quota?: RemoteQuota | null
  onBack: () => void
  refreshing: boolean
  onRefresh: () => void
  now?: number
}

const FAILURE: Record<string, string> = {
  mismatch: 'The codes did not match, so nothing was paired. Start again from the computer.',
  canceled: 'Pairing was canceled on one of the devices.',
  expired: 'That code expired. Show a new one on the computer and scan again.',
  busy: 'The computer is pairing with another device. Try again in a moment.',
  bad_proof: 'The computer could not prove it is the one that showed the code. Nothing was paired.',
  timeout: 'The computer stopped answering. Check it is awake and on the same network.',
  closed: 'The connection closed before pairing finished.',
  protocol: 'This version of SlicerX cannot pair with that computer. Update both and try again.',
}

/** A known outcome reason in plain words; anything else is already a message from PairError. */
export function pairFailureMessage(reason: string): string {
  return FAILURE[reason] ?? reason
}

/** "482913" to "482 913". The client already sends it grouped; this keeps raw digits readable too. */
export function groupCode(code: string): string {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

/** Formats a typed desktop code as XXXX-XXXX-XXXX while the person types. The client validates it. */
export function formatTypedCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
  return raw.match(/.{1,4}/g)?.join('-') ?? ''
}

const GB = 1024 ** 3
const MB = 1024 ** 2

/** "1.2 GB" or "340 MB". */
export function fmtQuotaBytes(n: number): string {
  return n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.round(n / MB)} MB`
}

/** "Account tier: 340 MB of 5.0 GB used this month, resets on Nov 1". */
export function quotaSummary(q: RemoteQuota): string {
  const resets = new Date(q.resetsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return `${fmtQuotaBytes(q.used)} of ${fmtQuotaBytes(q.cap)} used this month, resets ${resets}`
}

const PLATFORM: Record<DevicePlatform, { icon: IconName; label: string }> = {
  desktop: { icon: 'desktop', label: 'SlicerX desktop' },
  web: { icon: 'laptop', label: 'SlicerX in a browser' },
  link: { icon: 'server', label: 'SlicerX Link' },
  ios: { icon: 'phone', label: 'iPhone' },
  android: { icon: 'phone', label: 'Android phone' },
}

const WHERE: Record<SliceWhere, string> = { host: 'slices here', cloud: 'slices in the cloud', phone: 'slices on this phone' }

function hostDetail(v: PairedHostView, now: number): string {
  const h = v.host
  const seen = v.online ? 'online' : h.lastSeenAt !== undefined ? `seen ${fmtWhen(new Date(h.lastSeenAt).toISOString(), now)}` : 'not seen yet'
  return [PLATFORM[h.platform].label, seen, h.accountLinked ? 'account' : null].filter(Boolean).join('  ')
}

export function PairingScreen(p: PairingScreenProps) {
  const [unpairing, setUnpairing] = useState<PairedHostView | null>(null)
  const [unpairBusy, setUnpairBusy] = useState(false)
  const [unpairError, setUnpairError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [typed, setTyped] = useState('')
  const now = p.now ?? Date.now()
  const s = p.stage
  const inFlow = s.step === 'connecting' || s.step === 'join-waiting' || s.step === 'confirm' || s.step === 'finishing'

  const header = (
    <ScreenHeader
      title={s.step === 'list' ? 'Paired devices' : 'Pair a computer'}
      leading={
        <IconButton
          icon="chevron-left"
          label={inFlow ? 'Cancel pairing' : 'Back'}
          onPress={s.step === 'list' ? p.onBack : inFlow ? p.onReject : p.onReset}
          color={t.color.fg}
        />
      }
    />
  )

  let body
  if (s.step === 'scan') {
    body =
      p.camera === 'granted' ? (
        <View style={styles.pad}>
          <QrScanner onScanned={p.onCode} />
          <Steps />
          <Button label="Type the code instead" kind="ghost" onPress={p.onTypeCode} testID="pair-type" style={{ marginTop: t.space(2) }} />
        </View>
      ) : (
        <EmptyState
          icon="camera"
          title="Camera access needed"
          detail={p.camera === 'denied' ? 'Allow camera access for SlicerX in Settings, or type the code instead.' : 'SlicerX uses the camera only to read the pairing code.'}
          action={
            <View style={{ gap: 8 }}>
              {p.camera === 'denied' ? null : <Button label="Allow camera" kind="primary" onPress={p.onRequestCamera} />}
              <Button label="Type the code instead" kind="ghost" onPress={p.onTypeCode} testID="pair-type" />
            </View>
          }
        />
      )
  } else if (s.step === 'type') {
    const ready = typed.replace(/-/g, '').length === 12
    body = (
      <View style={[styles.pad, { gap: t.space(1.5), paddingTop: t.space(2) }]}>
        <Txt variant="body" tone="muted">
          Type the code under the QR code on your computer.
        </Txt>
        <TextInput
          nativeID="pair-code-input"
          testID="pair-code-input"
          aria-label="Pairing code"
          value={typed}
          onChangeText={(v) => setTyped(formatTypedCode(v))}
          placeholder="XXXX-XXXX-XXXX"
          placeholderTextColor={t.color.dim}
          selectionColor={t.color.purple}
          keyboardAppearance="dark"
          autoCapitalize="characters"
          autoCorrect={false}
          autoFocus
          returnKeyType="go"
          onSubmitEditing={() => {
            if (ready) p.onCode(typed)
          }}
          style={styles.codeInput}
        />
        <Button label="Pair" kind="primary" size="lg" block disabled={!ready} onPress={() => p.onCode(typed)} testID="pair-code-submit" />
      </View>
    )
  } else if (s.step === 'connecting') {
    body = <EmptyState icon="link" title={s.hostName ? `Connecting to ${s.hostName}` : 'Connecting'} detail="Keep SlicerX open on your computer." action={<Button label="Cancel" kind="ghost" onPress={p.onReject} />} />
  } else if (s.step === 'join-waiting') {
    body = (
      <EmptyState
        icon="shield"
        title="Waiting for approval on a device you already use"
        detail="Open SlicerX on a phone or computer that is already in your account and review this request."
        action={<Button label="Cancel" kind="ghost" onPress={p.onReject} testID="join-cancel" />}
      />
    )
  } else if (s.step === 'confirm') {
    body = (
      <View style={[styles.pad, { gap: t.space(2), paddingTop: t.space(3) }]} testID="pair-confirm">
        <Txt variant="body" tone="muted" align="center">
          {s.hostName ? `Does ${s.hostName} show these digits?` : 'Does the other screen show these digits?'}
        </Txt>
        <Txt align="center" style={styles.code} aria-label={`Code ${s.sas.replace(/\D/g, '').split('').join(' ')}`} testID="pair-code">
          {groupCode(s.sas)}
        </Txt>
        <Txt variant="caption" tone="dim" align="center">
          If they differ, someone else may be on your network. Do not pair.
        </Txt>
        <View style={{ gap: 8, marginTop: t.space(2) }}>
          <Button label="They match" icon="check" kind="primary" size="lg" block onPress={p.onConfirm} testID="pair-match" />
          <Button label="They do not match" kind="secondary" size="lg" block onPress={p.onReject} testID="pair-mismatch" />
        </View>
      </View>
    )
  } else if (s.step === 'finishing') {
    body = <EmptyState icon="link" title="Finishing" detail="Saving the pairing on both devices." />
  } else if (s.step === 'done') {
    const names = s.hostNames.join(', ')
    body = (
      <EmptyState
        icon="check"
        title={names ? `Paired with ${names}` : 'Paired'}
        detail="Its printers and mimir are now on this phone."
        action={<Button label="Done" kind="primary" onPress={p.onReset} testID="pair-done" />}
      />
    )
  } else if (s.step === 'error') {
    body = (
      <EmptyState
        icon="unlink"
        title="Pairing did not finish"
        detail={pairFailureMessage(s.reason)}
        action={<Button label="Try again" icon="qr" kind="primary" onPress={p.onStartScan} testID="pair-retry" />}
      />
    )
  } else {
    body = (
      <>
        <View style={[styles.pad, { gap: 8 }]}>
          <Button label="Pair a computer" icon="qr" kind="primary" size="lg" block onPress={p.onStartScan} testID="pair-start" />
          <Button label="Join my account from another device" icon="shield" kind="ghost" block onPress={p.onJoinAccount} testID="join-account" />
        </View>

        {p.joinRequests.length > 0 ? (
          <>
            <SectionLabel label="Wants to join your account" />
            {p.joinRequests.map((r) => (
              <Row
                key={r.requestId}
                icon={PLATFORM[r.platform].icon}
                iconColor={t.color.purple}
                title={r.name}
                detail={r.canReview ? PLATFORM[r.platform].label : 'Review it from a device that can add it to your computers'}
                trailing={r.canReview ? <Button label="Review" kind="secondary" onPress={() => p.onReviewJoin(r.requestId)} testID={`join-review-${r.requestId}`} /> : undefined}
                testID={`join-${r.requestId}`}
              />
            ))}
          </>
        ) : null}

        <SectionLabel label="This phone is paired with" />
        {p.loading ? (
          <SkeletonRows count={2} />
        ) : p.hosts.length === 0 ? (
          <EmptyState icon="desktop" title="No paired devices" detail="In SlicerX on your computer, open Settings, then Phone, to show a pairing code." />
        ) : (
          p.hosts.map((v) => (
            <Row
              key={v.host.pairingId}
              icon={PLATFORM[v.host.platform].icon}
              iconColor={v.online ? t.color.fg : t.color.dim}
              title={v.host.name}
              detail={[hostDetail(v, now), ...v.slicing.map((w) => WHERE[w])].join('  ')}
              mono
              trailing={
                v.host.pendingRemoval ? <Pill tone="attention" label="Removal pending" /> : v.host.pendingIntroduction ? <Pill tone="attention" label="Waiting" /> : v.slicing.includes('host') ? <Pill tone="accent" label="Slices" /> : undefined
              }
              onPress={() => setUnpairing(v)}
              accessibilityHint="Opens the option to unlink"
              testID={`host-${v.host.pairingId}`}
            />
          ))
        )}

        {p.hosts.some((v) => v.host.pendingRemoval) && p.onRetryRemovals ? (
          <View style={[styles.pad, { gap: 8 }]}>
            <Txt variant="caption" color={t.color.dim}>
              Some computers have not confirmed that this phone was unlinked. They keep trusting it until they hear about it.
            </Txt>
            <Button
              label="Retry removal"
              icon="unlink"
              kind="secondary"
              block
              busy={retrying}
              testID="retry-removals"
              onPress={() => {
                const retry = p.onRetryRemovals
                if (!retry) return
                setRetrying(true)
                void retry().finally(() => setRetrying(false))
              }}
            />
          </View>
        ) : null}

        {p.quota ? (
          <>
            <SectionLabel label="Remote access" />
            <Row
              icon="shield"
              title={p.quota.tier === 'account' ? 'Account tier' : 'Free tier'}
              detail={`${quotaSummary(p.quota)}. ${p.quota.connections} of ${p.quota.maxConnections} connections in use`}
              testID="remote-quota"
            />
          </>
        ) : null}
      </>
    )
  }

  return (
    <Screen header={header} refreshing={p.refreshing} onRefresh={s.step === 'list' ? p.onRefresh : undefined} testID="pairing-screen">
      {body}
      <Sheet
        open={unpairing !== null}
        onClose={() => {
          setUnpairing(null)
          setUnpairError(null)
        }}
        title={unpairing ? `Unlink ${unpairing.host.name}?` : undefined}
        detail={
          unpairing?.online === false
            ? 'It is offline, so it hears about this when it next connects. This phone forgets it now'
            : 'This phone loses access to its printers and mimir until you pair again'
        }
        testID="unlink-sheet"
      >
        <View style={[styles.pad, { gap: 8 }]}>
          {unpairError ? (
            <Txt variant="caption" color={t.color.orange}>
              {unpairError}
            </Txt>
          ) : null}
          <Button
            label="Unlink"
            icon="unlink"
            kind="danger"
            size="lg"
            block
            busy={unpairBusy}
            testID="unlink-confirm"
            onPress={() => {
              if (!unpairing) return
              setUnpairBusy(true)
              setUnpairError(null)
              p.onUnpair(unpairing.host.pairingId)
                .then(() => setUnpairing(null))
                .catch((e: unknown) => setUnpairError(e instanceof Error ? e.message : 'Could not unlink. Try again'))
                .finally(() => setUnpairBusy(false))
            }}
          />
        </View>
      </Sheet>
    </Screen>
  )
}

function Steps() {
  const steps = ['Open SlicerX on your computer', 'Go to Settings, then Phone', 'Point this camera at the code']
  return (
    <View style={{ gap: 10, paddingTop: t.space(2.5) }}>
      {steps.map((x, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          <View style={styles.num}>
            <Txt variant="mono" tone="muted">{`${i + 1}`}</Txt>
          </View>
          <Txt variant="body" tone="muted">
            {x}
          </Txt>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: t.gutter },
  code: { fontFamily: font.monoMedium, fontSize: 44, lineHeight: 54, letterSpacing: 4, color: t.color.fg, fontVariant: ['tabular-nums'] },
  codeInput: {
    height: 56,
    paddingHorizontal: 16,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderColor: t.color.line,
    backgroundColor: t.color.ink2,
    color: t.color.fg,
    fontFamily: font.monoMedium,
    fontSize: 22,
    letterSpacing: 2,
    textAlign: 'center',
  },
  num: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, borderColor: t.color.line, alignItems: 'center', justifyContent: 'center' },
})
