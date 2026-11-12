// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// mimir's working steps in one loop, in the mimir tab (plain words and part cards): a reply's thoughts and tool steps
// show in one live block (the raven's mark, "mimir is thinking", the step under way, a strip of one tick per step), and
// fold to one line when the work is done ("Built in 4 steps, 8.4 s") that opens to the steps by part, with a time per
// part and per step. Cards that wait for the person, errors, mimir's text and the part card stay outside; one landing
// mid-turn closes the loop there and the next step opens a new one. Without plain words the rows stay as they are.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PilotEvent } from '@slicerx/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { TranscriptView, type StepWords } from '../ui/index'
import { emptyTranscript, foldEvents, reduceTranscript, startTurn, type Transcript } from '../ui/reduce'
import { fmtStep, fmtTotal, loopGroups, loopLabel, loopLine, loopMs, loopSegments, type Loop } from '../ui/work-loop-model'

afterEach(cleanup)

const WORDS: Record<string, { doing: string; done: string } | null> = {
  'pilot.ask': null,
  'design.new': { doing: 'Starting the design', done: 'Started the design' },
  'geom.loft': { doing: 'Lofting through the profiles', done: 'Lofted through the profiles' },
  'geom.extrude': { doing: 'Extruding the sketch', done: 'Extruded the sketch' },
  'design.check': { doing: 'Checking the part against its plan', done: 'Checked the part against its plan' },
}
const words: StepWords = (row) => {
  const w = WORDS[row.tool]
  if (w === null) return null
  const base = w ?? { doing: 'Working', done: 'Step done' }
  // as the tab's own words do: a failed step says so
  return row.state === 'bad' ? { ...base, done: row.title ?? 'Step failed' } : base
}
const approvals = { onApprove: async () => undefined, onCancel: async () => undefined }
const parts = { onEdit: () => undefined, onSelect: () => undefined, onRun: () => undefined, has: () => true, can: () => true }

const START: PilotEvent = { type: 'start', runId: 'r1', sessionId: 's', provider: 'scripted', model: 'm', at: '2026-11-12T00:00:00Z' }
const call = (id: string, tool: string, args: Record<string, unknown> = {}): PilotEvent => ({ type: 'tool_call', callId: id, tool, source: 'command', input: args, args: JSON.stringify(args) })
const result = (id: string, ms: number, ok = true, output?: unknown): PilotEvent => ({ type: 'tool_result', callId: id, ok, summary: ok ? 'ok' : 'The loft needs at least two profiles', ms, ...(output ? { output } : {}) })
const design = (name: string) => ({ design: 'pod', name, sizeMm: [60, 30, 20] })

/** Folds events one at a time on a clock that moves `step` ms per event, as a live run does. */
function live(events: PilotEvent[], step = 1000): Transcript {
  let s = startTurn(emptyTranscript(), { user: 'a toy pod' }, 1000)
  events.forEach((e, k) => {
    s = reduceTranscript(s, e, 1000 + (k + 1) * step)
  })
  return s
}

const build: PilotEvent[] = [
  START,
  { type: 'text', delta: 'I will shape the shell first, then the fin, then check it.' },
  { type: 'text_done' },
  { type: 'thinking', delta: 'The shell is a loft.' },
  { type: 'thinking_done', ms: 800 },
  call('a', 'design.new', { name: 'Toy pod' }),
  result('a', 200, true, { design: 'pod' }),
  call('b', 'geom.loft', { design: 'pod', feature: 'Shell' }),
  result('b', 1500, true, design('Toy pod')),
  call('c', 'geom.extrude', { design: 'pod', feature: 'Fin' }),
  result('c', 600, true, design('Toy pod')),
  call('d', 'design.check', { design: 'pod' }),
  result('d', 400, true),
]

function loopsOf(t: Transcript): Loop[] {
  return loopSegments(t.turns.at(-1)!.blocks, words).flatMap((g) => (g.kind === 'loop' ? [g.loop] : []))
}

describe('the loop model', () => {
  it("folds a reply's thoughts and tool steps into one loop, with mimir's text before it outside", () => {
    const segs = loopSegments(live(build).turns[0]!.blocks, words)
    expect(segs.map((g) => g.kind)).toEqual(['block', 'loop'])
    const loop = loopsOf(live(build))[0]!
    expect(loop.items.map((i) => i.kind)).toEqual(['think', 'step', 'step', 'step', 'step'])
  })

  it('groups the steps by part: the plan feature, else the name, else the part before; the checks under Check', () => {
    const groups = loopGroups(loopsOf(live(build))[0]!)
    expect(groups.map((g) => [g.part, g.ms])).toEqual([
      ['Toy pod', 200],
      ['Shell', 1500],
      ['Fin', 600],
      ['Check', 400],
    ])
    // the thought before the first step goes with that step's part
    expect(groups[0]!.items.map((i) => i.kind)).toEqual(['think', 'step'])
  })

  it('closes at a card that waits for the person and at an error, and opens a new loop after each', () => {
    const t = live([
      START,
      call('a', 'geom.loft', { feature: 'Shell' }),
      result('a', 100),
      { type: 'ask', askId: 'q1', title: 'Fin', question: 'One fin or two?', choices: [{ id: 'one', label: 'One' }] },
      call('b', 'geom.extrude', { feature: 'Fin' }),
      result('b', 100),
      { type: 'error', message: 'mimir reached today\'s limit.', retryable: false, code: 'daily_limit' },
      call('c', 'geom.extrude', { feature: 'Fin' }),
      result('c', 100),
    ])
    const segs = loopSegments(t.turns[0]!.blocks, words)
    expect(segs.map((g) => (g.kind === 'block' ? g.block.kind : g.kind))).toEqual(['loop', 'choice', 'loop', 'error', 'loop'])
  })

  it("closes at mimir's own text mid-turn, which stays in the chat", () => {
    const t = live([START, call('a', 'geom.loft', { feature: 'Shell' }), result('a', 100), { type: 'text', delta: 'Now the fin.' }, { type: 'text_done' }, call('b', 'geom.extrude', { feature: 'Fin' }), result('b', 100)])
    expect(loopSegments(t.turns[0]!.blocks, words).map((g) => (g.kind === 'block' ? g.block.kind : g.kind))).toEqual(['loop', 'say', 'loop'])
  })

  it('leaves out a call whose card says it (no words), and shows a call that made a part as its card', () => {
    const t = live([
      START,
      call('q', 'pilot.ask'),
      result('q', 10),
      call('m', 'text_to_part'),
      result('m', 300, true, { objectId: 'cube', name: '20 mm cube', kind: 'cube', sizeMm: [20, 20, 20] }),
    ])
    expect(loopSegments(t.turns[0]!.blocks, words).map((g) => g.kind)).toEqual(['made'])
  })

  it('says Built after a step that changed a design, Done with none, and Stopped after a stopped run', () => {
    const built = loopsOf(live(build))[0]!
    // the clock was kept: from the thought's start (the 4th event, at 5 s) to the check's end (its call, the 12th event at
    // 13 s, plus 0.4 s)
    expect(loopMs(built)).toBe(8400)
    expect(loopLine(built, false)).toBe('Built in 4 steps, 8.4 s')
    const reads = loopsOf(live([START, call('a', 'design.check'), result('a', 400)]))[0]!
    expect(loopLine(reads, false)).toBe('Done in 1 step, 0.4 s')
    const stopped = loopsOf(live([START, call('a', 'geom.loft', { feature: 'Shell' }), { type: 'done', stopReason: 'canceled', ms: 3000 }]))[0]!
    expect(loopLine(stopped, true)).toBe('Stopped after 1 step, 0.0 s')
  })

  it('adds the parts up when the clock was not kept (a chat saved before it was)', () => {
    const saved = loopsOf(foldEvents(build, startTurn(emptyTranscript(), { user: 'a toy pod' }, 0), 0))[0]!
    expect(loopMs(saved)).toBe(800 + 200 + 1500 + 600 + 400)
  })

  it('writes times as seconds and minutes', () => {
    expect(fmtTotal(155_000)).toBe('2 min 35 s')
    expect(fmtTotal(35_400)).toBe('35 s')
    expect(fmtStep(1500)).toBe('1.5 s')
    expect(fmtStep(27_000)).toBe('27 s')
  })

  it('labels the live loop with the step under way, a thought as Thinking, and never a tool name', () => {
    const run = loopsOf(live([START, call('a', 'geom.loft', { feature: 'Shell' })]))[0]!
    expect(loopLabel(run, words)).toBe('Lofting through the profiles')
    const thinking = loopsOf(live([START, { type: 'thinking', delta: 'hm' }]))[0]!
    expect(loopLabel(thinking, words)).toBe('Thinking')
    const other = loopsOf(live([START, call('a', 'app.layer_up')]))[0]!
    expect(loopLabel(other, words)).toBe('Working')
  })
})

describe('the loop in the chat', () => {
  const view = (t: Transcript) => render(<TranscriptView transcript={t} showThinking={false} approvals={approvals} words={words} parts={parts} />)

  it('while it works: one live block with the raven, "mimir is thinking", the step under way, and one tick per step', () => {
    view(live([...build.slice(0, 9), call('c', 'geom.extrude', { design: 'pod', feature: 'Fin' })]))
    const block = screen.getByTestId('mimir-loop-live')
    expect(block.getAttribute('role')).toBe('status')
    expect(block.textContent).toContain('mimir is thinking')
    expect(screen.getByTestId('mimir-loop-label').textContent).toBe('Extruding the sketch')
    expect(block.querySelector('.raven-wait .wl-dot')).not.toBeNull()
    const ticks = Array.from(block.querySelectorAll('.wl-strip i')).map((i) => i.className)
    expect(ticks).toEqual(['done', 'done', 'on'])
    // no row or card per step, and no percentage
    expect(document.querySelectorAll('.trow, .tools, .think')).toHaveLength(0)
    expect(block.textContent).not.toMatch(/%/)
  })

  it('when done: one line that opens to the steps by part, then the part card after it', () => {
    view(live([...build, { type: 'text', delta: 'Done: the pod.' }, { type: 'done', stopReason: 'end', ms: 9000 }]))
    expect(screen.queryByTestId('mimir-loop-live')).toBeNull()
    const line = screen.getByTestId('mimir-loop-line')
    expect(line.textContent).toBe('Built in 4 steps, 8.4 s')
    expect(line.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(line)
    expect(line.getAttribute('aria-expanded')).toBe('true')
    const heads = Array.from(document.querySelectorAll('.wl-gh')).map((h) => h.textContent)
    expect(heads).toEqual(['Toy pod0.2 s', 'Shell1.5 s', 'Fin0.6 s', 'Check0.4 s'])
    expect(Array.from(document.querySelectorAll('.wl-sub li')).map((l) => l.textContent)).toEqual([
      'Started the design0.2 s',
      'Lofted through the profiles1.5 s',
      'Extruded the sketch0.6 s',
      'Checked the part against its plan0.4 s',
    ])
    const order = Array.from(document.querySelectorAll('.wl, .say, .part-card, .follow')).map((e) => e.className.split(' ')[0])
    expect(order).toEqual(['say', 'wl', 'say', 'part-card', 'follow'])
  })

  it('a failed step shows its tick and its reason in the list', () => {
    view(live([START, call('a', 'geom.loft', { feature: 'Shell' }), result('a', 100, false), { type: 'done', stopReason: 'end', ms: 900 }]))
    fireEvent.click(screen.getByTestId('mimir-loop-line'))
    const li = document.querySelector('.wl-sub li.failed')
    expect(li?.textContent).toContain('The loft needs at least two profiles')
  })

  it('a stopped run says so on its line', () => {
    view(live([START, call('a', 'geom.loft', { feature: 'Shell' }), { type: 'done', stopReason: 'canceled', ms: 3000 }]))
    expect(screen.getByTestId('mimir-loop-line').textContent).toMatch(/^Stopped after 1 step, /)
  })

  it('without plain words (the terminal view) the rows stay as they are', () => {
    render(<TranscriptView transcript={live(build)} showThinking={false} approvals={approvals} parts={parts} />)
    expect(screen.queryByTestId('mimir-loop')).toBeNull()
    expect(document.querySelectorAll('.trow').length).toBeGreaterThan(0)
  })
})

describe("a failed step's mark", () => {
  // a step whose result came back not ok (a lookup that found nothing, a step the engine refused): the row is bad
  const failed = live([START, call('a', 'kb.sources'), result('a', 100, false), call('b', 'geom.extrude', { feature: 'Fin' }), result('b', 100, false)])
  const rows = failed.turns[0]!.blocks.flatMap((b) => (b.kind === 'tools' ? b.rows : []))

  it('reads a result that is not ok as failed', () => {
    expect(rows.map((r) => r.state)).toEqual(['bad', 'bad'])
  })

  // the folded rows' alert is covered in ui-tool-fold.test.tsx

  it('in the loop, a failed step gets the alert tick while it works, and the loop is marked failed', () => {
    render(<TranscriptView transcript={failed} showThinking={false} approvals={approvals} words={words} parts={parts} />)
    expect(Array.from(document.querySelectorAll('.wl-strip i')).map((i) => i.className)).toEqual(['bad', 'bad'])
    expect(screen.getByTestId('mimir-loop').hasAttribute('data-failed')).toBe(true)
  })

  it('a loop with no failed step is not marked failed', () => {
    render(<TranscriptView transcript={live(build)} showThinking={false} approvals={approvals} words={words} parts={parts} />)
    expect(screen.getByTestId('mimir-loop').hasAttribute('data-failed')).toBe(false)
  })
})
