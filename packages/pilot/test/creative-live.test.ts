// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The creative evals' live budget: reply prices and the stop at the cap less the margin, on a fake priced transport.
import type { LlmHttpRequest, LlmTransport } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { budgetedClient, canStart, createBudget, runLive, STOP_MARGIN_USD, usageUsd, type Price } from '../evals/creative/live'
import { CREATIVE_PROMPTS } from '../evals/creative/prompts'
import { createTransportClient } from '../src/provider/client'

const PRICE: Price = { usdIn: 1, usdOut: 5 }

/**
 * Every reply costs $0.25 at PRICE when cache tokens are billed the way mimir cloud bills them: 100k plain input
 * ($0.10), 40k cache writes at 1.25x ($0.05), 500k cache reads at 0.1x ($0.05) and 10k output ($0.05). Billing every
 * input token at the full rate would make it $0.69.
 */
function pricedReply(): string {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 100_000, cache_creation_input_tokens: 40_000, cache_read_input_tokens: 500_000, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Here is a sketch.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10_000 } },
    { type: 'message_stop' },
  ]
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

/** A transport with no network: every request gets the priced reply, and the spend when it started is noted. */
function fakeTransport(spentAtStart: () => number): { transport: LlmTransport; started: number[]; sent: LlmHttpRequest[] } {
  const started: number[] = []
  const sent: LlmHttpRequest[] = []
  const transport: LlmTransport = {
    available: async () => true,
    async *stream(req) {
      started.push(spentAtStart())
      sent.push(req)
      yield new TextEncoder().encode(pricedReply())
    },
  }
  return { transport, started, sent }
}

describe('reply prices', () => {
  const usage = { type: 'usage' as const, inputTokens: 640_000, outputTokens: 10_000, cacheWriteTokens: 40_000, cacheReadTokens: 500_000 }

  it('bills cache writes at 1.25x and reads at 0.1x the input rate for the Messages API, as mimir cloud does', () => {
    expect(usageUsd('anthropic', usage, PRICE)).toBeCloseTo(0.25, 10)
    expect(usageUsd('mimir-cloud', usage, PRICE)).toBeCloseTo(0.25, 10)
    // mimir's default model at its published rates, $0.10 and $0.50 per million
    expect(usageUsd('anthropic', { type: 'usage', inputTokens: 30_000, outputTokens: 2_000, cacheWriteTokens: 0, cacheReadTokens: 25_000 }, { usdIn: 0.1, usdOut: 0.5 })).toBeCloseTo((5_000 * 0.1 + 25_000 * 0.01 + 2_000 * 0.5) / 1e6, 12)
  })

  it('bills every input token at the input rate for the other providers', () => {
    expect(usageUsd('openai', usage, PRICE)).toBeCloseTo(0.69, 10)
    expect(usageUsd('openai-compatible', usage, { usdIn: 0, usdOut: 0 })).toBe(0)
  })

  it('moves to the long rates once all input, cache included, passes the threshold', () => {
    const long: Price = { ...PRICE, long: { above: 200_000, usdIn: 2, usdOut: 10 } }
    expect(usageUsd('anthropic', usage, long)).toBeCloseTo(0.5, 10)
    expect(usageUsd('anthropic', { ...usage, inputTokens: 200_000, cacheReadTokens: 60_000 }, long)).toBeCloseTo((100_000 + 40_000 * 1.25 + 60_000 * 0.1) / 1e6 + 0.05, 10)
  })
})

describe('the live budget', () => {
  it('a live run stops starting requests at the cap less the margin, partway through the prompt set', async () => {
    const capUsd = 1
    const budget = createBudget(capUsd)
    const { transport, started, sent } = fakeTransport(() => budget.spentUsd)
    const client = budgetedClient(createTransportClient(transport, 'anthropic'), 'test-model', PRICE, budget)
    const prompts = CREATIVE_PROMPTS.slice(0, 8)
    const ran: string[] = []
    for await (const { prompt } of runLive(prompts, { geom: undefined, client, budget })) ran.push(prompt.id)

    // $0.25 a reply against a stop at $0.90: the 4th request starts at $0.75, and none starts at $1.00
    expect(started).toEqual([0, 0.25, 0.5, 0.75])
    expect(started.every((s) => s < capUsd - STOP_MARGIN_USD)).toBe(true)
    expect(budget.spentUsd).toBeCloseTo(1, 10)
    expect(budget.stopped).toBe(true)
    expect(canStart(budget)).toBe(false)
    expect(ran.length).toBeGreaterThan(0)
    expect(ran.length).toBeLessThan(prompts.length)
    expect(ran).toEqual(prompts.slice(0, ran.length).map((p) => p.id))
    // every request went out on the model the run asked for
    expect(sent.every((r) => (JSON.parse(String(r.body)) as { model: string }).model === 'test-model')).toBe(true)
  })

  it('a request asked for at the stop throws before it reaches the transport', async () => {
    const budget = createBudget(1)
    budget.spentUsd = 1 - STOP_MARGIN_USD
    const { transport, started } = fakeTransport(() => budget.spentUsd)
    const client = budgetedClient(createTransportClient(transport, 'anthropic'), 'test-model', PRICE, budget)
    const read = async () => {
      for await (const ev of client.stream({ model: 'x', messages: [{ role: 'user', content: 'hi' }], tools: [] })) void ev
    }
    await expect(read()).rejects.toThrow('stopped at $0.90, the $1.00 cap less the $0.10 margin')
    expect(started).toEqual([])
    expect(budget.stopped).toBe(true)
  })

  it('just under the stop a request still goes out', async () => {
    const budget = createBudget(1)
    budget.spentUsd = 0.89
    const { transport, started } = fakeTransport(() => budget.spentUsd)
    const client = budgetedClient(createTransportClient(transport, 'anthropic'), 'test-model', PRICE, budget)
    for await (const ev of client.stream({ model: 'x', messages: [{ role: 'user', content: 'hi' }], tools: [] })) void ev
    expect(started).toEqual([0.89])
    expect(budget.spentUsd).toBeCloseTo(1.14, 10)
    expect(budget.stopped).toBe(false)
    expect(canStart(budget)).toBe(false)
  })
})
