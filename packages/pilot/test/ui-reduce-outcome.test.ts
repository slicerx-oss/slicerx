// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An approved card learns how its call went: the call that follows the approval is the card's, null while it runs, then
// its row's ok and line, so a host's send card can say Sending and then Sent. A run stopped in the middle says so. A
// denied card, and a call of another tool, never take the outcome.
import type { ApprovalRequest, PilotEvent } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { emptyTranscript, reduceTranscript, startTurn, type Block, type Transcript } from '../ui/reduce'

const T0 = 1_000_000
const REQUEST: ApprovalRequest = { id: 'apr_1', sessionId: 's', tool: 'printer.queue', permission: 'start', title: 'Send plate 1 to Bay 2?', lines: [], paramsHash: 'h', actions: [], expiresAt: new Date(T0 + 300_000).toISOString() }

const begin = (): Transcript => startTurn(emptyTranscript(), { user: 'Print it' }, T0)
const fold = (events: PilotEvent[], s: Transcript = begin()): Transcript => events.reduce((acc, e) => reduceTranscript(acc, e, T0 + 100), s)
const card = (s: Transcript) => s.turns.flatMap((t) => t.blocks).find((b): b is Extract<Block, { kind: 'approval' }> => b.kind === 'approval')!

const asked: PilotEvent = { type: 'approval_request', request: REQUEST, source: 'plugin', builtin: true }
const approved: PilotEvent = { type: 'approval_resolved', requestId: 'apr_1', decision: { kind: 'approve', bedClear: true }, by: 'user' }
const called = (tool = 'printer.queue', callId = 'c1'): PilotEvent => ({ type: 'tool_call', callId, tool, source: 'plugin', input: {} })

describe('an approved card and its call', () => {
  it('has no outcome until its call starts, null while it runs, then the row ok and line', () => {
    let s = fold([asked, approved])
    expect(card(s).outcome).toBeUndefined()
    s = fold([called()], s)
    expect(card(s)).toMatchObject({ callId: 'c1', outcome: null })
    s = fold([{ type: 'tool_result', callId: 'c1', ok: true, summary: 'Plate 1 accepted on bay-2' }], s)
    expect(card(s).outcome).toEqual({ ok: true, summary: 'Plate 1 accepted on bay-2' })
  })

  it('a failed call is the outcome, and a run stopped mid call says so', () => {
    const failed = fold([asked, approved, called(), { type: 'tool_result', callId: 'c1', ok: false, summary: 'Preflight failed' }])
    expect(card(failed).outcome).toEqual({ ok: false, summary: 'Preflight failed' })
    const stopped = fold([asked, approved, called(), { type: 'done', stopReason: 'canceled', ms: 10 }])
    expect(card(stopped).outcome).toEqual({ ok: false, summary: 'Canceled' })
  })

  it('a denied card or a call of another tool takes no outcome', () => {
    const denied = fold([asked, { type: 'approval_resolved', requestId: 'apr_1', decision: { kind: 'deny', reason: 'canceled' }, by: 'user' }, called()])
    expect(card(denied).callId).toBeUndefined()
    const other = fold([asked, approved, called('printer.status', 'c2')])
    expect(card(other).callId).toBeUndefined()
  })
})
