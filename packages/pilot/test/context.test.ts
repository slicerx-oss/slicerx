// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Keeping a conversation inside a local model's context: the 16,689 token transcript the
// benchmark saw Ollama cut, the order things go in, and the runtime only trimming local models.
import type { PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createEvalEnv } from '../evals/harness'
import { fitContext, messageTokens, MIMIR_CONTEXT, REPLY_RESERVE, SHORTENED, toolsTokens, TRIMMED_RESULT, TRIMMED_TURNS } from '../src/context'
import { createScriptedClient } from '../src/provider/scripted'
import type { LlmMessage, LlmToolDef } from '../src/provider/types'
import { defineTool, type PilotTool } from '../src/tool'

const MACHINE: PilotMachine = { printer: 'prusa_mk4s', material: 'pla', nozzle: 0.4 }

/** Roughly the size of mimir's real tool schemas. */
const TOOLS: LlmToolDef[] = Array.from({ length: 40 }, (_, i) => ({ name: `tool_${i}`, description: 'd'.repeat(1200), parameters: { type: 'object', properties: { x: { type: 'string', description: 'e'.repeat(80) } } } }))

const result = (n: number, size: number): string => JSON.stringify({ ok: true, summary: `result ${n}`, result: { rows: 'r'.repeat(size) } })

/** One request and the tool calls it ran: user, then assistant and tool message pairs. */
function turn(t: number, calls: number, size: number): LlmMessage[] {
  const out: LlmMessage[] = [{ role: 'user', content: `request ${t}` }]
  for (let c = 0; c < calls; c++) {
    const id = `t${t}c${c}`
    out.push({ role: 'assistant', content: '', toolCalls: [{ id, name: 'tool_1', arguments: '{"x":"y"}' }] })
    out.push({ role: 'tool', callId: id, content: result(c, size) })
  }
  out.push({ role: 'assistant', content: `answer ${t}` })
  return out
}

const cost = (ms: readonly LlmMessage[]): number => ms.reduce((a, m) => a + messageTokens(m), 0) + toolsTokens(TOOLS)

/** Every tool result answers a kept call and every kept call has its result, as providers require. */
function paired(ms: readonly LlmMessage[]): boolean {
  const calls = new Set(ms.flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []).map((c) => c.id) : [])))
  const results = new Set(ms.flatMap((m) => (m.role === 'tool' ? [m.callId] : [])))
  return calls.size === results.size && [...calls].every((id) => results.has(id))
}

/** The benchmark's transcript: earlier turns, then a current run that kept calling tools, 16,689 tokens in all. */
function transcript(): LlmMessage[] {
  const ms: LlmMessage[] = [{ role: 'system', content: 's'.repeat(3000) }, ...turn(1, 2, 1200), ...turn(2, 2, 1200), ...turn(3, 4, 1000).slice(0, -1)]
  // Pad the last result so the whole request costs exactly what Ollama saw.
  const last = ms.at(-1) as Extract<LlmMessage, { role: 'tool' }>
  while (cost(ms) < 16689) ms[ms.length - 1] = { ...last, content: `${(ms.at(-1) as { content: string }).content} ` }
  return ms
}

describe('fitting a local model context', () => {
  it('sends the conversation as it is when it fits', () => {
    const ms = [{ role: 'system', content: 'sys' }, ...turn(1, 1, 100)] as LlmMessage[]
    const fit = fitContext(ms, TOOLS, MIMIR_CONTEXT)
    expect(fit.messages).toBe(ms)
    expect(fit).toMatchObject({ droppedTurns: 0, stubbedResults: 0, shortenedResults: 0 })
  })

  it('brings the 16,689 token transcript inside 16K: old turns first, then old results, never the system prompt or the request', () => {
    const ms = transcript()
    expect(cost(ms)).toBe(16689)
    const before = structuredClone(ms)
    const fit = fitContext(ms, TOOLS, MIMIR_CONTEXT)
    expect(cost(fit.messages) + REPLY_RESERVE).toBeLessThanOrEqual(MIMIR_CONTEXT)
    expect(ms).toEqual(before)
    expect(fit.messages[0]).toBe(ms[0])
    expect(fit.droppedTurns).toBeGreaterThanOrEqual(1)
    const user = fit.messages.filter((m) => m.role === 'user')
    expect(user.at(-1)?.content).toMatch(/request 3$/)
    expect(user[0]?.content.startsWith(TRIMMED_TURNS)).toBe(true)
    expect(paired(fit.messages)).toBe(true)
    // The newest two results of the current run stay whole.
    const results = fit.messages.filter((m) => m.role === 'tool')
    expect(results.slice(-2)).toEqual(ms.filter((m) => m.role === 'tool').slice(-2))
  })

  it('in one long run with no earlier turns, stubs the oldest results and keeps the newest', () => {
    const ms: LlmMessage[] = [{ role: 'system', content: 'sys' }, ...turn(1, 12, 1500).slice(0, -1)]
    const fit = fitContext(ms, TOOLS, MIMIR_CONTEXT)
    expect(cost(fit.messages) + REPLY_RESERVE).toBeLessThanOrEqual(MIMIR_CONTEXT)
    expect(fit.droppedTurns).toBe(0)
    const results = fit.messages.filter((m) => m.role === 'tool').map((m) => m.content)
    expect(results[0]).toBe(TRIMMED_RESULT)
    expect(results.slice(-2).every((c) => c !== TRIMMED_RESULT)).toBe(true)
    expect(results.indexOf(TRIMMED_RESULT)).toBe(0)
    expect(paired(fit.messages)).toBe(true)
  })

  it('cuts the middle out of a newest result too big to send, keeping its start and end', () => {
    const big = `{"ok":true,"summary":"sliced plate 1"${',"x":1'.repeat(4000)},"end":"total 42 g"}`
    const ms: LlmMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'slice it' }, { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'tool_1', arguments: '{}' }] }, { role: 'tool', callId: 'a', content: big }]
    const fit = fitContext(ms, TOOLS, MIMIR_CONTEXT)
    expect(fit.shortenedResults).toBe(1)
    const out = fit.messages.at(-1) as { content: string }
    expect(out.content).toContain(SHORTENED)
    expect(out.content.startsWith('{"ok":true,"summary":"sliced plate 1"')).toBe(true)
    expect(out.content.endsWith('"end":"total 42 g"}')).toBe(true)
    expect(cost(fit.messages) + REPLY_RESERVE).toBeLessThanOrEqual(MIMIR_CONTEXT)
  })
})

describe('the runtime and the context', () => {
  const bigRead = defineTool({
    name: 'test.big_read',
    version: '1.0.0',
    source: 'plugin',
    permission: 'read',
    description: 'Returns a long report.',
    input: z.object({}),
    async run() {
      return { summary: 'report', output: { rows: 'r'.repeat(20000) } }
    },
  }) as PilotTool<never>

  async function lastRequest(provider: string) {
    const steps = [...Array.from({ length: 6 }, () => ({ calls: [{ name: 'test.big_read', args: {} }] })), { text: 'done' }]
    const client = createScriptedClient(steps, { provider })
    const env = createEvalEnv({ client, machine: MACHINE, objects: [], tools: [bigRead] })
    for await (const _ of env.pilot.run('t', 'read the reports', { context: { machine: MACHINE } })) void _
    const req = client.requests.at(-1)
    if (!req) throw new Error('no request')
    return req
  }

  it('trims what it sends to a local model, and sends a cloud model everything', async () => {
    const local = await lastRequest('openai-compatible')
    const localCost = local.messages.reduce((a, m) => a + messageTokens(m), 0) + toolsTokens(local.tools)
    expect(localCost + REPLY_RESERVE).toBeLessThanOrEqual(MIMIR_CONTEXT)
    expect(local.messages.some((m) => m.role === 'tool' && m.content === TRIMMED_RESULT)).toBe(true)
    expect(local.messages[0]?.role).toBe('system')

    const cloud = await lastRequest('openai')
    expect(cloud.messages.some((m) => m.role === 'tool' && m.content === TRIMMED_RESULT)).toBe(false)
    expect(cloud.messages.filter((m) => m.role === 'tool')).toHaveLength(6)
  })
})
