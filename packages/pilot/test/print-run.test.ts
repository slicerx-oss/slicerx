// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print run record: one per chat, shared by the tools (ctx.run) and the cards (print_run events). A plate edit, a
// printer change or a slot change after slicing makes the slice stale; the steps follow the run.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotEvent, type PrintRun, type PrinterHost, type RunJob, type RunSend, type RunSlice } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createRunBook, createScriptedClient, DEFAULT_CONFIG, defineTool, runSteps, type PrintRunHost, type ScriptStep, type ToolContext } from '../src/index'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }

const designNew = defineTool<{ name: string }>({
  name: 'design.new',
  version: '1',
  description: 'Start a design',
  source: 'skill',
  permission: 'read',
  input: z.object({ name: z.string() }),
  async run(input) {
    return { summary: `Started ${input.name}`, output: { design: 'des_42', name: input.name } }
  },
})

const seen: (ToolContext['run'] | 'unset')[] = []
const probe = defineTool<Record<string, never>>({
  name: 'probe',
  version: '1',
  description: 'Looks at the run handle',
  source: 'skill',
  permission: 'read',
  input: z.object({}),
  async run(_input, ctx) {
    seen.push(ctx.run ?? 'unset')
    return { summary: 'Looked' }
  },
})

const plugSeen: (ToolContext['run'] | 'unset')[] = []
const pluginProbe = defineTool<Record<string, never>>({
  name: 'plug.probe',
  version: '1',
  description: 'A plugin tool that looks at the run handle',
  source: 'plugin',
  plugin: { id: 'plug', kind: 'printer' },
  permission: 'read',
  input: z.object({}),
  async run(_input, ctx) {
    plugSeen.push(ctx.run ?? 'unset')
    return { summary: 'Looked' }
  },
})

const setPrinter = defineTool<{ printerId: string }>({
  name: 'set.printer',
  version: '1',
  description: 'Sets the run printer',
  source: 'skill',
  permission: 'read',
  input: z.object({ printerId: z.string() }),
  async run(input, ctx) {
    ctx.run?.update({ printerId: input.printerId })
    return { summary: 'Set' }
  },
})

const SEND: RunSend = { printerId: 'p1', fileName: 'clip.gcode', fileKind: 'gcode', sha256: 'abc', slots: { 1: 'A1' }, timeS: 3600, grams: 12 }
const JOB: RunJob = { printerId: 'p1', fileName: 'clip.gcode', startedAt: '2026-10-20T00:00:00.000Z', state: 'printing' }

function fakeHost(fp = 'fp1'): PrintRunHost & { fp: string } {
  const h = {
    fp,
    fingerprint: () => h.fp,
  }
  return h
}

function pilot(steps: ScriptStep[], printRun?: PrintRunHost) {
  return createPilot({
    host,
    config: DEFAULT_CONFIG,
    policy: DEFAULT_POLICY,
    client: createScriptedClient(steps, { chunk: false }),
    builtins: false,
    tools: [designNew, probe, pluginProbe, setPrinter] as never[],
    ...(printRun ? { printRun } : {}),
  })
}

async function collect(it: AsyncIterable<PilotEvent>): Promise<PilotEvent[]> {
  const out: PilotEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

const slice = (fingerprint: string): RunSlice => ({ sliceId: 'sl_1', plate: 1, at: '2026-10-20T00:00:00.000Z', timeS: 3600, grams: 12, cost: 0.3, warnings: [], fingerprint, stale: false })

describe('the print run', () => {
  it('a new chat has an empty run', () => {
    const run = pilot([], fakeHost()).printRun!('chat-new')
    expect(run).toMatchObject({ sessionId: 'chat-new', designId: null, printerId: null, slice: null, send: null, job: null, plate: 1 })
    expect(run!.slots).toEqual({})
  })

  it('design.new records the design id', async () => {
    const p = pilot([{ calls: [{ name: 'design.new', args: { name: 'Clip' } }] }, { text: 'Done.' }], fakeHost())
    const events = await collect(p.run('s1', 'make a clip'))
    const runs = events.filter((e) => e.type === 'print_run')
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ type: 'print_run', run: { sessionId: 's1', designId: 'des_42' } })
    expect(p.printRun!('s1')!.designId).toBe('des_42')
  })

  it('a run per chat', () => {
    const book = createRunBook(fakeHost(), () => 0)
    book.update('a', { designId: 'des_a', printerId: 'p1' })
    book.update('b', { designId: 'des_b' })
    expect(book.get('a')).toMatchObject({ designId: 'des_a', printerId: 'p1' })
    expect(book.get('b')).toMatchObject({ designId: 'des_b', printerId: null })
    book.forget('a')
    expect(book.get('a').designId).toBeNull()
    expect(book.get('b').designId).toBe('des_b')
  })

  it('forgetRun drops one chat run and leaves the others', async () => {
    const p = pilot(
      [{ calls: [{ name: 'design.new', args: { name: 'Clip' } }] }, { text: 'Done.' }, { calls: [{ name: 'set.printer', args: { printerId: 'p2' } }] }, { text: 'Done.' }, { calls: [{ name: 'set.printer', args: { printerId: 'p3' } }] }, { text: 'Done.' }],
      fakeHost(),
    )
    await collect(p.run('A', 'make a clip'))
    await collect(p.run('B', 'use p2'))
    expect(p.printRun!('A')!.designId).toBe('des_42')
    p.forgetRun('A')
    // the record is gone, the other chat keeps its own
    expect(p.printRun!('A')).toMatchObject({ designId: null, printerId: null })
    expect(p.printRun!('B')).toMatchObject({ printerId: 'p2' })
    // and nothing from the old record comes back when the id is used again
    const again = await collect(p.run('A', 'use p3'))
    const runs = again.flatMap((e) => (e.type === 'print_run' ? [e.run] : []))
    expect(runs.every((r) => r.designId === null && r.printerId === 'p3')).toBe(true)
    // a chat with no print run host has nothing to forget
    expect(() => pilot([]).forgetRun('A')).not.toThrow()
  })

  it('a plate edit makes the slice stale', () => {
    const h = fakeHost('fp1')
    const book = createRunBook(h, () => 0)
    book.update('s', { printerId: 'p1', slots: { 1: 'A1' }, slice: slice('fp1') })
    expect(book.get('s').slice!.stale).toBe(false)
    h.fp = 'fp2'
    expect(book.get('s').slice!.stale).toBe(true)
  })

  it('a printer change makes the slice stale', () => {
    const book = createRunBook(fakeHost('fp1'), () => 0)
    book.update('s', { printerId: 'p1', slots: { 1: 'A1' }, slice: slice('fp1') })
    expect(book.update('s', { printerId: 'p2' }).slice!.stale).toBe(true)
    expect(book.get('s').slice!.stale).toBe(true)
  })

  it('a slot change makes the slice stale', () => {
    const book = createRunBook(fakeHost('fp1'), () => 0)
    book.update('s', { printerId: 'p1', slots: { 1: 'A1' }, slice: slice('fp1') })
    book.update('s', { slots: { 1: 'A1' } })
    expect(book.get('s').slice!.stale).toBe(false)
    book.update('s', { slots: { 1: 'A2' } })
    expect(book.get('s').slice!.stale).toBe(true)
  })

  it('a plate change makes the slice stale', () => {
    const book = createRunBook(fakeHost('fp1'), () => 0)
    book.update('s', { printerId: 'p1', slots: { 1: 'A1' }, slice: slice('fp1') })
    expect(book.get('s').slice!.stale).toBe(false)
    book.update('s', { plate: 2 })
    expect(book.get('s').slice!.stale).toBe(true)
  })

  it('update takes only the part, plate, printer, slots and slice', () => {
    const book = createRunBook(fakeHost('fp1'), () => 0)
    const run = book.update('s', { printerId: 'p1', send: SEND, job: JOB, sessionId: 'other' } as never)
    expect(run).toMatchObject({ sessionId: 's', printerId: 'p1', send: null, job: null })
    expect(book.recordSend('s', SEND).send).toEqual(SEND)
    expect(book.recordJob('s', JOB).job).toEqual(JOB)
    expect(book.recordJob('s', null).job).toBeNull()
  })

  it('keys set to undefined are ignored, so the steps never throw', () => {
    const book = createRunBook(fakeHost('fp1'), () => 0)
    book.update('s', { designId: 'des_1', printerId: 'p1', slice: slice('fp1') })
    const run = book.update('s', { slice: undefined, printerId: undefined, slots: undefined, plate: undefined } as never)
    expect(run).toMatchObject({ designId: 'des_1', printerId: 'p1', plate: 1, slots: {} })
    expect(run.slice).not.toBeUndefined()
    expect(() => runSteps(run)).not.toThrow()
    // a run read back from a log that lacks keys
    expect(() => runSteps({ sessionId: 's', plate: 1, slots: {}, updatedAt: '' } as unknown as PrintRun)).not.toThrow()
  })

  it('a failing listener does not stop the change or the other listeners', () => {
    const book = createRunBook(fakeHost('fp1'), () => 0)
    const got: string[] = []
    book.subscribe('s', () => {
      throw new Error('boom')
    })
    book.subscribe('s', (run) => got.push(run.printerId ?? ''))
    expect(book.update('s', { printerId: 'p1' }).printerId).toBe('p1')
    expect(got).toEqual(['p1'])
  })

  it('a stale slice makes the slice step now', () => {
    const h = fakeHost('fp1')
    const book = createRunBook(h, () => 0)
    book.update('s', { designId: 'des_1', printerId: 'p1', slots: { 1: 'A1' }, slice: slice('fp1') })
    h.fp = 'fp2'
    const states = Object.fromEntries(runSteps(book.get('s')).map((x) => [x.name, x.state]))
    expect(states).toEqual({ design: 'done', plate: 'done', target: 'done', slice: 'now', send: 'todo', print: 'todo' })
  })

  it('steps follow the run', () => {
    const book = createRunBook(fakeHost('fp1'), () => 0)
    const states = (groups?: Parameters<typeof runSteps>[1]) => Object.fromEntries(runSteps(book.get('s'), groups).map((s) => [s.name, s.state]))
    expect(states()).toEqual({ design: 'now', plate: 'todo', target: 'todo', slice: 'todo', send: 'todo', print: 'todo' })
    book.update('s', { designId: 'des_1', printerId: 'p1', slots: { 1: 'A1' }, slice: slice('fp1') })
    expect(states()).toEqual({ design: 'done', plate: 'done', target: 'done', slice: 'done', send: 'now', print: 'todo' })
    expect(states({ printers: false })).toEqual({ design: 'done', plate: 'done', target: 'off', slice: 'done', send: 'off', print: 'off' })
  })

  it('no printRun host, no run handle', async () => {
    seen.length = 0
    const p = pilot([{ calls: [{ name: 'design.new', args: { name: 'Clip' } }, { name: 'probe', args: {} }] }, { text: 'Done.' }])
    const events = await collect(p.run('s', 'make a clip'))
    expect(seen).toEqual(['unset'])
    expect(events.some((e) => e.type === 'print_run')).toBe(false)
    expect(p.printRun!('s')).toBeNull()
  })

  it('a plugin tool gets no run handle', async () => {
    seen.length = 0
    plugSeen.length = 0
    const p = pilot([{ calls: [{ name: 'plug.probe', args: {} }, { name: 'probe', args: {} }] }, { text: 'Done.' }], fakeHost())
    await collect(p.run('s', 'look'))
    expect(plugSeen).toEqual(['unset'])
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toBe('unset')
  })

  it("one chat's print_run events never carry another chat's run", async () => {
    const p = pilot(
      [{ calls: [{ name: 'design.new', args: { name: 'Clip' } }] }, { text: 'Done.' }, { calls: [{ name: 'set.printer', args: { printerId: 'p2' } }] }, { text: 'Done.' }],
      fakeHost(),
    )
    const a = await collect(p.run('A', 'make a clip'))
    const b = await collect(p.run('B', 'use p2'))
    const runsA = a.flatMap((e) => (e.type === 'print_run' ? [e.run] : []))
    const runsB = b.flatMap((e) => (e.type === 'print_run' ? [e.run] : []))
    expect(runsA).toHaveLength(1)
    expect(runsB).toHaveLength(1)
    expect(runsA.every((r) => r.sessionId === 'A' && r.printerId === null)).toBe(true)
    expect(runsB.every((r) => r.sessionId === 'B' && r.designId === null && r.printerId === 'p2')).toBe(true)
    expect(p.printRun!('A')).toMatchObject({ designId: 'des_42', printerId: null })
  })

  it('a tool reads and changes the run through ctx.run', async () => {
    seen.length = 0
    const p = pilot([{ calls: [{ name: 'probe', args: {} }] }, { text: 'Done.' }], fakeHost())
    await collect(p.run('s', 'look'))
    const handle = seen[0]
    expect(handle).not.toBe('unset')
    if (handle === 'unset' || !handle) throw new Error('no handle')
    expect(handle.get().sessionId).toBe('s')
    expect(handle.update({ printerId: 'p9' }).printerId).toBe('p9')
    expect(handle.recordSend(SEND).send).toEqual(SEND)
    expect(handle.recordJob(JOB).job).toEqual(JOB)
    expect(p.printRun!('s')).toMatchObject({ printerId: 'p9', send: SEND, job: JOB })
  })
})
