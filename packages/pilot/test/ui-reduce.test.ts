// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { ApprovalRequest, PilotEvent } from '@slicerx/contracts'
import {
  elapsedMs,
  emptyTranscript,
  foldEvents,
  pendingApprovals,
  reduceTranscript,
  runningTools,
  setReplaying,
  startTurn,
  type Block,
  type Transcript,
} from '../ui/reduce'
import { argTokens, barCells, fmtCountdown, fmtDuration, fmtTokens, fmtWhen, segs } from '../ui/format'

const T0 = 1_000_000

function begin(user = 'Plan 12 brackets'): Transcript {
  return startTurn(emptyTranscript(), { user, where: '~/brackets' }, T0)
}

function fold(events: PilotEvent[], s: Transcript = begin(), now = T0 + 500): Transcript {
  let out = s
  for (const e of events) out = reduceTranscript(out, e, now)
  return out
}

function blocks(s: Transcript): Block[] {
  return s.turns.at(-1)?.blocks ?? []
}

function kinds(s: Transcript): string[] {
  return blocks(s).map((b) => b.kind)
}

function call(callId: string, tool = 'slice', source: 'skill' | 'plugin' = 'skill'): PilotEvent {
  return { type: 'tool_call', callId, tool, source, input: {}, args: '--profile "0.20 Standard"' }
}

function result(callId: string, ok = true, ms = 800): PilotEvent {
  return { type: 'tool_result', callId, ok, summary: ok ? 'done' : 'failed', ms }
}

const REQUEST: ApprovalRequest = {
  id: 'apr_1',
  sessionId: 's1',
  tool: 'printer.queue',
  permission: 'queue',
  title: 'Send 2 plates to Bay 2 and Bay 3?',
  lines: ['Plate 1 on Bay 2', 'Plate 2 on Bay 3'],
  paramsHash: 'h',
  actions: [],
  expiresAt: new Date(T0 + 300_000).toISOString(),
}

describe('reduceTranscript', () => {
  it('opens a turn with the user bubble and a running status', () => {
    const s = begin('Diagnose the Bay 4 failure')
    expect(s.turns).toHaveLength(1)
    expect(s.turns[0]?.user).toBe('Diagnose the Bay 4 failure')
    expect(s.turns[0]?.where).toBe('~/brackets')
    expect(s.status).toBe('running')
    expect(s.clockStart).toBe(T0)
  })

  it('streams text into one say block and closes it on text_done', () => {
    let s = fold([
      { type: 'text', delta: 'Bay 3 ' },
      { type: 'text', delta: 'is cheapest.' },
    ])
    expect(kinds(s)).toEqual(['say'])
    expect(blocks(s)[0]).toMatchObject({ kind: 'say', text: 'Bay 3 is cheapest.', streaming: true })
    s = fold([{ type: 'text_done' }], s)
    expect(blocks(s)[0]).toMatchObject({ streaming: false })
    s = fold([{ type: 'text', delta: 'Next round.' }], s)
    expect(kinds(s)).toEqual(['say', 'say'])
  })

  it('streams thinking open, then records its duration on thinking_done', () => {
    let s = fold([
      { type: 'thinking', delta: 'Friday is three days out' },
      { type: 'thinking', delta: ', so cost decides.' },
    ])
    expect(blocks(s)[0]).toMatchObject({ kind: 'think', text: 'Friday is three days out, so cost decides.', ms: null })
    s = fold([{ type: 'thinking_done', ms: 3200 }], s)
    expect(blocks(s)[0]).toMatchObject({ kind: 'think', ms: 3200 })
    s = fold([{ type: 'thinking', delta: 'Second thought' }], s)
    expect(kinds(s)).toEqual(['think', 'think'])
  })

  it('groups consecutive tool calls and splits groups on prose, thinking or a diff', () => {
    const s = fold([
      call('c1', 'spoolman.check', 'plugin'),
      result('c1'),
      call('c2', 'bambu.lan.queue', 'plugin'),
      result('c2'),
      { type: 'text', delta: 'Two printers are idle.' },
      { type: 'text_done' },
      call('c3', 'orient'),
      result('c3'),
      { type: 'thinking', delta: 'hmm' },
      { type: 'thinking_done', ms: 900 },
      call('c4', 'arrange'),
      { type: 'settings_diff', diff: { title: 'Plate overrides', scope: 'plate', rows: [] } },
      call('c5', 'slice'),
      call('c6', 'slice'),
    ])
    expect(kinds(s)).toEqual(['tools', 'say', 'tools', 'think', 'tools', 'diff', 'tools'])
    const groups = blocks(s).filter((b): b is Extract<Block, { kind: 'tools' }> => b.kind === 'tools')
    expect(groups.map((g) => g.rows.map((r) => r.callId))).toEqual([['c1', 'c2'], ['c3'], ['c4'], ['c5', 'c6']])
  })

  it('keeps a tool row running until its result, then settles it', () => {
    let s = fold([call('c1')])
    const row = (): unknown => (blocks(s)[0] as Extract<Block, { kind: 'tools' }>).rows[0]
    expect(row()).toMatchObject({ state: 'running', summary: undefined, args: '--profile "0.20 Standard"' })
    expect(runningTools(s)).toEqual([{ tool: 'slice', source: 'skill' }])
    s = fold([{ type: 'tool_progress', callId: 'c1', line: 'plate 1', fraction: 0.4 }], s)
    expect(row()).toMatchObject({ progress: [{ line: 'plate 1', fraction: 0.4 }] })
    s = fold(
      [
        {
          type: 'tool_result',
          callId: 'c1',
          ok: true,
          summary: '2 plates, 4h 06m, 77.3 g',
          ms: 3400,
          untrusted: true,
          display: [{ kind: 'kv', rows: [['plates', '2']] }],
        },
      ],
      s,
    )
    expect(row()).toMatchObject({ state: 'ok', summary: '2 plates, 4h 06m, 77.3 g', ms: 3400, untrusted: true })
    expect(runningTools(s)).toEqual([])
  })

  it('marks a failed tool result as bad', () => {
    const s = fold([call('c1'), result('c1', false)])
    expect((blocks(s)[0] as Extract<Block, { kind: 'tools' }>).rows[0]?.state).toBe('bad')
  })

  it('shows an approval as pending, then resolved by the person with the time', () => {
    let s = fold([{ type: 'approval_request', request: REQUEST }])
    expect(pendingApprovals(s).map((r) => r.id)).toEqual(['apr_1'])
    s = reduceTranscript(s, { type: 'approval_resolved', requestId: 'apr_1', decision: { kind: 'approve' }, by: 'user' }, T0 + 9000)
    expect(pendingApprovals(s)).toEqual([])
    expect(blocks(s)[0]).toMatchObject({ kind: 'approval', resolution: { decision: { kind: 'approve' }, by: 'user', at: T0 + 9000 } })
  })

  it('records expiry and denial on the card', () => {
    const expired = fold([
      { type: 'approval_request', request: REQUEST },
      { type: 'approval_resolved', requestId: 'apr_1', decision: { kind: 'deny', reason: 'expired' }, by: 'expiry' },
    ])
    expect(blocks(expired)[0]).toMatchObject({ resolution: { by: 'expiry' } })
    const denied = fold([
      { type: 'approval_request', request: REQUEST },
      { type: 'approval_resolved', requestId: 'apr_1', decision: { kind: 'deny', reason: 'canceled' }, by: 'user' },
    ])
    expect(blocks(denied)[0]).toMatchObject({ resolution: { decision: { kind: 'deny', reason: 'canceled' } } })
  })

  it('ignores policy approvals that never had a card', () => {
    const s = fold([
      { type: 'permission_note', permission: 'queue', mode: 'allow', tool: 'printer.queue', message: 'Queue jobs is set to Allow in Permissions, so Pilot continued without asking.' },
      { type: 'approval_resolved', requestId: 'apr_x', decision: { kind: 'approve' }, by: 'policy' },
    ])
    expect(kinds(s)).toEqual(['perm'])
    expect(blocks(s)[0]).toMatchObject({ mode: 'allow' })
  })

  it('marks replayed approvals so they are not actionable', () => {
    const s = fold([{ type: 'approval_request', request: REQUEST }], startTurn(setReplaying(emptyTranscript(), true), {}, T0))
    expect(blocks(s)[0]).toMatchObject({ kind: 'approval', replay: true })
    expect(pendingApprovals(s)).toEqual([])
  })

  it('closes a canceled run: pending approvals canceled, running rows stopped, streams settled', () => {
    const s = fold([
      { type: 'thinking', delta: 'x' },
      call('c1'),
      { type: 'approval_request', request: REQUEST },
      { type: 'text', delta: 'partial' },
      { type: 'done', stopReason: 'canceled', ms: 4200 },
    ])
    expect(s.status).toBe('stopped')
    expect(pendingApprovals(s)).toEqual([])
    const b = blocks(s)
    expect(b[0]).toMatchObject({ kind: 'think', ms: 0 })
    expect((b[1] as Extract<Block, { kind: 'tools' }>).rows[0]).toMatchObject({ state: 'bad', summary: 'Canceled' })
    expect(b[2]).toMatchObject({ kind: 'approval', resolution: { decision: { kind: 'deny', reason: 'canceled' } } })
    expect(b[3]).toMatchObject({ kind: 'say', streaming: false })
  })

  it('counts steps, tool calls, tokens and elapsed time on the meter', () => {
    const s0 = fold([
      { type: 'start', runId: 'r1', sessionId: 's1', provider: 'openai', model: 'm', at: '2026-09-30T14:00:00Z' },
      { type: 'thinking', delta: 'a' },
      { type: 'thinking_done', ms: 100 },
      { type: 'usage', inputTokens: 1200, outputTokens: 300 },
      call('c1'),
      result('c1'),
      call('c2'),
      result('c2'),
      { type: 'text', delta: 'ok' },
      { type: 'text_done' },
      { type: 'usage', inputTokens: 900, outputTokens: 100 },
    ])
    expect(s0.meter).toEqual({ steps: 4, toolCalls: 2, tokens: 2500, elapsedMs: 0 })
    expect(s0.model).toBe('m')
    expect(elapsedMs(s0, T0 + 7000)).toBe(7000)
    const s1 = fold([{ type: 'summary', title: 'Queued', rows: [['Cost', '$2.72']], stopped: false }, { type: 'done', stopReason: 'end', ms: 72_000 }], s0)
    expect(s1.status).toBe('done')
    expect(s1.meter.elapsedMs).toBe(72_000)
    expect(elapsedMs(s1, T0 + 999_999)).toBe(72_000)
    expect(blocks(s1).at(-1)).toMatchObject({ kind: 'summary', ms: 72_000, stopped: false })
  })

  it('maps stop reasons to run status', () => {
    expect(fold([{ type: 'done', stopReason: 'error', ms: 1 }]).status).toBe('error')
    expect(fold([{ type: 'done', stopReason: 'denied', ms: 1 }]).status).toBe('stopped')
    expect(fold([{ type: 'done', stopReason: 'max_steps', ms: 1 }]).status).toBe('stopped')
  })

  it('shows plugins loading once and updates that line in place', () => {
    let s = fold([
      {
        type: 'plugins',
        plugins: [
          { id: 'moonraker', name: 'Moonraker', state: 'loading', tools: 3 },
          { id: 'octoprint', name: 'OctoPrint', state: 'loading', tools: 2 },
        ],
      },
    ])
    expect(kinds(s)).toEqual(['plugins'])
    s = fold(
      [
        {
          type: 'plugins',
          plugins: [
            { id: 'moonraker', name: 'Moonraker', state: 'ready', tools: 3 },
            { id: 'octoprint', name: 'OctoPrint', state: 'off', tools: 2 },
          ],
        },
      ],
      s,
    )
    expect(kinds(s)).toEqual(['plugins'])
    expect(blocks(s)[0]).toMatchObject({ plugins: [{ state: 'ready' }, { state: 'off' }] })
    expect(s.plugins?.map((p) => p.state)).toEqual(['ready', 'off'])
    const later = fold([{ type: 'plugins', plugins: [{ id: 'moonraker', name: 'Moonraker', state: 'ready', tools: 3 }] }])
    expect(kinds(later)).toEqual([])
    expect(later.plugins).toHaveLength(1)
  })

  it('merges citations without duplicates', () => {
    const s = fold([
      { type: 'text', delta: 'PETG likes 235 C.' },
      { type: 'text_done' },
      { type: 'citations', items: [{ id: 'kb_petg', title: 'PETG guide', kind: 'kb' }] },
      {
        type: 'citations',
        items: [
          { id: 'kb_petg', title: 'PETG guide', kind: 'kb' },
          { id: 'https://example.org/petg', title: 'PETG tips', url: 'https://example.org/petg', kind: 'web' },
        ],
      },
    ])
    expect(kinds(s)).toEqual(['say', 'citations'])
    expect((blocks(s)[1] as Extract<Block, { kind: 'citations' }>).items.map((c) => c.id)).toEqual(['kb_petg', 'https://example.org/petg'])
  })

  it('opens a turn for events that arrive without one, and a new turn per run in a saved log', () => {
    const log: PilotEvent[] = [
      { type: 'start', runId: 'r1', sessionId: 's', provider: 'p', model: 'm', at: '2026-09-30T14:00:00Z' },
      { type: 'text', delta: 'First' },
      { type: 'text_done' },
      { type: 'done', stopReason: 'end', ms: 1000 },
      { type: 'start', runId: 'r2', sessionId: 's', provider: 'p', model: 'm', at: '2026-09-30T14:05:00Z' },
      { type: 'text', delta: 'Second' },
      { type: 'done', stopReason: 'end', ms: 2000 },
    ]
    const s = foldEvents(log)
    expect(s.turns).toHaveLength(2)
    expect(s.turns.map((t) => t.user)).toEqual([null, null])
    expect(s.turns[1]?.blocks[0]).toMatchObject({ kind: 'say', text: 'Second', streaming: false })
  })

  it('keeps the turn opened by startTurn when the start event follows', () => {
    const s = fold([{ type: 'start', runId: 'r1', sessionId: 's', provider: 'p', model: 'm', at: '2026-09-30T14:00:00Z' }])
    expect(s.turns).toHaveLength(1)
    expect(s.turns[0]?.user).toBe('Plan 12 brackets')
  })

  it('records errors and does not mutate the previous state', () => {
    const before = begin()
    const snapshot = JSON.stringify(before)
    const after = reduceTranscript(before, { type: 'error', message: 'Provider timed out', retryable: true }, T0)
    expect(JSON.stringify(before)).toBe(snapshot)
    expect(kinds(after)).toEqual(['error'])
  })
})

describe('format helpers', () => {
  it('formats durations, tokens and countdowns', () => {
    expect(fmtDuration(42_000)).toBe('42s')
    expect(fmtDuration(72_000)).toBe('1m 12s')
    expect(fmtTokens(812)).toBe('812')
    expect(fmtTokens(2400)).toBe('2.4k')
    expect(fmtCountdown(299_000)).toBe('4:59')
    expect(fmtCountdown(-5)).toBe('0:00')
  })

  it('splits code and bold spans', () => {
    expect(segs('Export with `sx export` and **tension the belt** now')).toEqual([
      { text: 'Export with ', kind: 'plain' },
      { text: 'sx export', kind: 'code' },
      { text: ' and ', kind: 'plain' },
      { text: 'tension the belt', kind: 'bold' },
      { text: ' now', kind: 'plain' },
    ])
  })

  it('tokenizes arguments and bars', () => {
    expect(argTokens('--profile "0.20 Standard" bay-3').map((t) => t.kind)).toEqual(['flag', 'str', 'value'])
    expect(barCells(0.5)).toEqual({ filled: 11, empty: 11 })
    expect(barCells(2)).toEqual({ filled: 22, empty: 0 })
  })

  it('labels session times relative to today', () => {
    const now = new Date(2026, 8, 30, 15, 0).getTime()
    expect(fmtWhen(new Date(2026, 8, 30, 14, 2).toISOString(), now)).toBe('Today 14:02')
    expect(fmtWhen(new Date(2026, 8, 29, 19, 20).toISOString(), now)).toBe('Yesterday 19:20')
    expect(fmtWhen(new Date(2026, 8, 27, 16, 5).toISOString(), now)).toBe('Sep 27 16:05')
  })
})
