// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PilotEvent } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createEvalEnv, noteApprovals } from '../evals/harness'
import { createDemoClient } from '../src/demo'
import type { LlmClient, LlmMessage } from '../src/provider/types'

async function run(prompt: string, approve: boolean, client: LlmClient = createDemoClient({ delayMs: 0, callDelayMs: 0 }), session = 'demo') {
  const env = createEvalEnv({ client, machine: { printer: 'bambu_p1s', material: 'petg', nozzle: 0.4 }, objects: [{ id: 'part', name: 'Cable hook', bboxMm: [60, 20, 35] }] })
  const events: PilotEvent[] = []
  for await (const ev of env.pilot.run(session, prompt, {})) {
    events.push(ev)
    noteApprovals(env.audit, ev)
    if (ev.type === 'approval_request') await env.pilot.resolveApproval(ev.request.id, approve ? { kind: 'approve' } : { kind: 'deny' })
  }
  return { env, events }
}

describe('demo client on the stock demo printers', () => {
  it('plans the bracket batch and stops for approval before queueing', async () => {
    const { env, events } = await run('Print 12 strong PETG brackets by Friday', false)
    const tools = events.flatMap((e) => (e.type === 'tool_call' ? [e.tool] : []))
    expect(tools).toEqual(expect.arrayContaining(['kb.intent', 'printer.list', 'arrange', 'slice']))
    expect(events.some((e) => e.type === 'approval_request')).toBe(true)
    expect(env.audit.sideEffects.filter((s) => s.ok)).toEqual([])
  })

  it('queues only with approval, through verified tokens', async () => {
    const { env } = await run('Print 12 strong PETG brackets by Friday', true)
    expect(env.audit.sideEffects.some((s) => s.ok && s.method === 'start')).toBe(true)
    expect(env.audit.unapproved()).toEqual([])
  })

  it('explains itself for requests it has no run for', async () => {
    const { events } = await run('write me a poem', false)
    expect(events.map((e) => (e.type === 'text' ? e.delta : '')).join('')).toMatch(/model provider/)
  })
})

const said = (events: PilotEvent[]): string => events.map((e) => (e.type === 'text' ? e.delta : '')).join('')

/** Drives the demo client alone, answering every lookup with `ok`. */
async function drive(prompt: string, ok: boolean): Promise<string> {
  const client = createDemoClient({ delayMs: 0, callDelayMs: 0 })
  const messages: LlmMessage[] = [{ role: 'user', content: `User request:\n${prompt}` }]
  let text = ''
  for (let step = 0; step < 10; step++) {
    const calls: { id: string; name: string; arguments: string }[] = []
    let stop = ''
    for await (const ev of client.stream({ model: 'demo', messages, tools: [] } as never)) {
      if (ev.type === 'text') text += ev.delta
      if (ev.type === 'tool_call') calls.push(ev.call)
      if (ev.type === 'done') stop = ev.stop
    }
    if (stop !== 'tool_calls') break
    messages.push({ role: 'assistant', content: '', toolCalls: calls } as LlmMessage)
    for (const c of calls) {
      const body = c.name === 'printer.list' ? { ok: true, summary: '1 printer', result: [{ id: 'bay-4', name: 'Bay 4', model: 'P1S', status: { state: 'paused' } }] } : { ok, summary: ok ? 'found' : 'No entry' }
      messages.push({ role: 'tool', callId: c.id, content: JSON.stringify(body) })
    }
  }
  return text
}

describe('demo client citations and conversations', () => {
  it('cites the layer shift guide and the PETG entry only when the lookup found them', async () => {
    expect(await drive('Diagnose the Bay 4 failure', true)).toMatch(/per the layer shift guide/)
    expect(await drive('Diagnose the Bay 4 failure', false)).not.toMatch(/guide/)
    expect(await drive('Tune my new PETG spool', true)).toMatch(/PETG entry/)
    expect(await drive('Tune my new PETG spool', false)).not.toMatch(/entry/)
  })

  it('answers a second conversation on the same client', async () => {
    const client = createDemoClient({ delayMs: 0, callDelayMs: 0 })
    const first = await run('Diagnose the Bay 4 failure', false, client, 'one')
    const second = await run('Diagnose the Bay 4 failure', false, client, 'two')
    expect(said(first.events)).toMatch(/belts/)
    expect(said(second.events)).toMatch(/belts/)
    expect(second.events.some((e) => e.type === 'tool_call')).toBe(true)
  })
})
