// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The chip mimir shows before it saves a note about the person (memory.remember), in place of the approval card: the
// note in their words, Remember and Not now. Remember approves the call, which saves through the app's one memory
// handle (pilot-connect/memory-store.ts); Not now declines it and nothing is kept.
import type { ApprovalCardProps } from '@slicerx/pilot/ui'
import { Button, Icon } from '@slicerx/ui'
import { useState, type ComponentType } from 'react'
import { openSettings } from '../../state/store'

function outcome(p: ApprovalCardProps): { word: string; ok: boolean } | null {
  const r = p.resolution
  if (r) return r.decision.kind === 'approve' ? { word: 'Remembered', ok: true } : { word: 'Not saved', ok: false }
  return p.actionable ? null : { word: 'Not answered', ok: false }
}

export function RememberChip(p: ApprovalCardProps) {
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const done = outcome(p)
  const live = done === null
  // the note, then its values ("Nozzle mm: 0.4"), then where it is kept
  const [text, ...rest] = p.request.lines
  const hint = rest.length ? rest[rest.length - 1] : undefined
  const values = rest.slice(0, -1)
  const answer = (which: 'yes' | 'no'): void => {
    setBusy(which)
    setNote(null)
    const sent = which === 'yes' ? p.onApprove(p.request, { bedClear: false }) : p.onCancel(p.request)
    sent.catch((e: unknown) => {
      setBusy(null)
      setNote(`Could not send your answer: ${e instanceof Error ? e.message : String(e)}`)
    })
  }
  // the buttons and the outcome share one cell, so answering swaps them with nothing around it moving
  return (
    <div className="mem-chip" role="group" aria-label={p.request.title} data-testid="mimir-remember" data-done={done ? (done.ok ? 'saved' : 'dropped') : undefined}>
      <Icon name="bookmark" className="mem-chip-ic" />
      <div className="mem-chip-body">
        <span className="mem-chip-q">{p.request.title}</span>
        <span className="mem-chip-note">{text}</span>
        {values.length ? <span className="mem-chip-values">{values.join(', ')}</span> : null}
        {hint ? <span className="mem-chip-hint">{hint}</span> : null}
        <div className="mem-chip-a">
          <div data-on={live || undefined} inert={!live || undefined}>
            <Button size="sm" variant="primary" busy={busy === 'yes'} disabled={busy !== null} data-testid="mimir-remember-yes" onClick={() => answer('yes')}>
              Remember
            </Button>
            <Button size="sm" variant="ghost" busy={busy === 'no'} disabled={busy !== null} data-testid="mimir-remember-no" onClick={() => answer('no')}>
              Not now
            </Button>
            {note ? <span className="mem-chip-err">{note}</span> : null}
          </div>
          <div data-on={!live || undefined} inert={live || undefined} role="status">
            {done?.ok ? <Icon name="check" /> : null}
            <span>{done?.word ?? ''}</span>
            {done?.ok ? (
              <Button size="sm" variant="ghost" onClick={() => openSettings('memory')}>
                See all notes
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/** The dock's own cards by tool name (ApprovalHandlers.cards). */
export const MEMORY_CARDS: Readonly<Record<string, ComponentType<ApprovalCardProps>>> = { 'memory.remember': RememberChip }
