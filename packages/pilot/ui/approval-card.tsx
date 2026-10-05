// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useEffect, useRef, useState } from 'react'
import { PERMISSION_LABELS, startsPrint, type ApprovalRequest } from '@slicerx/contracts'
import { Button, Icon } from '@slicerx/ui'
import { fmtClock, fmtCountdown } from './format'
import type { ApprovalResolution } from './reduce'
import { ASSISTANT_NAME } from '../src/name'

export interface ApprovalCardProps {
  request: ApprovalRequest
  resolution: ApprovalResolution | null
  /** False for cards shown from a saved log: they cannot be answered. */
  actionable: boolean
  /** `bedClear` is true only when the person ticked the bed question, which a card that starts a print asks. */
  onApprove: (request: ApprovalRequest, opts: { bedClear: boolean }) => Promise<void>
  onCancel: (request: ApprovalRequest) => Promise<void>
  onEditPlan?: ((request: ApprovalRequest) => void) | undefined
}

function ruleLabel(request: ApprovalRequest): string {
  const title = request.permission === 'read' ? 'Read' : PERMISSION_LABELS[request.permission].title
  return `${title}: ask first`
}

function resolvedText(r: ApprovalResolution): { text: string; ok: boolean } {
  if (r.decision.kind === 'approve') {
    return r.by === 'policy' ? { text: 'Approved by your Permissions setting', ok: true } : { text: `Approved by you at ${fmtClock(r.at)}`, ok: true }
  }
  if (r.by === 'expiry' || r.decision.reason === 'expired') return { text: 'Expired, nothing was sent', ok: false }
  return { text: 'Canceled', ok: false }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Asks before a step that reaches a printer, changes a saved profile or spends money. Never approves on its own. */
export function ApprovalCard({ request, resolution, actionable, onApprove, onCancel, onEditPlan }: ApprovalCardProps) {
  const pending = resolution === null
  const live = pending && actionable
  const actionsRef = useRef<HTMLDivElement>(null)
  const focusApprove = (): void => actionsRef.current?.querySelector<HTMLButtonElement>('button[data-action=approve]')?.focus()
  const expiresAt = Date.parse(request.expiresAt)
  const [shownAt] = useState(() => Date.now())
  const [now, setNow] = useState(shownAt)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const asksBed = startsPrint(request)
  const [bedClear, setBedClear] = useState(false)

  useEffect(() => {
    if (live) focusApprove()
  }, [live])

  useEffect(() => {
    if (!live) return undefined
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live])

  const left = Number.isNaN(expiresAt) ? null : expiresAt - now
  const total = Number.isNaN(expiresAt) ? null : Math.max(1, expiresAt - shownAt)
  const expired = left !== null && left <= 0

  const answer = (fn: (r: ApprovalRequest) => Promise<void>): void => {
    setBusy(true)
    fn(request).catch((e: unknown) => {
      setBusy(false)
      setNote(`Could not send your answer: ${errorText(e)}`)
    })
  }

  const done = resolution ? resolvedText(resolution) : null
  return (
    <div className="appr" role="group" aria-label="Approval request">
      <div className="appr-top">
        <Icon name="approve" />
        <span>{ASSISTANT_NAME} needs your approval</span>
        <span className="rule">{ruleLabel(request)}</span>
      </div>
      <div className="appr-q">{request.title}</div>
      {request.lines.length > 0 ? (
        <ul className="appr-l">
          {request.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      ) : null}
      {live && asksBed ? (
        <label className="appr-bed">
          <input type="checkbox" checked={bedClear} onChange={(e) => setBedClear(e.target.checked)} /> The build plate is clear and the right plate is on it
        </label>
      ) : null}
      {live ? (
        <>
          <div className="appr-a" ref={actionsRef}>
            <Button data-action="approve" size="sm" variant="primary" icon="check" disabled={busy || expired || (asksBed && !bedClear)} onClick={() => { setBusy(true); onApprove(request, { bedClear: asksBed && bedClear }).catch((e: unknown) => { setBusy(false); setNote(`Could not send your answer: ${errorText(e)}`) }) }}>
              Approve
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                if (onEditPlan) onEditPlan(request)
                else setNote('Plan editing happens on the plate. Approve or cancel here.')
                focusApprove()
              }}
            >
              Edit plan
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => answer(onCancel)}>
              Cancel
            </Button>
            <span className="cd" aria-live="off">
              {note ?? (left === null ? '' : expired ? 'Expired' : `Expires in ${fmtCountdown(left)}`)}
            </span>
          </div>
          {left !== null && total !== null ? <div className="appr-t" aria-hidden="true" style={{ transform: `scaleX(${Math.max(0, Math.min(1, left / total))})` }} /> : null}
        </>
      ) : done ? (
        <div className={done.ok ? 'appr-res c-ok' : 'appr-res c-dim'}>
          {done.ok ? <Icon name="check" /> : null}
          <span>{done.text}</span>
        </div>
      ) : (
        <div className="appr-res c-dim">Waiting for an answer</div>
      )}
    </div>
  )
}
