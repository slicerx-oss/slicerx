// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The chip mimir shows before it saves a note about the person (memory.remember), in place of the approval card: the
// note in their words, Remember and Not now. Remember approves the call, which saves through the app's one memory
// handle (pilot-connect/memory.ts); Not now declines it and nothing is kept.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import type { ApprovalCardProps } from '@slicerx/pilot/ui'
import { Button, Icon } from '@slicerx/ui'
import { useEffect, useRef, useState, type ComponentType } from 'react'
import { openSettings } from '../../state/store'

/** What the chip says when its answer could not be delivered. */
export const REMEMBER_INACTIVE = `Nothing saved. Ask ${ASSISTANT_NAME} again.`

function outcome(p: ApprovalCardProps, inactive: boolean): { word: string; ok: boolean } | null {
  const r = p.resolution
  if (!r && inactive) return { word: REMEMBER_INACTIVE, ok: false }
  if (r) return r.decision.kind === 'approve' ? { word: 'Remembered', ok: true } : { word: 'Not saved', ok: false }
  return p.actionable ? null : { word: 'Not answered', ok: false }
}

export function RememberChip(p: ApprovalCardProps) {
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null)
  // an answer the app could not deliver: the request is gone, so the chip stops taking answers
  const [inactive, setInactive] = useState(false)
  const done = outcome(p, inactive)
  const live = done === null
  const box = useRef<HTMLDivElement>(null)
  // once the person's own answer lands, the buttons go and focus goes back to the chat's input line
  useEffect(() => {
    if (!done || busy === null) return
    const chat = box.current?.closest('.sx-pilot')
    chat?.querySelector<HTMLInputElement>('.term-in input[type="text"], .composer-text')?.focus({ preventScroll: true })
  }, [done, busy])
  // the note, then its values ("Nozzle mm: 0.4"), then where it is kept
  const [text, ...rest] = p.request.lines
  const hint = rest.length ? rest[rest.length - 1] : undefined
  const values = rest.slice(0, -1)
  const answer = (which: 'yes' | 'no'): void => {
    setBusy(which)
    const sent = which === 'yes' ? p.onApprove(p.request, { bedClear: false }) : p.onCancel(p.request)
    // no internal reason or id reaches the person: the chip is over, and asking again makes a new one
    sent.catch((e: unknown) => {
      console.warn('mimir: the remember answer did not land', e)
      setBusy(null)
      setInactive(true)
    })
  }
  // the buttons and the outcome share one cell, so answering swaps them with nothing around it moving
  return (
    <div ref={box} className="mem-chip" role="group" aria-label={p.request.title} data-testid="mimir-remember" data-done={done ? (done.ok ? 'saved' : 'dropped') : undefined}>
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

/** The mimir tab's own cards by tool name (ApprovalHandlers.cards). */
export const MEMORY_CARDS: Readonly<Record<string, ComponentType<ApprovalCardProps>>> = { 'memory.remember': RememberChip }
