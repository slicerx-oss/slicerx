// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Status line, toasts and the approval dialog. About and the shortcut list are in about.tsx, loaded on first open.
import { Button, Dialog, Eyebrow, Icon, Kbd, Logo, StatusLine, useToast } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { useCommands } from '../commands/registry'
import { useEdition, appName } from '../edition'
import { useHost } from '../host'
import { formatShortcut } from '../lib/keys'
import { CheckLines, checkLines } from '../send/check-lines'
import { set, useApp } from '../state/store'

/** One quiet slot for progress and warnings. Engine and graphics details live in About, under Diagnostics. */
export function Status() {
  const slice = useApp((s) => s.slice)
  const loading = useApp((s) => s.plateLoading)
  const arranging = useApp((s) => s.arranging)
  const items = [
    ...(slice.status === 'running' ? ['Slicing'] : []),
    ...(loading ? ['Loading the model'] : []),
    ...(arranging ? [arranging.total ? `Arranging, layout ${Math.min(arranging.done + 1, arranging.total)} of ${arranging.total}` : 'Arranging'] : []),
    ...(slice.status === 'done' && slice.result.warnings.length ? [`${slice.result.warnings.length} ${slice.result.warnings.length === 1 ? 'warning' : 'warnings'} in the last slice`] : []),
  ]
  if (!items.length) return null
  return <StatusLine items={items} />
}

/** Actions outside React post toasts through the store; this hands them to the ui ToastProvider. */
export function ToastBridge() {
  const t = useApp((s) => s.toast)
  const toast = useToast()
  useEffect(() => {
    if (t) toast(t.text, { ...(t.tone ? { tone: t.tone } : {}), ...(t.action ? { action: t.action, duration: 8000 } : {}) })
  }, [t, toast])
  return null
}

const PERMISSION_TEXT: Record<string, string> = {
  queue: 'send a file to the printer',
  start: 'heat and move the printer',
  profile: 'change a saved profile',
  slice: 'slice in this project',
  read: 'read data',
}

/**
 * The only place a user-initiated side effect gets approved. Its buttons are the sole path to a token. Laid out like
 * the Print sheet: what it does in a flat card, one line per check, and a statement to confirm carried by the
 * approve button's own label, so pressing it is the answer.
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
  const kinds = [...new Set(approval?.requests.map((r) => r.permission) ?? [])]
  const confirm = approval?.confirm
  const label = confirm ? (approval?.go ?? 'Confirm and approve') : 'Approve'
  return (
    <Dialog
      open={Boolean(approval && first)}
      required
      onClose={() => undefined}
      className="approve-dialog"
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
            autoFocus={errors.length === 0}
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
        Allows {appName()} to {kinds.map((k) => PERMISSION_TEXT[k] ?? k).join(' and ')}, once. The approval expires in 5 min.
      </p>
    </Dialog>
  )
}
