// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { Button, Dialog, Eyebrow, Icon } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { CheckLines, checkLines } from '../send/check-lines'
import { useApp } from '../state/store'
import { allowsNote } from './approval-note'

/**
 * The only place a user-initiated side effect gets approved. Its buttons are the sole path to a token. Laid out like
 * the Print sheet: what it does in a flat card, one line per check, and a statement to confirm carried by the
 * approve button's own label, so pressing it is the answer. It opens with focus on its title, not a button, since a card
 * can arrive while someone is typing and one Enter must not approve. Tab goes to Deny first, then Approve, in the footer's order.
 */
export function ApprovalDialog() {
  const approval = useApp((s) => s.approval)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (approval) setBusy(false)
  }, [approval])
  const errors = approval?.checks?.errors ?? []
  const warnings = approval?.checks?.warnings ?? []
  const first = approval?.requests[0]
  const confirm = approval?.confirm
  const label = confirm ? (approval?.go ?? 'Confirm and approve') : 'Approve'
  return (
    <Dialog
      open={Boolean(approval && first)}
      required
      onClose={() => undefined}
      className="approve-dialog"
      focusPanel
      title={
        <>
          <Eyebrow className="approve-eyebrow">
            <Icon name="approve" size={16} /> Needs your approval
          </Eyebrow>
          <span className="approve-title">{first?.title}</span>
        </>
      }
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={() => void approval?.deny()}>
            Deny
          </Button>
          <Button
            variant="primary"
            icon={confirm ? 'bed-plate' : 'check'}
            disabled={busy || errors.length > 0}
            {...(errors.length ? { tip: { title: label, reason: 'Fix the problem above first.' } } : {})}
            onClick={() => {
              setBusy(true)
              void approval?.approve()
            }}
          >
            {label}
          </Button>
        </>
      }
    >
      {first?.lines.length ? (
        <ul className="approve-lines">
          {first.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : null}
      <CheckLines lines={checkLines(errors, warnings)} />
      <p className="approve-note">
        {confirm && errors.length === 0 ? `Pressing it confirms ${confirm.charAt(0).toLowerCase()}${confirm.slice(1)}. ` : ''}
        {approval ? allowsNote(approval) : ''}
      </p>
    </Dialog>
  )
}
