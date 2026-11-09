// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The creative evals' live budget: reply prices, the worst case reserved before each request, the charge for a cut-off
// reply, and the stop at the cap less the margin, all on fake priced transports with no network.
import type { LlmHttpRequest, LlmTransport } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { budgetedClient, canStart, createBudget, DEFAULT_USD_PER_SEARCH, HAIKU_5_5, runLive, SEARCHES_PER_LOOKUP, STOP_MARGIN_USD, usageUsd, worstUsd, type Price } from '../evals/creative/live'
import { CREATIVE_PROMPTS } from '../evals/creative/prompts'
import { loadRecording } from '../evals/creative/recordings'
import { runPrompt } from '../evals/creative/run'
import { createAnthropicAdapter, createScriptedClient, createTransportClient, type LlmEvent, type LlmRequest } from '@slicerx/pilot'

const PRICE: Price = { usdIn: 1, usdOut: 5 }
const enc = new TextEncoder()

type Usage = { input_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens: number; server_tool_use?: { web_search_requests: number } }

/** A Messages API text reply with `usage`; `search` adds the usage's hosted search count on the closing delta. */
function reply(usage: Usage, search?: number): string {
  const events = [
    { type: 'message_start', message: { usage: { ...usage, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Here is a sketch.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output_tokens, ...(search === undefined ? {} : { server_tool_use: { web_search_requests: search } }) } },
    { type: 'message_stop' },
  ]
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

/**
 * $0.25 at PRICE when cache tokens are billed the way mimir cloud bills them: 100k plain input ($0.10), 40k cache
 * writes at 1.25x ($0.05), 500k cache reads at 0.1x ($0.05) and 10k output ($0.05). The full input rate would make it $0.69.
 */
const QUARTER: Usage = { input_tokens: 100_000, cache_creation_input_tokens: 40_000, cache_read_input_tokens: 500_000, output_tokens: 10_000 }

/** A transport with no network: each request gets `body(req)`, and the spend when it started is noted. */
function fakeTransport(spentAtStart: () => number, body: (req: LlmHttpRequest) => string): { transport: LlmTransport; started: number[]; sent: LlmHttpRequest[] } {
  const started: number[] = []
  const sent: LlmHttpRequest[] = []
  const transport: LlmTransport = {
    available: async () => true,
    async *stream(req) {
      started.push(spentAtStart())
      sent.push(req)
      yield enc.encode(body(req))
    },
  }
  return { transport, started, sent }
}

const ASK: LlmRequest = { model: 'x', messages: [{ role: 'user', content: 'hi' }], tools: [] }
const LOOKUP: LlmRequest = { ...ASK, webSearch: true, maxOutputTokens: 1200 }

async function drain(it: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
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

  it('prices the hosted web searches a reply reports, and the most a lookup may run when it reports none', () => {
    const plain = usageUsd('anthropic', usage, PRICE)
    expect(usageUsd('anthropic', { ...usage, webSearches: 2 }, PRICE)).toBeCloseTo(plain + 2 * DEFAULT_USD_PER_SEARCH, 10)
    expect(usageUsd('anthropic', { ...usage, webSearches: 2 }, PRICE, true)).toBeCloseTo(plain + 2 * DEFAULT_USD_PER_SEARCH, 10)
    expect(usageUsd('anthropic', usage, PRICE, true)).toBeCloseTo(plain + SEARCHES_PER_LOOKUP * DEFAULT_USD_PER_SEARCH, 10)
    expect(usageUsd('openai', usage, { ...PRICE, usdPerSearch: 0.025 }, true)).toBeCloseTo(0.69 + 3 * 0.025, 10)
    expect(usageUsd('anthropic', usage, PRICE)).toBe(plain)
  })

  it('the Messages API adapter reads the search count from the usage', async () => {
    const { transport } = fakeTransport(() => 0, () => reply(QUARTER, 2))
    const events = await drain(createTransportClient(transport, 'anthropic').stream(LOOKUP))
    expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', inputTokens: 640_000, outputTokens: 10_000, cacheReadTokens: 500_000, cacheWriteTokens: 40_000, webSearches: 2 })
    const { transport: none } = fakeTransport(() => 0, () => reply(QUARTER))
    expect((await drain(createTransportClient(none, 'anthropic').stream(LOOKUP))).find((e) => e.type === 'usage')).not.toHaveProperty('webSearches')
  })

  it('the worst case is a token per 4 body bytes as cache writes plus the whole output limit, and a lookup adds its searches', () => {
    const http = createAnthropicAdapter().build({ ...ASK, maxOutputTokens: 4000 })
    const prompt = Math.ceil(enc.encode(JSON.stringify(JSON.parse(http.body ?? '{}'))).length / 4) + 1000
    expect(worstUsd('anthropic', http, false, PRICE)).toBeCloseTo((prompt * 1.25 + 4000 * 5) / 1e6, 12)
    expect(worstUsd('openai', http, false, PRICE)).toBeCloseTo((prompt + 4000 * 5) / 1e6, 12)
    const look = createAnthropicAdapter().build(LOOKUP)
    const lp = Math.ceil(enc.encode(JSON.stringify(JSON.parse(look.body ?? '{}'))).length / 4) + 1000
    expect(worstUsd('anthropic', look, true, PRICE)).toBeCloseTo((4 * (lp + 1200 + 3 * 30_000) * 1.25 + 1200 * 5) / 1e6 + 3 * DEFAULT_USD_PER_SEARCH, 12)
    // a reply's own count of its input tokens, as tokens per byte, takes the place of the 4 bytes
    expect(worstUsd('anthropic', http, false, PRICE, 0.5)).toBeCloseTo(((Math.ceil(enc.encode(JSON.stringify(JSON.parse(http.body ?? '{}'))).length / 2) + 1000) * 1.25 + 4000 * 5) / 1e6, 12)
  })

  it('prices a request at the long rates only once its estimated input tokens pass the threshold, not its bytes', () => {
    const sized = (bytes: number) => createAnthropicAdapter().build({ ...ASK, maxOutputTokens: 1000, messages: [{ role: 'user', content: 'x'.repeat(bytes) }] })
    const tokens = (http: LlmHttpRequest) => Math.ceil(enc.encode(JSON.stringify(JSON.parse(http.body ?? '{}'))).length / 4) + 1000
    // 300 KB is about 75K tokens: under Haiku 5.5's 100K, so the short rates
    const mid = sized(300_000)
    expect(worstUsd('anthropic', mid, false, HAIKU_5_5)).toBeCloseTo((tokens(mid) * 0.1 * 1.25 + 1000 * 0.5) / 1e6, 12)
    // 500 KB is about 125K tokens: the long rates
    const big = sized(500_000)
    expect(worstUsd('anthropic', big, false, HAIKU_5_5)).toBeCloseTo((tokens(big) * 0.5 * 1.25 + 1000 * 2.5) / 1e6, 12)
  })
})

/** The requests mimir sends for a creative prompt's recorded replies, as the tab makes them; the engine is left out. */
async function recordedRequests(id: string): Promise<LlmRequest[]> {
  const rec = loadRecording(id)
  if (rec.status !== 'recorded') throw new Error(`${id} has no recording`)
  const inner = createScriptedClient(rec.steps, { chunk: false })
  const sent: LlmRequest[] = []
  const client = {
    provider: 'anthropic',
    async *stream(req: LlmRequest, signal?: AbortSignal) {
      sent.push(req)
      yield* inner.stream(req, signal)
    },
  }
  const p = CREATIVE_PROMPTS.find((x) => x.id === id)!
  await runPrompt(p, { geom: undefined, client, defaultAnswer: false })
  return sent
}

describe('a long recorded build on a small cap', () => {
  it('reserves a long tab request at its estimated tokens and the short rates, a cent and not a dime', async () => {
    const sent = await recordedRequests('flexi-fish')
    const http = createAnthropicAdapter().build({ ...sent.at(-1)!, model: 'claude-haiku-5-5' })
    const bytes = enc.encode(JSON.stringify(JSON.parse(http.body ?? '{}'))).length
    // the tab's tools and system prompt alone are well over 100 KB, so a token a byte would price it long
    expect(bytes).toBeGreaterThan(150_000)
    const maxOut = (JSON.parse(http.body ?? '{}') as { max_tokens: number }).max_tokens
    const reserve = worstUsd('anthropic', http, false, HAIKU_5_5)
    expect(reserve).toBeCloseTo(((Math.ceil(bytes / 4) + 1000) * 0.1 * 1.25 + maxOut * 0.5) / 1e6, 12)
    expect(reserve).toBeLessThan(0.02)
  })

  it('carries a build on a $0.20 cap until its real spend nears the cap, then stops at the margin', async () => {
    const sent = await recordedRequests('flexi-fish')
    const req = sent.at(-1)!
    const budget = createBudget(0.2)
    // each reply bills what the request really holds: a token per 4 bytes, mostly read from the cache, and 2,000 out
    const { transport, started } = fakeTransport(
      () => budget.spentUsd,
      (http) => {
        const input = Math.ceil(enc.encode(JSON.stringify(JSON.parse(http.body ?? '{}'))).length / 4)
        return reply({ input_tokens: 2_000, cache_read_input_tokens: input - 2_000, output_tokens: 2_000 })
      },
    )
    const client = budgetedClient(createTransportClient(transport, 'anthropic'), 'claude-haiku-5-5', HAIKU_5_5, budget)
    let refused = ''
    for (let i = 0; i < 200 && !refused; i++) {
      try {
        await drain(client.stream(req))
      } catch (e) {
        refused = e instanceof Error ? e.message : String(e)
      }
    }
    // a token a byte at the long rates reserved about $0.12 a request, so the run stopped near $0.08 of real spend
    expect(started.length).toBeGreaterThan(20)
    expect(budget.spentUsd).toBeGreaterThan(0.2 - STOP_MARGIN_USD - 0.01)
    expect(budget.spentUsd).toBeLessThanOrEqual(0.2)
    expect(refused).toMatch(/cap less the \$0\.10 margin|past the \$0\.20 cap/)
    expect(budget.cutOff).toBe(0)
  })

  it('reserves at the density the last reply reported, when that is more than a token per 4 bytes', async () => {
    const budget = createBudget(1.5)
    const http = createAnthropicAdapter().build({ ...ASK, model: 'test-model' })
    const bytes = enc.encode(JSON.stringify(JSON.parse(http.body ?? '{}'))).length
    let calls = 0
    // the first reply says the request was a token every 2 bytes; the second is read only to its first text, so it is
    // charged its reserve
    const transport: LlmTransport = {
      available: async () => true,
      async *stream() {
        calls++
        yield enc.encode(calls === 1 ? reply({ input_tokens: Math.ceil(bytes / 2), output_tokens: 10 }) : reply(QUARTER))
      },
    }
    const client = budgetedClient(createTransportClient(transport, 'anthropic'), 'test-model', PRICE, budget)
    await drain(client.stream(ASK))
    const before = budget.spentUsd
    for await (const ev of client.stream(ASK)) if (ev.type === 'text') break
    expect(budget.cutOff).toBe(1)
    expect(budget.spentUsd - before).toBeCloseTo(worstUsd('anthropic', http, false, PRICE, Math.ceil(bytes / 2) / bytes), 12)
    expect(budget.spentUsd - before).toBeGreaterThan(worstUsd('anthropic', http, false, PRICE))
  })
})

describe('the first request of a run', () => {
  it('never takes the spend past the cap, even when it is denser than a token per 4 bytes', async () => {
    const capUsd = 1
    const budget = createBudget(capUsd)
    // earlier spend leaves $0.15 under the cap, and the stop margin is not yet reached
    budget.spentUsd = 0.85
    // a dense request: 400 KB of text. At a token per 4 bytes it looks like about $0.13, which fits under the cap
    const dense: LlmRequest = { model: 'x', messages: [{ role: 'user', content: 'x'.repeat(400_000) }], tools: [], maxOutputTokens: 1 }
    const price: Price = { usdIn: 1, usdOut: 0 }
    const bytes = enc.encode(createAnthropicAdapter().build({ ...dense, model: 'x' }).body ?? '').length
    // the reply reports a token every 2 bytes, so the request really bills about $0.2
    const { transport, started } = fakeTransport(() => budget.spentUsd, () => reply({ input_tokens: Math.ceil(bytes / 2), output_tokens: 1 }))
    const client = budgetedClient(createTransportClient(transport, 'anthropic'), 'x', price, budget)
    let refused = ''
    try {
      await drain(client.stream(dense))
    } catch (e) {
      refused = e instanceof Error ? e.message : String(e)
    }
    expect(budget.spentUsd).toBeLessThanOrEqual(capUsd)
    expect(started).toHaveLength(0)
    expect(refused).toMatch(/past the \$1\.00 cap/)
    expect(budget.stopped).toBe(true)
  })

  it('is reserved at a token per byte, the most a body can hold, until a reply reports its own count', async () => {
    const budget = createBudget(1.5)
    const http = createAnthropicAdapter().build({ ...ASK, model: 'test-model' })
    const bytes = enc.encode(JSON.stringify(JSON.parse(http.body ?? '{}'))).length
    const transport: LlmTransport = {
      available: async () => true,
      async *stream() {
        yield enc.encode(reply({ input_tokens: Math.ceil(bytes / 3), output_tokens: 10 }))
      },
    }
    // cut off after its first text, so the request is charged its reserve
    for await (const ev of budgetedClient(createTransportClient(transport, 'anthropic'), 'test-model', PRICE, budget).stream(ASK)) if (ev.type === 'text') break
    expect(budget.cutOff).toBe(1)
    expect(budget.spentUsd).toBeCloseTo(worstUsd('anthropic', http, false, PRICE, 1), 12)
  })
})

describe('the live budget', () => {
  it('a live run stops starting requests at the cap less the margin, partway through the prompt set', async () => {
    const capUsd = 1
    const budget = createBudget(capUsd)
    // $0.25 a reply, all of it cache reads (50M at 0.1x of $0.05), so each request's worst case (its body as cache
    // writes at $0.0625 a million) stays far under the $0.25 left at $0.75 and only the margin stops the run
    const { transport, started, sent } = fakeTransport(() => budget.spentUsd, () => reply({ input_tokens: 0, cache_read_input_tokens: 50_000_000, output_tokens: 10 }))
    const client = budgetedClient(createTransportClient(transport, 'anthropic'), 'test-model', { usdIn: 0.05, usdOut: 0 }, budget)
    const prompts = CREATIVE_PROMPTS.slice(0, 8)
    const ran: string[] = []
    for await (const { prompt } of runLive(prompts, { geom: undefined, client, budget })) ran.push(prompt.id)

    // $0.25 a reply against a stop at $0.90: the 4th request starts at $0.75, and none starts at $1.00
    expect(started.map((s) => Math.round(s * 1e9) / 1e9)).toEqual([0, 0.25, 0.5, 0.75])
    expect(started.every((s) => s < capUsd - STOP_MARGIN_USD)).toBe(true)
    expect(budget.spentUsd).toBeCloseTo(1, 10)
    expect(budget.stopped).toBe(true)
    expect(budget.cutOff).toBe(0)
    expect(canStart(budget)).toBe(false)
    expect(ran).toEqual(prompts.slice(0, 4).map((p) => p.id))
    // every request went out on the model the run asked for
    expect(sent.every((r) => (JSON.parse(String(r.body)) as { model: string }).model === 'test-model')).toBe(true)
  })

  it('a run never goes past the cap: a request whose worst case would overshoot it does not start', async () => {
    const capUsd = 1
    const budget = createBudget(capUsd)
    // every reply costs exactly its request's worst case: the whole body as cache writes and the whole output limit
    const worst = (req: LlmHttpRequest): string => {
      const body = JSON.parse(req.body ?? '{}') as { max_tokens: number }
      return reply({ input_tokens: 0, cache_creation_input_tokens: enc.encode(JSON.stringify(body)).length + 1000, output_tokens: body.max_tokens })
    }
    const prompts = CREATIVE_PROMPTS.slice(0, 8)
    // one prompt at $1 a million input and no output price measures what a request's body costs as cache writes
    const probe = createBudget(100)
    const { transport: pt } = fakeTransport(() => probe.spentUsd, worst)
    for await (const r of runLive(prompts.slice(0, 1), { geom: undefined, client: budgetedClient(createTransportClient(pt, 'anthropic'), 'test-model', { usdIn: 1, usdOut: 0 }, probe), budget: probe })) void r
    expect(probe.cutOff).toBe(0)
    // priced so each request costs about $0.35: two run, and the 3rd, asked for at $0.70 under the $0.90 stop, would end near $1.05
    const price: Price = { usdIn: 0.35 / probe.spentUsd, usdOut: 0 }
    const { transport, started } = fakeTransport(() => budget.spentUsd, worst)
    const refused: string[] = []
    const inner = budgetedClient(createTransportClient(transport, 'anthropic'), 'test-model', price, budget)
    const client = {
      provider: inner.provider,
      async *stream(req: LlmRequest, signal?: AbortSignal) {
        try {
          yield* inner.stream(req, signal)
        } catch (e) {
          refused.push(e instanceof Error ? e.message : String(e))
          throw e
        }
      },
    }
    const ran: string[] = []
    for await (const { prompt } of runLive(prompts, { geom: undefined, client, budget })) ran.push(prompt.id)

    expect(started).toHaveLength(2)
    expect(budget.spentUsd).toBeCloseTo(0.7, 2)
    expect(budget.spentUsd).toBeLessThanOrEqual(capUsd)
    // the stop came from the reserve, under the margin stop, so without it the 3rd request would have gone out
    expect(budget.spentUsd).toBeLessThan(capUsd - STOP_MARGIN_USD)
    expect(refused).toEqual([expect.stringMatching(/^stopped at \$0\.(69|70|71): the next request could cost up to \$0\.3[45], past the \$1\.00 cap$/)])
    expect(budget.stopped).toBe(true)
    expect(budget.cutOff).toBe(0)
    expect(ran).toEqual(prompts.slice(0, 3).map((p) => p.id))
  })

  it('a reply aborted before its usage arrived is charged its worst case', async () => {
    const budget = createBudget(1.5)
    const price: Price = { usdIn: 0.1, usdOut: 0.5 }
    // the reply stops after its first text and waits, as a stalled connection does, until the run aborts it
    const transport: LlmTransport = {
      available: async () => true,
      async *stream(_req, signal) {
        yield enc.encode(reply(QUARTER).split('event: content_block_stop')[0]!)
        await new Promise<void>((_resolve, reject) => {
          const stop = () => reject(new DOMException('aborted', 'AbortError'))
          if (signal?.aborted) stop()
          else signal?.addEventListener('abort', stop)
        })
      },
    }
    const client = budgetedClient(createTransportClient(transport, 'anthropic'), 'test-model', price, budget)
    const ac = new AbortController()
    const seen: LlmEvent[] = []
    const read = (async () => {
      for await (const ev of client.stream(ASK, ac.signal)) {
        seen.push(ev)
        if (ev.type === 'text') ac.abort()
      }
    })()
    await expect(read).rejects.toThrow()
    const reserve = worstUsd('anthropic', createAnthropicAdapter().build({ ...ASK, model: 'test-model' }), false, price, 1)
    expect(seen.some((e) => e.type === 'usage')).toBe(false)
    expect(budget.spentUsd).toBeCloseTo(reserve, 12)
    expect(budget.estimatedUsd).toBeCloseTo(reserve, 12)
    expect(budget.cutOff).toBe(1)
  })

  it('a reader that stops early, as a failed web lookup does, still pays for the request', async () => {
    const budget = createBudget(1.5)
    const { transport, started } = fakeTransport(() => budget.spentUsd, () => reply(QUARTER))
    const client = budgetedClient(createTransportClient(transport, 'anthropic'), 'test-model', PRICE, budget)
    for await (const ev of client.stream(LOOKUP)) if (ev.type === 'text') break
    expect(started).toEqual([0])
    expect(budget.cutOff).toBe(1)
    expect(budget.spentUsd).toBeCloseTo(worstUsd('anthropic', createAnthropicAdapter().build({ ...LOOKUP, model: 'test-model' }), true, PRICE, 1), 12)
  })

  it('a lookup whose reply reports no search count is charged the most it may run', async () => {
    const budget = createBudget(1.5)
    const { transport } = fakeTransport(() => budget.spentUsd, () => reply(QUARTER))
    const client = budgetedClient(createTransportClient(transport, 'anthropic'), 'test-model', PRICE, budget)
    await drain(client.stream(LOOKUP))
    expect(budget.spentUsd).toBeCloseTo(0.25 + SEARCHES_PER_LOOKUP * DEFAULT_USD_PER_SEARCH, 10)
    const counted = createBudget(1.5)
    const { transport: t2 } = fakeTransport(() => counted.spentUsd, () => reply(QUARTER, 1))
    await drain(budgetedClient(createTransportClient(t2, 'anthropic'), 'test-model', PRICE, counted).stream(LOOKUP))
    expect(counted.spentUsd).toBeCloseTo(0.25 + DEFAULT_USD_PER_SEARCH, 10)
    expect(counted.cutOff).toBe(0)
  })

  it('a request asked for at the stop throws before it reaches the transport', async () => {
    const budget = createBudget(1)
    budget.spentUsd = 1 - STOP_MARGIN_USD
    const { transport, started } = fakeTransport(() => budget.spentUsd, () => reply(QUARTER))
    const client = budgetedClient(createTransportClient(transport, 'anthropic'), 'test-model', PRICE, budget)
    await expect(drain(client.stream(ASK))).rejects.toThrow('stopped at $0.90, the $1.00 cap less the $0.10 margin')
    expect(started).toEqual([])
    expect(budget.stopped).toBe(true)
    expect(budget.cutOff).toBe(0)
  })
})
