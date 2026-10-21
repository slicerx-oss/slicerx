// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// When the phone's mimir tab folds its view for a card: while a run waits on the person for a print or change to
// approve or a question to answer, and not for a size sheet, a card already answered or a run that has ended.
import type { PilotEvent } from '@slicerx/contracts'
import { emptyTranscript, foldEvents, startTurn } from '@slicerx/pilot/ui'
import { describe, expect, it } from 'vitest'
import { cardWaits } from '../src/workspaces/mimir/card-waits'

const request = { id: 'apr_1', sessionId: 's', tool: 'printer.queue', permission: 'queue' as const, title: 'Print on Bay 6?', lines: [], paramsHash: 'x', actions: [], expiresAt: new Date(Date.now() + 60_000).toISOString() }
const ask = { type: 'ask', askId: 'ask_1', title: 'Confirm the part', question: 'Is this the thermostat on your wall?', choices: [{ id: 'same', label: 'Yes, that one' }] } as PilotEvent
const sheet = { type: 'sheet', sheet: { id: 'sh_1', title: 'Clip sizes', dims: [] } } as unknown as PilotEvent
const done = { type: 'done', stopReason: 'end', ms: 10 } as PilotEvent

const run = (events: PilotEvent[]) => foldEvents(events, startTurn(emptyTranscript(), { user: 'Print this on my Bay 6' }, 0))

describe('cardWaits', () => {
  it('is off for an empty chat and a run with nothing to answer', () => {
    expect(cardWaits(emptyTranscript())).toBe(false)
    expect(cardWaits(run([]))).toBe(false)
  })

  it('is on while a print waits for approval, and off once it is answered', () => {
    const waiting = run([{ type: 'approval_request', request } as PilotEvent])
    expect(cardWaits(waiting)).toBe(true)
    const answered = foldEvents([{ type: 'approval_resolved', requestId: 'apr_1', decision: { kind: 'approve' }, by: 'user' } as PilotEvent], waiting)
    expect(cardWaits(answered)).toBe(false)
  })

  it('is on while a question waits, and off once it is picked', () => {
    const waiting = run([ask])
    expect(cardWaits(waiting)).toBe(true)
    expect(cardWaits(foldEvents([{ type: 'ask_answered', askId: 'ask_1', choiceId: 'same' } as PilotEvent], waiting))).toBe(false)
  })

  it('leaves a waiting size sheet to the view, since its drawing is there', () => {
    expect(cardWaits(run([sheet]))).toBe(false)
  })

  it('is off once the run has ended, even with a question left unanswered', () => {
    expect(cardWaits(run([ask, done]))).toBe(false)
    expect(cardWaits(run([{ type: 'approval_request', request } as PilotEvent, done]))).toBe(false)
  })

  it('ignores cards replayed from a saved chat', () => {
    const replayed = run([ask])
    const turns = replayed.turns.map((t) => ({ ...t, blocks: t.blocks.map((b) => (b.kind === 'choice' ? { ...b, replay: true } : b)) }))
    expect(cardWaits({ ...replayed, turns })).toBe(false)
  })
})
