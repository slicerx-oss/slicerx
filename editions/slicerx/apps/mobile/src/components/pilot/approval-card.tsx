// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Asks before a step that reaches a printer or changes a saved profile. Approve
// is a tap; the card never approves on its own.
import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { PERMISSION_LABELS, startsPrint, type ApprovalRequest } from '@slicerx/contracts'
import { Button } from '../button'
import { SwitchRow } from '../controls'
import { Icon } from '../icon'
import { Txt } from '../text'
import { font, t } from '../theme'
import { useApproval } from '../use-approval'
import { fmtClock, fmtCountdown, type ApprovalResolution } from './model'

export interface ApprovalCardProps {
  request: ApprovalRequest
  resolution: ApprovalResolution | null
  /** False for cards from a saved log: they cannot be answered. */
  actionable: boolean
  /** `bedClear` is true only when the person turned on the bed question, which a card that starts a print asks. */
  onApprove: (request: ApprovalRequest, opts: { bedClear: boolean }) => Promise<void>
  onDeny: (request: ApprovalRequest) => Promise<void>
  /** ApprovalView.requestedBy from @slicerx/pair: the device that asked, when it was not this one. */
  requestedBy?: string | undefined
  /** The reason this phone cannot approve it now. Deny stays. */
  blocked?: string | undefined
  /** A G-code line the hub checked: shown whole, wrapped, in a monospace font, never cut short. */
  code?: string | undefined
  /** Set when the request was answered somewhere else (in SlicerX, by a partner app, by the agent that asked): the card shows this instead of its buttons. */
  answered?: string | undefined
  /** Line above the title. Defaults to mimir's; a computer's own requests name the computer. */
  heading?: string | undefined
  /** Clock source, for tests. */
  now?: () => number
}

function ruleLabel(r: ApprovalRequest): string {
  return r.permission === 'read' ? 'Read' : PERMISSION_LABELS[r.permission].title
}

function resolvedText(r: ApprovalResolution): { text: string; ok: boolean } {
  if (r.decision.kind === 'approve') {
    return r.by === 'policy' ? { text: 'Approved by your Permissions setting', ok: true } : { text: `Approved by you at ${fmtClock(r.at)}`, ok: true }
  }
  if (r.by === 'expiry' || r.decision.reason === 'expired') return { text: 'Expired. Nothing was sent', ok: false }
  return { text: 'Denied. Nothing was sent', ok: false }
}

export function ApprovalCard({ request, resolution, actionable, onApprove, onDeny, requestedBy, blocked, code, answered, heading = 'mimir needs your approval', now = Date.now }: ApprovalCardProps) {
  const live = resolution === null && actionable && answered === undefined
  const expiresAt = Date.parse(request.expiresAt)
  const [shownAt] = useState(now)
  const [clock, setClock] = useState(shownAt)
  const [denying, setDenying] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const device = useApproval()
  const asksBed = startsPrint(request)
  const [bedClear, setBedClear] = useState(false)

  useEffect(() => {
    if (!live) return undefined
    const id = setInterval(() => setClock(now()), 1000)
    return () => clearInterval(id)
  }, [live, now])

  const left = Number.isNaN(expiresAt) ? null : expiresAt - clock
  const total = Number.isNaN(expiresAt) ? null : Math.max(1, expiresAt - shownAt)
  const expired = left !== null && left <= 0
  const busy = device.busy || denying

  const done = resolution ? resolvedText(resolution) : null
  return (
    <View style={styles.card} role="summary" aria-label="Approval request" testID={`approval-${request.id}`}>
      <View style={styles.top}>
        <Icon name="approval-required" size={16} color={t.color.purple} />
        <Txt variant="caption" tone="muted" style={{ flex: 1 }}>
          {heading}
        </Txt>
        <Txt variant="mono" tone="dim" style={{ fontSize: 11.5 }}>
          {ruleLabel(request)}
        </Txt>
      </View>
      <Txt variant="heading" style={{ paddingHorizontal: 16, paddingTop: 8 }}>
        {request.title}
      </Txt>
      {requestedBy ? (
        <Txt variant="caption" tone="dim" style={{ paddingHorizontal: 16, paddingTop: 2 }}>
          {`Asked from ${requestedBy}`}
        </Txt>
      ) : null}
      {request.lines.length > 0 ? (
        <View style={styles.lines}>
          {request.lines.map((l, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
              <View style={styles.bullet} />
              <Txt variant="caption" tone="muted" style={{ flex: 1, fontSize: 15, lineHeight: 22 }}>
                {l}
              </Txt>
            </View>
          ))}
        </View>
      ) : null}
      {code !== undefined ? (
        <View style={styles.code} testID="approval-code">
          <Txt variant="caption" tone="dim">
            G-code line
          </Txt>
          <Txt variant="mono" selectable style={{ fontSize: 14, lineHeight: 20 }}>
            {code}
          </Txt>
        </View>
      ) : null}
      {live && blocked ? (
        <Txt variant="caption" color={t.color.orange} style={{ paddingHorizontal: 16, paddingTop: 10 }} testID="approval-blocked">
          {blocked}
        </Txt>
      ) : null}
      {live && asksBed && !blocked ? (
        <View style={{ paddingHorizontal: 16 }}>
          <SwitchRow title="The build plate is clear" detail="And the right plate is on the printer" value={bedClear} onChange={setBedClear} testID="approval-bed-clear" />
        </View>
      ) : null}
      {live ? (
        <>
          <View style={styles.actions}>
            {blocked ? null : (
              <Button
                label="Approve"
                kind="primary"
                icon="approve"
                block
                busy={device.busy}
                disabled={busy || expired || (asksBed && !bedClear)}
                testID="approval-approve"
                onPress={() => {
                  setNote(null)
                  void device.approve(() => onApprove(request, { bedClear: asksBed && bedClear }))
                }}
              />
            )}
            <Button
              label="Deny"
              kind="secondary"
              disabled={busy}
              testID="approval-deny"
              onPress={() => {
                setDenying(true)
                setNote(null)
                onDeny(request)
                  .catch((e: unknown) => setNote(`Could not send your answer: ${e instanceof Error ? e.message : String(e)}`))
                  .finally(() => setDenying(false))
              }}
            />
          </View>
          <Txt variant="caption" tone="dim" style={{ paddingHorizontal: 16, paddingBottom: 14 }} aria-live="polite">
            {note ?? device.error ?? (left === null ? '' : expired ? 'Expired' : `Expires in ${fmtCountdown(left)}`)}
          </Txt>
          {left !== null && total !== null ? (
            <View style={styles.timer} aria-hidden>
              <View style={{ height: 2, width: `${Math.max(0, Math.min(1, left / total)) * 100}%`, backgroundColor: t.color.cyan, opacity: 0.7 }} />
            </View>
          ) : null}
        </>
      ) : done ? (
        <View style={styles.res} testID="approval-resolved">
          {done.ok ? <Icon name="check" size={16} color={t.color.green} /> : null}
          <Txt variant="caption" color={done.ok ? t.color.green : t.color.dim} style={{ fontFamily: font.bodyMedium }}>
            {done.text}
          </Txt>
        </View>
      ) : answered !== undefined ? (
        <View style={styles.res} testID="approval-answered" aria-live="polite">
          <Txt variant="caption" tone="dim" style={{ fontFamily: font.bodyMedium }}>
            {answered}
          </Txt>
        </View>
      ) : (
        <Txt variant="caption" tone="dim" style={{ padding: 16 }}>
          Waiting for an answer
        </Txt>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: t.color.purpleEdge, backgroundColor: t.color.purpleTint, borderRadius: t.radius.md + 2, overflow: 'hidden' },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 14 },
  lines: { paddingHorizontal: 16, paddingTop: 6, gap: 4 },
  code: { marginHorizontal: 16, marginTop: 8, padding: 10, gap: 4, borderRadius: t.radius.sm, borderWidth: 1, borderColor: t.color.lineSoft, backgroundColor: t.color.ink0 },
  bullet: { width: 5, height: 5, borderRadius: 3, backgroundColor: t.color.line, marginTop: 9 },
  actions: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  res: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 14 },
  timer: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 2 },
})
