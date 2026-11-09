// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The live side of the creative evals: what a reply costs, and the budget that stops a run before its cap.
import type { LlmHttpRequest } from '@slicerx/contracts'
import type { LlmClient, LlmEvent, ToolHost } from '@slicerx/pilot'
import { adapterFor } from '@slicerx/pilot/evals'
import type { CreativePrompt } from './prompts'
import { runPrompt, type PromptRun } from './run'

/** Spend at which no new request starts: the cap less this margin. */
export const STOP_MARGIN_USD = 0.1
export const DEFAULT_CAP_USD = 1.5
/** Hosted web searches one web lookup may run (the adapters ask for at most 3), charged when a reply does not report its count. */
export const SEARCHES_PER_LOOKUP = 3
/** Dollars per hosted web search when the run names no price: $10 per 1,000, as mimir cloud prices them. */
export const DEFAULT_USD_PER_SEARCH = 0.01

// The worst case mimir cloud reserves before a call (supabase/functions/mimir/shape.ts), but for the bytes per token
// (BYTES_PER_TOKEN): the most an image can cost, the provider's tool use overhead, and with web search one more pass
// per search, each carrying the reply so far and every search's results.
const IMAGE_TOKENS = 4784
const TOOL_OVERHEAD = 1000
const SEARCH_RESULT_TOKENS = 30_000
const CONTEXT_TOKENS = 1_000_000
/** Output tokens to assume when a request sets no limit of its own. */
const DEFAULT_MAX_OUTPUT = 32_000

/** Dollars per million tokens. `long` is the higher rate a provider bills once a request's input passes `above` tokens. */
export interface Price {
  usdIn: number
  usdOut: number
  /** Dollars per hosted web search; DEFAULT_USD_PER_SEARCH when unset. */
  usdPerSearch?: number
  long?: { above: number; usdIn: number; usdOut: number }
}

/**
 * mimir's default model, Haiku 5.5, at the prices mimir cloud bills it (supabase/migrations/0020_mimir_proxy.sql
 * mimir_prices): $0.10 and $0.50 per million input and output tokens, $0.50 and $2.50 once a request's input passes
 * 100K tokens, and $0.01 a hosted web search.
 */
export const HAIKU_5_5: Price = { usdIn: 0.1, usdOut: 0.5, usdPerSearch: 0.01, long: { above: 100_000, usdIn: 0.5, usdOut: 2.5 } }

/** Providers whose usage counts cache writes and reads inside `inputTokens`, billed at 1.25x and 0.1x the input rate. */
const CACHE_BILLED = new Set(['anthropic', 'mimir-cloud'])

const rates = (price: Price, inputTokens: number): { usdIn: number; usdOut: number } => (price.long && inputTokens > price.long.above ? price.long : price)

/**
 * What one reply's usage costs. For the Messages API providers this is the sum mimir cloud bills (mimir_cost in
 * supabase/migrations/0020_mimir_proxy.sql): uncached input at the input rate, cache writes at 1.25x, cache reads at
 * 0.1x, the long rates once all input passes the threshold, and each hosted web search. Other providers bill every
 * input token at the input rate, which never undercounts. `lookup` marks a web lookup request: when its reply does
 * not say how many searches ran, the most it may run is charged.
 */
export function usageUsd(provider: string, ev: Extract<LlmEvent, { type: 'usage' }>, price: Price, lookup = false): number {
  const { usdIn, usdOut } = rates(price, ev.inputTokens)
  const searches = (ev.webSearches ?? (lookup ? SEARCHES_PER_LOOKUP : 0)) * (price.usdPerSearch ?? DEFAULT_USD_PER_SEARCH)
  if (!CACHE_BILLED.has(provider)) return (ev.inputTokens * usdIn + ev.outputTokens * usdOut) / 1e6 + searches
  const write = ev.cacheWriteTokens ?? 0
  const read = ev.cacheReadTokens ?? 0
  const plain = Math.max(0, ev.inputTokens - write - read)
  return (plain * usdIn + write * usdIn * 1.25 + read * usdIn * 0.1 + ev.outputTokens * usdOut) / 1e6 + searches
}

/**
 * Bytes of request per input token the reserve counts until a reply reports its own count. A reserve is made before
 * the request goes out, and the eval asks the provider nothing extra to count it (a token count is one more request
 * per step), so it estimates: about 4 bytes a token is the usual rate for English and JSON. A token a byte, the bound
 * mimir cloud reserves at, made a 145 KB tab request (its tools and system prompt alone) look like 145K tokens, past
 * the long rate threshold, so a small cap stopped a build after a tenth of it was spent. Once a reply reports its input
 * tokens, budgetedClient counts at that request's own rate, never under a token per 4 bytes nor over one a byte.
 */
export const BYTES_PER_TOKEN = 4

/**
 * The first request of a run is reserved at a token per byte, the most a body can hold, since no reply has said how
 * dense its text is: a denser request than a token per BYTES_PER_TOKEN bytes would bill more than its reserve and could
 * take the spend past the cap. Only that one request pays for the bound; the count its reply reports sets every later one.
 */
const FIRST_TOKENS_PER_BYTE = 1

/** What a request carries, as the reserve counts it: its body's bytes with each image as a stub, its images, and its output limit. */
export function requestSize(http: LlmHttpRequest): { bytes: number; images: number; maxOut: number } {
  let images = 0
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(http.body ?? '{}') as Record<string, unknown>
  } catch {
    // a body that is not JSON is counted by its bytes alone
  }
  const text = JSON.stringify(body, (_k, v: unknown) => {
    if (v && typeof v === 'object' && (v as { type?: unknown }).type === 'image') {
      images++
      return { type: 'image' }
    }
    return v
  })
  const bytes = new TextEncoder().encode(body && Object.keys(body).length ? text : (http.body ?? '')).length
  const limit = [body['max_tokens'], body['max_output_tokens']].find((n): n is number => typeof n === 'number' && n > 0)
  return { bytes, images, maxOut: limit ?? DEFAULT_MAX_OUTPUT }
}

/**
 * The most one request can cost, from the request as it goes out: its input tokens (its bytes at `tokensPerByte`, a
 * token per BYTES_PER_TOKEN bytes unless a reply said otherwise, the most each image can cost and the tool use
 * overhead) at the cache write rate, priced at the long rates only when those tokens pass the threshold, the request's
 * whole output limit, and for a web lookup every search it may run with their results read back in.
 */
export function worstUsd(provider: string, http: LlmHttpRequest, lookup: boolean, price: Price, tokensPerByte = 1 / BYTES_PER_TOKEN): number {
  const { bytes, images, maxOut } = requestSize(http)
  const prompt = Math.ceil(bytes * tokensPerByte) + images * IMAGE_TOKENS + TOOL_OVERHEAD
  const searches = lookup ? SEARCHES_PER_LOOKUP : 0
  const input = searches ? (searches + 1) * Math.min(prompt + maxOut + searches * SEARCH_RESULT_TOKENS, CONTEXT_TOKENS) : Math.min(prompt, CONTEXT_TOKENS)
  const { usdIn, usdOut } = rates(price, input)
  const inRate = CACHE_BILLED.has(provider) ? usdIn * 1.25 : usdIn
  return (input * inRate + maxOut * usdOut) / 1e6 + searches * (price.usdPerSearch ?? DEFAULT_USD_PER_SEARCH)
}

export interface Budget {
  readonly capUsd: number
  spentUsd: number
  /** The part of `spentUsd` charged at the worst case for replies that ended with no usage (aborted, timed out, cut off). */
  estimatedUsd: number
  /** Replies that ended with no usage. */
  cutOff: number
  /** Set once a request or a prompt was refused for the cap. */
  stopped: boolean
}

export const createBudget = (capUsd: number): Budget => ({ capUsd, spentUsd: 0, estimatedUsd: 0, cutOff: 0, stopped: false })

/** True while new requests may start: the spend is under the cap less the stop margin. */
export const canStart = (b: Budget): boolean => b.spentUsd < b.capUsd - STOP_MARGIN_USD

/**
 * `base` on `model`, keeping `budget`. Before each request the worst case it can cost is reserved: a request whose
 * worst case would take the spend past the cap, or one asked for at or past the cap less the margin, throws instead
 * of reaching the provider. A reply's usage settles the spend at what it cost, so the cap holds real money; a reply
 * that ends with no usage (an abort, the timeout, a reader that stops early) is charged its worst case. The input
 * tokens a reply reports set the tokens per byte the next reserve counts (see BYTES_PER_TOKEN); a web lookup's do not,
 * since they hold the searches' results too. Until one has, requests are reserved at FIRST_TOKENS_PER_BYTE.
 */
export function budgetedClient(base: LlmClient, model: string, price: Price, budget: Budget): LlmClient {
  const adapter = adapterFor(base.provider)
  let tokensPerByte = FIRST_TOKENS_PER_BYTE
  return {
    provider: base.provider,
    async *stream(req, signal) {
      const ask = { ...req, model }
      if (!canStart(budget)) {
        budget.stopped = true
        throw new Error(`stopped at $${budget.spentUsd.toFixed(2)}, the $${budget.capUsd.toFixed(2)} cap less the $${STOP_MARGIN_USD.toFixed(2)} margin`)
      }
      const lookup = Boolean(req.webSearch)
      const http = adapter.build(ask)
      const reserve = worstUsd(base.provider, http, lookup, price, tokensPerByte)
      if (budget.spentUsd + reserve > budget.capUsd) {
        budget.stopped = true
        throw new Error(`stopped at $${budget.spentUsd.toFixed(2)}: the next request could cost up to $${reserve.toFixed(2)}, past the $${budget.capUsd.toFixed(2)} cap`)
      }
      let settled = false
      try {
        for await (const ev of base.stream(ask, signal)) {
          if (ev.type === 'usage' && !settled) {
            settled = true
            budget.spentUsd += usageUsd(base.provider, ev, price, lookup)
            const size = requestSize(http)
            const text = ev.inputTokens - size.images * IMAGE_TOKENS
            if (!lookup && size.bytes > 0 && text > 0) tokensPerByte = Math.min(1, Math.max(1 / BYTES_PER_TOKEN, text / size.bytes))
          }
          yield ev
        }
      } finally {
        if (!settled) {
          budget.spentUsd += reserve
          budget.estimatedUsd += reserve
          budget.cutOff++
        }
      }
    },
  }
}

/** Runs the prompts in order on a budgeted client; no prompt starts once the budget says stop, and the run ends there. */
export async function* runLive(prompts: readonly CreativePrompt[], opts: { geom: ToolHost['geom']; client: LlmClient; budget: Budget; timeoutMs?: number; defaultAnswer?: boolean }): AsyncGenerator<{ prompt: CreativePrompt; run: PromptRun }> {
  for (const prompt of prompts) {
    if (!canStart(opts.budget)) {
      opts.budget.stopped = true
      return
    }
    const run = await runPrompt(prompt, { geom: opts.geom, client: opts.client, ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }), ...(opts.defaultAnswer === undefined ? {} : { defaultAnswer: opts.defaultAnswer }) })
    yield { prompt, run }
    if (opts.budget.stopped) return
  }
}
