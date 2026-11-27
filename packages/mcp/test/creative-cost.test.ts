// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The creative eval sends what the app sends on mimir cloud, and counts it: a live run's client keeps the model
// client's tool search and tool limit through the eval's own wrappers (run.ts, live.ts budgetedClient), and a replay
// run as mimir cloud's client (cost.ts) is counted request by request as mimir cloud would bill it.
import type { LlmHttpRequest, LlmTransport } from '@slicerx/contracts'
import { createScriptedClient, createTransportClient, MIMIR_CLOUD_MAX_TOOLS, type LlmClient } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { MAX_LOADED_TOOLS, shape } from '../../../supabase/functions/mimir/shape'
import { callUsd, costClient, costTable, recordedUsage, sessionCost, type CallCost } from '../evals/creative/cost'
import { budgetedClient, createBudget, HAIKU_5_5, SONNET_5_5 } from '../evals/creative/live'
import { CREATIVE_PROMPTS } from '../evals/creative/prompts'
import { parseRecording } from '../evals/creative/recordings'
import { runPrompt } from '../evals/creative/run'

const P = CREATIVE_PROMPTS.find((x) => x.id === 'cable-organizer')!
const SHEET = { name: 'pilot.sheet', args: { title: 'Size', dims: [{ key: 'length', label: 'Length', value: 100, unit: 'mm', source: 'guess' }] } }

describe('a live creative run on mimir cloud', () => {
  it('loads the tab\'s tools behind tool search, as the desktop does, through the budget', async () => {
    const sent: LlmHttpRequest[] = []
    // keeps each request and answers none, so the turn ends after its first request
    const cloud: LlmTransport = {
      available: async () => true,
      // eslint-disable-next-line require-yield
      async *stream(req) {
        sent.push(req)
        throw new Error('not answered in this test')
      },
    }
    const client = budgetedClient(createTransportClient(cloud, 'mimir-cloud'), 'claude-haiku-5-5', HAIKU_5_5, createBudget(1))
    expect(client.maxTools).toBe(MIMIR_CLOUD_MAX_TOOLS)
    expect(client.toolSearch).toBe(true)
    await runPrompt(P, { geom: undefined, client, model: 'claude-haiku-5-5', timeoutMs: 20_000 })
    expect(sent.length).toBeGreaterThan(0)
    for (const [n, req] of sent.entries()) {
      // the proxy's own check of each request, as mimir cloud runs it before any model call
      const s = shape(JSON.parse(req.body ?? '{}'), undefined, req.headers['anthropic-beta'])
      expect(s.ok ? null : s.error, `request ${n + 1}`).toBeNull()
      const tools = (JSON.parse(req.body ?? '{}') as { tools?: Record<string, unknown>[] }).tools ?? []
      const loaded = tools.filter((t) => t['defer_loading'] !== true)
      // the tools that wait behind the search tool, as on the desktop
      expect(tools.length - loaded.length, `request ${n + 1}`).toBeGreaterThan(50)
      expect(loaded.length, `request ${n + 1}`).toBeLessThanOrEqual(MAX_LOADED_TOOLS)
      expect(loaded.at(-1)?.['name'], `request ${n + 1}`).toBe('tool_search_tool_bm25')
    }
  }, 30_000)

  it('keeps each reply\'s usage in a live capture, and a recording reads it back', async () => {
    const usage: LlmClient = {
      provider: 'anthropic',
      async *stream() {
        yield { type: 'tool_call', call: { id: 'c1', name: SHEET.name, arguments: JSON.stringify(SHEET.args) } }
        yield { type: 'usage', inputTokens: 900, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 200 }
        yield { type: 'done', stop: 'tool_calls' }
      },
    }
    const run = await runPrompt(P, { geom: undefined, client: usage, timeoutMs: 20_000 })
    expect(run.steps[0]).toMatchObject({ calls: [SHEET], usage: { input: 900, output: 50, cacheRead: 600, cacheWrite: 200 } })
    const rec = parseRecording(JSON.stringify({ status: 'recorded', model: 'm', provider: 'anthropic', capturedAt: 'now', steps: run.steps.slice(0, 1) }))
    expect(rec.status === 'recorded' && recordedUsage(rec.steps)).toEqual({ requests: 1, input: 900, output: 50, cacheRead: 600, cacheWrite: 200 })
    expect(() => parseRecording(JSON.stringify({ status: 'recorded', model: 'm', provider: 'anthropic', capturedAt: 'now', steps: [{ text: 'x', usage: { input: 'a' } }] }))).toThrow(/usage/)
  }, 30_000)
})

describe('a replay counted as mimir cloud would bill it', () => {
  it('splits each request into its system prompt, the tools that load, the found tools and the history', async () => {
    const calls: CallCost[] = []
    const steps = [{ calls: [SHEET] }, { calls: [{ name: 'design.new', args: { name: 'Cable organizer' } }] }, { text: 'Built it.' }]
    const run = await runPrompt(P, { geom: undefined, steps, model: 'claude-haiku-5-5', wrap: (c) => costClient(c, calls, new Set([P.prompt])), tabTools: true })
    expect(run.error).toBeUndefined()
    expect(calls).toHaveLength(3)
    const [first, second, third] = calls as [CallCost, CallCost, CallCost]
    // every request is the one person's message, and sends the whole catalog with most of it deferred
    expect(calls.map((c) => c.turn)).toEqual([1, 1, 1])
    for (const c of calls) {
      expect(c.deferred).toBeGreaterThan(c.toolCount / 2)
      expect(c.system).toBeGreaterThan(1000)
      expect(c.tools).toBeGreaterThan(1000)
    }
    // the system prompt and the loaded tools are the same on every request; the history grows
    expect(second.system).toBe(first.system)
    expect(second.tools).toBe(first.tools)
    expect(third.history).toBeGreaterThan(second.history)
    expect(second.history).toBeGreaterThan(first.history)
    // the first request reads nothing from the cache, the next reads all the first had
    expect(first.cached).toBe(0)
    expect(second.cached).toBe(first.system + first.tools + first.history + first.found)
    expect(first.calls).toEqual(['pilot.sheet'])
    expect(first.output).toBeGreaterThan(0)
    const s = sessionCost(P.id, calls)
    expect(s).toMatchObject({ calls: 3, turns: 1, input: calls.reduce((a, c) => a + c.system + c.tools + c.found + c.history, 0) })
    expect(s.usd).toBeCloseTo(calls.reduce((a, c) => a + callUsd(c), 0), 10)
    expect(costTable([s])).toContain('calls per person turn: 3.00')
  }, 30_000)

  it('counts a deferred tool\'s definition from its first call on', async () => {
    const calls: CallCost[] = []
    // parts.lookup is not one of the tools that load up front, so the model finds it by search before calling it
    const steps = [{ calls: [{ name: 'parts.lookup', args: { query: 'M3 screw' } }] }, { text: 'An M3 screw.' }]
    await runPrompt(P, { geom: undefined, steps, model: 'claude-haiku-5-5', wrap: (c) => costClient(c, calls, new Set([P.prompt])), tabTools: true })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.found).toBe(0)
    expect(calls[1]!.found).toBeGreaterThan(50)
  }, 30_000)

  it('bills the cached part at a tenth of the input rate, the rest at the cache write rate, and the output', () => {
    const c: CallCost = { turn: 1, system: 1000, tools: 2000, toolCount: 3, deferred: 1, found: 0, history: 1000, output: 100, cached: 3000, calls: [] }
    expect(callUsd(c, HAIKU_5_5)).toBeCloseTo((3000 * 0.1 * 0.1 + 1000 * 0.1 * 1.25 + 100 * 0.5) / 1e6, 12)
  })

  describe('a session priced by the model of each request', () => {
    // 4000 input tokens, nothing cached, 100 out; then 5000 input, 3000 of it read from the cache, 200 out
    const first: CallCost = { turn: 1, system: 1000, tools: 2000, toolCount: 3, deferred: 1, found: 0, history: 1000, output: 100, cached: 0, calls: [] }
    const second: CallCost = { turn: 1, system: 1000, tools: 2000, toolCount: 3, deferred: 1, found: 500, history: 1500, output: 200, cached: 3000, calls: [] }
    // by hand, in dollars: Haiku (0.1 in, 0.5 out) on the first, Sonnet (2 in, 10 out) on the second
    const firstOnHaiku = (4000 * 0.1 * 1.25 + 100 * 0.5) / 1e6
    const secondOnHaiku = (3000 * 0.1 * 0.1 + 2000 * 0.1 * 1.25 + 200 * 0.5) / 1e6
    const secondOnSonnet = (3000 * 2 * 0.1 + 2000 * 2 * 1.25 + 200 * 10) / 1e6

    it('prices each request at its own model, and a refused request has no replayed request', () => {
      expect(firstOnHaiku).toBeCloseTo(0.00055, 12)
      expect(secondOnSonnet).toBeCloseTo(0.0076, 12)
      expect(callUsd(second, SONNET_5_5)).toBeCloseTo(secondOnSonnet, 12)
      const rec = { model: 'claude-haiku-5-5+claude-sonnet-5-5+refused', requestModels: ['claude-haiku-5-5', 'refused', 'claude-sonnet-5-5'] }
      const s = sessionCost('mixed', [first, second], rec)
      expect(s.usd).toBeCloseTo(0.00815, 12)
      expect(s.byModel['claude-haiku-5-5']!.usd).toBeCloseTo(firstOnHaiku, 12)
      expect(s.byModel['claude-sonnet-5-5']).toMatchObject({ calls: 1 })
      expect(s.note).toBeUndefined()
      expect(costTable([s])).not.toContain('~')
    })

    it('flags a mixed session that keeps only its label, and does not print the figure as exact', () => {
      const s = sessionCost('label-only', [first, second], { model: 'claude-haiku-5-5+claude-sonnet-5-5' })
      expect(s.usd).toBeCloseTo(firstOnHaiku + secondOnHaiku, 12)
      expect(s.note).toBe("priced at the first model's rate; the number of requests that ran on another model is unknown")
      const table = costTable([s])
      expect(table).toContain('~0.0009')
      expect(table).toContain("~ label-only: priced at the first model's rate; the number of requests that ran on another model is unknown")
    })

    it('flags a list that does not line up with the replayed requests, and counts one that does but names a model with no price', () => {
      const short = sessionCost('short', [first, second], { model: 'claude-haiku-5-5+claude-sonnet-5-5', requestModels: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'] })
      expect(short.usd).toBeCloseTo(firstOnHaiku + secondOnHaiku, 12)
      expect(short.note).toContain('is unknown')
      const unpriced = sessionCost('unpriced', [first, second], { model: 'claude-haiku-5-5+other-model', requestModels: ['claude-haiku-5-5', 'other-model'] })
      expect(unpriced.usd).toBeCloseTo(firstOnHaiku + secondOnHaiku, 12)
      expect(unpriced.note).toBe("priced at the first model's rate; 1 request ran on another model")
    })

    it('reads a recording\'s request models and refuses a list that is not names', () => {
      const base = { status: 'recorded', model: 'a+b', provider: 'anthropic', capturedAt: 'now', steps: [{ text: 'x' }] }
      const rec = parseRecording(JSON.stringify({ ...base, requestModels: ['a', 'refused', 'b'] }))
      expect(rec.status === 'recorded' && rec.requestModels).toEqual(['a', 'refused', 'b'])
      expect(() => parseRecording(JSON.stringify({ ...base, requestModels: ['a', 2] }))).toThrow(/requestModels/)
    })

    it('leaves a single-model session as it was', () => {
      const plain = sessionCost('one', [first, second])
      expect(plain.usd).toBeCloseTo(firstOnHaiku + secondOnHaiku, 12)
      expect(plain.usd).toBeCloseTo(0.00093, 12)
      for (const rec of [{ model: 'claude-haiku-5-5' }, { model: 'claude-haiku-5-5', requestModels: ['claude-haiku-5-5', 'claude-haiku-5-5'] }]) {
        const s = sessionCost('one', [first, second], rec)
        expect(s.usd).toBe(plain.usd)
        expect(s.note).toBeUndefined()
      }
      expect(costTable([plain])).not.toContain('~')
    })
  })

  it('runs a scripted replay unchanged without the wrapper', async () => {
    const client = createScriptedClient([{ text: 'Built it.' }], { chunk: false })
    const run = await runPrompt(P, { geom: undefined, client })
    expect(client.requests[0]?.toolSearch).toBeUndefined()
    expect(run.reply).toBe('Built it.')
  })
})
