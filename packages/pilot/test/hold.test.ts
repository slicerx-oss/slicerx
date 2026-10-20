// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pause and Resume for mimir in the tab: a hold makes the run wait at its next step boundary (before a model request
// or a tool call, never in the middle of one). It never pauses a printer, never answers or cancels a waiting card, and
// letting go continues the same run. A cancel at a step boundary skips the calls the run has not made yet. The tests
// wait on the run's own state, never a fixed time.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool, type ScriptStep } from '../src/index'

/** A printer host that records every call, so a test can see that a hold sends none. */
function printerSpy() {
  const calls: string[] = []
  const spy = (name: string) => async () => {
    calls.push(name)
    return undefined as never
  }
  const printers = {
    list: async () => [],
    plugins: async () => [],
    pause: spy('pause'),
    resume: spy('resume'),
    cancel: spy('cancel'),
    start: spy('start'),
    upload: spy('upload'),
  } as unknown as PrinterHost
  return { printers, calls }
}

/** A tool that runs until the test lets it finish. */
function gatedTool(name: string) {
  let release: () => void = () => {}
  const started: string[] = []
  const finished: string[] = []
  const tool = defineTool<Record<string, never>>({
    name,
    version: '1',
    description: `Test tool ${name}`,
    source: 'skill',
    permission: 'read',
    input: z.object({}),
    async run() {
      started.push(name)
      await new Promise<void>((r) => (release = r))
      finished.push(name)
      return { summary: `${name} done` }
    },
  })
  return { tool, release: () => release(), started, finished }
}

const quick = (name: string, log: string[]) =>
  defineTool<Record<string, never>>({
    name,
    version: '1',
    description: `Test tool ${name}`,
    source: 'skill',
    permission: 'read',
    input: z.object({}),
    async run() {
      log.push(name)
      return { summary: `${name} done` }
    },
  })

const asking = defineTool<Record<string, never>>({
  name: 'printer.start_test',
  version: '1',
  description: 'Needs the person',
  source: 'skill',
  permission: 'start',
  input: z.object({}),
  async run() {
    return { summary: 'Started' }
  },
})

function setup(steps: ScriptStep[], tools: unknown[]) {
  const spy = printerSpy()
  const client = createScriptedClient(steps, { chunk: false })
  const approvalCalls: string[] = []
  const approvals = {
    register: async () => void approvalCalls.push('register'),
    deny: async () => void approvalCalls.push('deny'),
  } as unknown as ApprovalHost
  const pilot = createPilot({
    host: { printers: spy.printers, approvals, llm: {} as LlmTransport },
    config: DEFAULT_CONFIG,
    policy: DEFAULT_POLICY,
    client,
    builtins: false,
    tools: tools as never[],
  })
  return { pilot, client, calls: spy.calls, approvalCalls }
}

/** Runs in the background, collecting events; `ended` resolves when the run is over. */
function start(it: AsyncIterable<PilotEvent>) {
  const events: PilotEvent[] = []
  const ended = (async () => {
    for await (const e of it) events.push(e)
  })()
  return { events, ended }
}

const types = (events: PilotEvent[], type: PilotEvent['type']) => events.filter((e) => e.type === type)
/** Waits until the run has reached a state. */
const until = (reached: () => boolean) => vi.waitFor(() => expect(reached()).toBe(true), { timeout: 5_000, interval: 1 })
/**
 * Lets everything already queued run (promise jobs and zero-delay callbacks), so a check that something did not
 * happen sees whatever was going to happen next. No fixed wait.
 */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r))
}

describe('holding mimir in the tab', () => {
  it('a hold stops before the next tool call', async () => {
    const a = gatedTool('a')
    const log: string[] = []
    const { pilot, client } = setup([{ calls: [{ name: 'a', args: {} }, { name: 'b', args: {} }] }, { text: 'Done.' }], [a.tool, quick('b', log)])
    const run = start(pilot.run('s', 'go'))
    await until(() => a.started.length === 1)
    pilot.hold!('s', true)
    a.release()
    await until(() => types(run.events, 'tool_result').length === 1)
    await settle()
    expect(a.finished).toEqual(['a'])
    // b waits: no call event, no run, and no new model request
    expect(log).toEqual([])
    expect(types(run.events, 'tool_call').map((e) => (e as { tool: string }).tool)).toEqual(['a'])
    expect(client.requests).toHaveLength(1)
    pilot.hold!('s', false)
    await run.ended
    expect(log).toEqual(['b'])
  })

  it('a hold also waits before the next model request', async () => {
    const a = gatedTool('a')
    const { pilot, client } = setup([{ calls: [{ name: 'a', args: {} }] }, { text: 'Done.' }], [a.tool])
    const run = start(pilot.run('s', 'go'))
    await until(() => a.started.length === 1)
    pilot.hold!('s', true)
    a.release()
    await until(() => types(run.events, 'tool_result').length === 1)
    await settle()
    expect(client.requests).toHaveLength(1)
    pilot.hold!('s', false)
    await run.ended
    expect(client.requests).toHaveLength(2)
  })

  it('a hold never stops a tool midway', async () => {
    const a = gatedTool('a')
    const { pilot } = setup([{ calls: [{ name: 'a', args: {} }] }, { text: 'Done.' }], [a.tool])
    const run = start(pilot.run('s', 'go'))
    await until(() => a.started.length === 1)
    pilot.hold!('s', true)
    await until(() => types(run.events, 'held').length === 1)
    await settle()
    // the tool is still running, and once let finish it reports its result while the run is held
    expect(a.finished).toEqual([])
    a.release()
    await until(() => types(run.events, 'tool_result').length === 1)
    expect(a.finished).toEqual(['a'])
    expect(types(run.events, 'tool_result')).toMatchObject([{ ok: true, summary: 'a done' }])
    pilot.hold!('s', false)
    await run.ended
  })

  it('resume continues the same run', async () => {
    const a = gatedTool('a')
    const { pilot, client } = setup([{ calls: [{ name: 'a', args: {} }] }, { text: 'All set.' }], [a.tool])
    const run = start(pilot.run('s', 'go'))
    await until(() => a.started.length === 1)
    pilot.hold!('s', true)
    a.release()
    await until(() => types(run.events, 'tool_result').length === 1)
    pilot.hold!('s', false)
    await run.ended
    // one start, one done, and the held and let-go lines in between
    expect(types(run.events, 'start')).toHaveLength(1)
    expect(types(run.events, 'done')).toMatchObject([{ stopReason: 'end' }])
    expect(types(run.events, 'held')).toEqual([
      { type: 'held', on: true },
      { type: 'held', on: false },
    ])
    // the request after the hold carries the tool's result from before it
    const after = client.requests[1]!.messages
    expect(after.some((m) => m.role === 'tool' && String(m.content).includes('a done'))).toBe(true)
    expect(run.events.some((e) => e.type === 'text' && e.delta.includes('All set.'))).toBe(true)
  })

  it('a hold leaves a waiting card waiting', async () => {
    const { pilot, approvalCalls } = setup([{ calls: [{ name: 'printer.start_test', args: {} }] }, { text: 'Started it.' }], [asking])
    const run = start(pilot.run('s', 'start it'))
    await until(() => types(run.events, 'approval_request').length === 1)
    const card = types(run.events, 'approval_request')[0] as Extract<PilotEvent, { type: 'approval_request' }>
    pilot.hold!('s', true)
    pilot.hold!('s', false)
    await until(() => types(run.events, 'held').length === 2)
    await settle()
    // nothing answered or closed the card: it still takes the person's answer
    expect(types(run.events, 'approval_resolved')).toEqual([])
    expect(types(run.events, 'done')).toEqual([])
    expect(approvalCalls).toEqual(['register'])
    pilot.hold!('s', true)
    await pilot.resolveApproval(card.request.id, { kind: 'deny', reason: 'canceled' })
    await until(() => types(run.events, 'approval_resolved').length === 1)
    expect(types(run.events, 'approval_resolved')).toMatchObject([{ requestId: card.request.id, by: 'user' }])
    pilot.hold!('s', false)
    await run.ended
  })

  it('cancel works while held', async () => {
    const a = gatedTool('a')
    const ac = new AbortController()
    const { pilot, client } = setup([{ calls: [{ name: 'a', args: {} }] }, { text: 'Done.' }], [a.tool])
    const run = start(pilot.run('s', 'go', { signal: ac.signal }))
    await until(() => a.started.length === 1)
    pilot.hold!('s', true)
    a.release()
    await until(() => types(run.events, 'tool_result').length === 1)
    ac.abort()
    await run.ended
    expect(types(run.events, 'done')).toMatchObject([{ stopReason: 'canceled' }])
    expect(client.requests).toHaveLength(1)
    // the next message is not held
    const next = start(pilot.run('s', 'again'))
    await next.ended
    expect(types(next.events, 'done')).toMatchObject([{ stopReason: 'end' }])
  })

  it('a cancel that arrives during a tool skips the next tool at the boundary', async () => {
    const a = gatedTool('a')
    const log: string[] = []
    const ac = new AbortController()
    const { pilot, client } = setup([{ calls: [{ name: 'a', args: {} }, { name: 'b', args: {} }] }, { text: 'Done.' }], [a.tool, quick('b', log)])
    const run = start(pilot.run('s', 'go', { signal: ac.signal }))
    await until(() => a.started.length === 1)
    // the cancel lands while a runs, with no hold: the run notices it at the boundary before b
    ac.abort()
    a.release()
    await run.ended
    expect(log).toEqual([])
    expect(types(run.events, 'tool_call').map((e) => (e as { tool: string }).tool)).toEqual(['a'])
    expect(types(run.events, 'done')).toMatchObject([{ stopReason: 'canceled' }])
    // and no model request follows the canceled step
    expect(client.requests).toHaveLength(1)
  })

  it('a cancel while held at a tool boundary skips the next tools', async () => {
    const a = gatedTool('a')
    const log: string[] = []
    const ac = new AbortController()
    const { pilot, client } = setup([{ calls: [{ name: 'a', args: {} }, { name: 'b', args: {} }, { name: 'c', args: {} }] }, { text: 'Done.' }], [a.tool, quick('b', log), quick('c', log)])
    const run = start(pilot.run('s', 'go', { signal: ac.signal }))
    await until(() => a.started.length === 1)
    pilot.hold!('s', true)
    a.release()
    // the run now waits at the boundary before b
    await until(() => types(run.events, 'tool_result').length === 1)
    ac.abort()
    await run.ended
    // neither b nor c ran, or showed a call
    expect(log).toEqual([])
    expect(types(run.events, 'tool_call').map((e) => (e as { tool: string }).tool)).toEqual(['a'])
    expect(types(run.events, 'done')).toMatchObject([{ stopReason: 'canceled' }])
    expect(client.requests).toHaveLength(1)
    // the hold ended with the run: the next message runs straight through
    const next = start(pilot.run('s', 'again'))
    await next.ended
    expect(types(next.events, 'held')).toEqual([])
    expect(types(next.events, 'done')).toMatchObject([{ stopReason: 'end' }])
  })

  it('a hold sends no printer call', async () => {
    const a = gatedTool('a')
    const { pilot, calls } = setup([{ calls: [{ name: 'a', args: {} }] }, { text: 'Done.' }], [a.tool])
    const run = start(pilot.run('s', 'go'))
    await until(() => a.started.length === 1)
    pilot.hold!('s', true)
    a.release()
    await until(() => types(run.events, 'tool_result').length === 1)
    pilot.hold!('s', false)
    await run.ended
    expect(calls).toEqual([])
    expect(calls).not.toContain('pause')
  })

  it('a hold with no run going does nothing', async () => {
    const { pilot } = setup([{ text: 'Hi.' }], [])
    pilot.hold!('s', true)
    const run = start(pilot.run('s', 'hello'))
    await run.ended
    expect(types(run.events, 'held')).toEqual([])
    expect(types(run.events, 'done')).toMatchObject([{ stopReason: 'end' }])
  })
})
