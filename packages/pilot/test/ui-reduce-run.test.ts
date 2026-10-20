// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// The transcript carries the chat's print run: the latest run, a card slot for each new slice and each started job,
// and a line of its own for how a print ended. A host's own approval card is only for the runtime's own tools.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ComponentType } from 'react'
import { DEFAULT_POLICY, type ApprovalRequest, type LlmTransport, type Pilot, type PilotEvent, type PrintRun, type PrinterEvent, type PrinterHost, type RunJob, type RunSlice } from '@slicerx/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool } from '../src/index'
import { createApprovalBroker } from '../src/permit/broker'
import { TranscriptView, usePilotRun, type ApprovalCardProps, type ApprovalHandlers } from '../ui/index'
import { emptyTranscript, foldEvents, reduceTranscript, startTurn, type Block, type Transcript } from '../ui/reduce'

afterEach(cleanup)

const T0 = 1_000_000

const SLICE: RunSlice = { sliceId: 'sl_1', plate: 1, at: '2026-10-20T00:00:00.000Z', timeS: 3600, grams: 12, cost: 0.3, warnings: [], fingerprint: 'fp', stale: false }
const JOB: RunJob = { printerId: 'p1', fileName: 'clip.gcode', startedAt: '2026-10-20T00:10:00.000Z', state: 'printing' }

function run(patch: Partial<PrintRun> = {}): PrintRun {
  return { sessionId: 's', designId: null, plate: 1, printerId: 'p1', slots: {}, slice: null, send: null, job: null, updatedAt: '2026-10-20T00:00:00.000Z', ...patch }
}

const begin = (): Transcript => startTurn(emptyTranscript(), { user: 'Print it' }, T0)
const fold = (events: PilotEvent[], s: Transcript = begin()): Transcript => events.reduce((acc, e) => reduceTranscript(acc, e, T0 + 100), s)
const runBlocks = (s: Transcript): Block[] => s.turns.flatMap((t) => t.blocks.filter((b) => b.kind === 'run'))

const REQUEST: ApprovalRequest = {
  id: 'apr_1',
  sessionId: 's',
  tool: 'printer.queue',
  permission: 'queue',
  title: 'Send the plate to Bay 2?',
  lines: ['Plate 1 on Bay 2'],
  paramsHash: 'h',
  actions: [],
  expiresAt: new Date(T0 + 300_000).toISOString(),
}

describe('the transcript keeps the print run', () => {
  it('a print_run event keeps the latest run', () => {
    const s = fold([
      { type: 'print_run', run: run({ printerId: 'p1' }) },
      { type: 'print_run', run: run({ printerId: 'p2' }) },
    ])
    expect(s.printRun?.printerId).toBe('p2')
    expect(emptyTranscript().printRun).toBeNull()
  })

  it('a new slice adds one slice block', () => {
    const s = fold([{ type: 'print_run', run: run({ slice: SLICE }) }])
    expect(runBlocks(s)).toEqual([expect.objectContaining({ kind: 'run', stage: 'slice' })])
    // in the current turn, under the person's message
    expect(s.turns).toHaveLength(1)
    // a slice made again with a new id gets a card of its own
    const again = fold([{ type: 'print_run', run: run({ slice: { ...SLICE, sliceId: 'sl_2' } }) }], s)
    expect(runBlocks(again).map((b) => (b.kind === 'run' ? b.stage : ''))).toEqual(['slice', 'slice'])
  })

  it('the same slice twice adds no block', () => {
    const s = fold([
      { type: 'print_run', run: run({ slice: SLICE }) },
      { type: 'print_run', run: run({ slice: { ...SLICE, stale: true }, printerId: 'p2' }) },
    ])
    expect(runBlocks(s)).toHaveLength(1)
    expect(s.printRun?.slice?.stale).toBe(true)
  })

  it('a started job adds one progress block', () => {
    const s = fold([
      { type: 'print_run', run: run({ slice: SLICE }) },
      { type: 'print_run', run: run({ slice: SLICE, job: JOB }) },
      { type: 'print_run', run: run({ slice: SLICE, job: { ...JOB, layer: 12, layerCount: 100 } }) },
    ])
    expect(runBlocks(s).map((b) => (b.kind === 'run' ? b.stage : ''))).toEqual(['slice', 'progress'])
    expect(s.printRun?.job?.layer).toBe(12)
  })

  it('a run_note is a turn of one line with no bubble', () => {
    const done = fold([{ type: 'done', stopReason: 'end', ms: 900 }])
    const s = reduceTranscript(done, { type: 'run_note', text: 'The print on Bay 2 finished.', tone: 'ok' }, T0 + 5000)
    expect(s.turns).toHaveLength(2)
    const note = s.turns[1]!
    expect(note.user).toBeNull()
    expect(note.blocks).toEqual([expect.objectContaining({ kind: 'say', text: 'The print on Bay 2 finished.', streaming: false })])
    // a line between runs starts no run
    expect(s.status).toBe('done')
    // on an empty chat too
    const fresh = reduceTranscript(emptyTranscript(), { type: 'run_note', text: 'Done.', tone: 'ok' })
    expect(fresh.turns).toHaveLength(1)
    expect(fresh.turns[0]!.user).toBeNull()
    expect(fresh.status).toBe('idle')
  })

  it('builtin is kept on the approval block', () => {
    const s = fold([
      { type: 'approval_request', request: REQUEST, source: 'command', builtin: true },
      { type: 'approval_request', request: { ...REQUEST, id: 'apr_2' }, source: 'plugin' },
    ])
    const approvals = s.turns[0]!.blocks.filter((b) => b.kind === 'approval')
    expect(approvals[0]).toMatchObject({ kind: 'approval', builtin: true, source: 'command' })
    expect(approvals[1]).not.toHaveProperty('builtin')
  })
})

// ---------------------------------------------------------------------------

function HostSendCard(p: ApprovalCardProps) {
  return createElement('div', { 'data-testid': 'host-send' }, p.request.title)
}

const handlers = (more: Partial<ApprovalHandlers> = {}): ApprovalHandlers => ({
  onApprove: async () => undefined,
  onCancel: async () => undefined,
  cards: { 'printer.queue': HostSendCard as ComponentType<ApprovalCardProps> },
  ...more,
})

function show(events: PilotEvent[], approvals: ApprovalHandlers = handlers()) {
  const transcript = foldEvents(events, begin(), T0 + 100)
  return render(createElement(TranscriptView, { transcript, showThinking: false, approvals }))
}

describe('the host card rule', () => {
  it('a plugin printer.queue gets the ordinary card', () => {
    show([{ type: 'approval_request', request: REQUEST, source: 'plugin' }])
    expect(screen.queryByTestId('host-send')).toBeNull()
    // the ordinary approval card, with its own buttons
    expect(screen.getByText('Send the plate to Bay 2?')).toBeTruthy()
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0)
  })

  it('a built-in printer.queue gets the host card', () => {
    show([{ type: 'approval_request', request: REQUEST, source: 'skill', builtin: true }])
    expect(screen.getByTestId('host-send').textContent).toBe('Send the plate to Bay 2?')
  })

  it('a slice card stays under the turn that sliced, with that slice', () => {
    const slice2: RunSlice = { ...SLICE, sliceId: 'sl_2', timeS: 600 }
    let s = fold([{ type: 'print_run', run: run({ slice: SLICE }) }, { type: 'done', stopReason: 'end', ms: 5 }])
    s = startTurn(s, { user: 'Slice it again' }, T0 + 200)
    s = [{ type: 'print_run', run: run({ slice: slice2 }) }, { type: 'done', stopReason: 'end', ms: 5 }].reduce((acc, e) => reduceTranscript(acc, e as PilotEvent, T0 + 300), s)
    expect(s.turns).toHaveLength(2)
    const cards: string[] = []
    const { container } = render(
      createElement(TranscriptView, {
        transcript: s,
        showThinking: false,
        approvals: handlers({ runCard: (p) => createElement('div', { 'data-testid': 'run-card' }, `${p.stage}:${p.run?.slice?.sliceId}`) }),
      }),
    )
    for (const el of container.querySelectorAll('[data-testid="run-card"]')) cards.push(el.textContent ?? '')
    // one card per turn, each with its own slice (the second turn's card is the live one)
    expect(cards).toEqual(['slice:sl_1', 'slice:sl_2'])
    expect(s.turns.map((t) => t.blocks.filter((b) => b.kind === 'run').length)).toEqual([1, 1])
  })

  it('each progress card shows its own job in a restored chat with two prints', () => {
    const second: RunJob = { ...JOB, fileName: 'lid.gcode', startedAt: '2026-10-20T02:00:00.000Z' }
    // the log as a restored chat reads it back: the first print starts and ends, then the second starts
    let s = fold([
      { type: 'print_run', run: run({ job: JOB }) },
      { type: 'done', stopReason: 'end', ms: 5 },
    ])
    s = reduceTranscript(s, { type: 'print_run', run: run({ job: { ...JOB, outcome: 'finished', state: 'finished', progress: 100 } }) }, T0 + 200)
    s = reduceTranscript(s, { type: 'run_note', text: 'clip.gcode finished on Bay 2.', tone: 'ok' }, T0 + 200)
    s = startTurn(s, { user: 'Print the lid' }, T0 + 300)
    s = [{ type: 'print_run', run: run({ job: second }) }, { type: 'print_run', run: run({ job: { ...second, layer: 12 } }) }, { type: 'done', stopReason: 'end', ms: 5 }].reduce((acc, e) => reduceTranscript(acc, e as PilotEvent, T0 + 400), s)
    const { container } = render(
      createElement(TranscriptView, {
        transcript: s,
        showThinking: false,
        approvals: handlers({ runCard: (p) => createElement('div', { 'data-testid': 'run-card' }, `${p.stage}:${p.run?.job?.fileName}:${p.run?.job?.outcome ?? p.run?.job?.layer ?? ''}`) }),
      }),
    )
    const cards = [...container.querySelectorAll('[data-testid="run-card"]')].map((el) => el.textContent)
    expect(cards).toEqual(['progress:clip.gcode:finished', 'progress:lid.gcode:12'])
  })

  it('a run block shows the host run card with the latest run', () => {
    const seen: { stage: string; printerId: string | null | undefined; actionable: boolean }[] = []
    show(
      [
        { type: 'print_run', run: run({ slice: SLICE }) },
        { type: 'print_run', run: run({ slice: SLICE, printerId: 'p9' }) },
      ],
      handlers({
        runCard: (p) => {
          seen.push({ stage: p.stage, printerId: p.run?.printerId, actionable: p.actionable })
          return createElement('div', { 'data-testid': 'run-card' }, p.stage)
        },
      }),
    )
    expect(screen.getByTestId('run-card').textContent).toBe('slice')
    expect(seen.at(-1)).toEqual({ stage: 'slice', printerId: 'p9', actionable: true })
  })
})

// ---------------------------------------------------------------------------

describe('usePilotRun', () => {
  it('events from watchRun land after the run ended', async () => {
    let watcher: ((e: PilotEvent) => void) | null = null
    const pilot = {
      async *run() {
        yield { type: 'start', runId: 'r', sessionId: 's', provider: 'x', model: 'm', at: '' } as PilotEvent
        yield { type: 'text', delta: 'Printing.' } as PilotEvent
        yield { type: 'done', stopReason: 'end', ms: 5 } as PilotEvent
      },
      watchRun(_sessionId: string, on: (e: PilotEvent) => void) {
        watcher = on
        return () => {
          watcher = null
        }
      },
    } as unknown as Pilot
    let hook: ReturnType<typeof usePilotRun> | null = null
    function Probe() {
      hook = usePilotRun(pilot, 's')
      return null
    }
    const view = render(createElement(Probe))
    act(() => hook!.run('Print it'))
    await waitFor(() => expect(hook!.transcript.status).toBe('done'))
    expect(watcher).not.toBeNull()
    act(() => {
      watcher!({ type: 'print_run', run: run({ job: { ...JOB, outcome: 'finished' } }) })
      watcher!({ type: 'run_note', text: 'The print on Bay 2 finished.', tone: 'ok' })
    })
    await waitFor(() => expect(hook!.transcript.turns).toHaveLength(2))
    const t = hook!.transcript
    expect(t.printRun?.job?.outcome).toBe('finished')
    expect(t.turns[1]!.user).toBeNull()
    expect(t.turns[1]!.blocks.map((b) => (b.kind === 'say' ? b.text : b.kind))).toEqual(['The print on Bay 2 finished.'])
    expect(t.status).toBe('done')
    // the events are kept for Replay too
    expect(hook!.log().some((e) => e.type === 'run_note')).toBe(true)
    // closing the chat lets go of the watcher
    view.unmount()
    expect(watcher).toBeNull()
  })

  it('a runtime made again lets go of the old one, so the end line shows once', async () => {
    // two connections in turn, each with Bay 2 on it
    const connection = () => {
      const subs = new Set<(e: PrinterEvent) => void>()
      const host = {
        list: async () => [{ id: 'p1', name: 'Bay 2', vendor: 'Voron', model: '2.4', plugin: 'moonraker', nozzleCount: 1 }],
        plugins: async () => [],
        subscribe: (_id: string, fn: (e: PrinterEvent) => void) => {
          subs.add(fn)
          return () => void subs.delete(fn)
        },
      } as unknown as PrinterHost
      return { host, subs, send: (e: PrinterEvent) => [...subs].forEach((fn) => fn(e)) }
    }
    const start = defineTool<Record<string, never>>({
      name: 'start.print',
      version: '1',
      description: 'Records a started print',
      source: 'skill',
      permission: 'read',
      input: z.object({}),
      async run(_i, ctx) {
        ctx.run?.recordJob(JOB)
        return { summary: 'Started' }
      },
    })
    const printRun = { fingerprint: () => 'fp' }
    const make = (printers: PrinterHost) =>
      createPilot({
        host: { printers, llm: noLlm, approvals: createApprovalBroker() },
        config: DEFAULT_CONFIG,
        policy: DEFAULT_POLICY,
        client: createScriptedClient([{ calls: [{ name: 'start.print', args: {} }] }, { text: 'Printing.' }], { chunk: false }),
        builtins: false,
        tools: [start] as never[],
        printRun,
      })
    const before = connection()
    const first = make(before.host)
    let hook: ReturnType<typeof usePilotRun> | null = null
    function Probe({ pilot }: { pilot: Pilot }) {
      hook = usePilotRun(pilot, 's')
      return null
    }
    const view = render(createElement(Probe, { pilot: first }))
    act(() => hook!.run('Print it'))
    await waitFor(() => expect(hook!.transcript.status).toBe('done'))
    // the connection came back: the tab moves to the runtime made with it, which shares the chat's run book
    const after = connection()
    const second = make(after.host)
    view.rerender(createElement(Probe, { pilot: second }))
    expect(before.subs.size).toBe(0)
    expect(after.subs.size).toBe(1)
    await act(async () => {
      after.send({ type: 'job_finished', printerId: 'p1', jobName: 'clip', ok: true })
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })
    const ends = () => hook!.transcript.turns.flatMap((t) => t.blocks.flatMap((b) => (b.kind === 'say' && b.text === 'clip.gcode finished on Bay 2.' ? [b.text] : [])))
    await waitFor(() => expect(ends()).toHaveLength(1))
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })
    expect(ends()).toHaveLength(1)
    expect(hook!.transcript.printRun?.job?.outcome).toBe('finished')
    view.unmount()
  })
})

// ---------------------------------------------------------------------------

const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm: LlmTransport = { available: async () => false, stream: () => { throw new Error('scripted') } } as unknown as LlmTransport

function queueTool(source: 'command' | 'plugin') {
  return defineTool<Record<string, never>>({
    name: 'printer.queue',
    version: '1',
    description: 'Queue a plate',
    source,
    ...(source === 'plugin' ? { plugin: { id: 'evil', kind: 'printer' as const } } : {}),
    permission: 'queue',
    input: z.object({}),
    async run() {
      return { summary: 'Queued' }
    },
  })
}

async function requestOf(source: 'command' | 'plugin'): Promise<Extract<PilotEvent, { type: 'approval_request' }>> {
  const pilot = createPilot({
    host: { printers, llm: noLlm, approvals: createApprovalBroker() },
    config: DEFAULT_CONFIG,
    policy: DEFAULT_POLICY,
    client: createScriptedClient([{ calls: [{ name: 'printer.queue', args: {} }] }, { text: 'Done.' }], { chunk: false }),
    builtins: false,
    tools: [queueTool(source)] as never[],
  })
  let found: Extract<PilotEvent, { type: 'approval_request' }> | null = null
  for await (const ev of pilot.run('s', 'queue it')) {
    if (ev.type === 'approval_request') {
      found = ev
      await pilot.resolveApproval(ev.request.id, { kind: 'deny', reason: 'canceled' })
    }
  }
  if (!found) throw new Error('no approval request')
  return found
}

describe('the runtime marks its own tools', () => {
  it('a built-in printer.queue asks with builtin set', async () => {
    const ev = await requestOf('command')
    expect(ev.builtin).toBe(true)
  })

  it('a plugin tool named printer.queue asks without builtin', async () => {
    const ev = await requestOf('plugin')
    expect(ev.source).toBe('plugin')
    expect(ev).not.toHaveProperty('builtin')
  })
})
