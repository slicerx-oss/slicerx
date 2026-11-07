// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The live side of the creative evals: what a reply costs, and the budget that stops a run before its cap.
import type { ToolHost } from '../../src/tool'
import type { LlmClient, LlmEvent } from '../../src/provider/types'
import type { CreativePrompt } from './prompts'
import { runPrompt, type PromptRun } from './run'

/** Spend at which no new request starts: the cap less this margin. */
export const STOP_MARGIN_USD = 0.1
export const DEFAULT_CAP_USD = 1.5

/** Dollars per million tokens. `long` is the higher rate a provider bills once a request's input passes `above` tokens. */
export interface Price {
  usdIn: number
  usdOut: number
  long?: { above: number; usdIn: number; usdOut: number }
}

/** Providers whose usage counts cache writes and reads inside `inputTokens`, billed at 1.25x and 0.1x the input rate. */
const CACHE_BILLED = new Set(['anthropic', 'mimir-cloud'])

/**
 * What one reply's usage costs. For the Messages API providers this is the sum mimir cloud bills (mimir_cost in
 * supabase/migrations/0020_mimir_proxy.sql): uncached input at the input rate, cache writes at 1.25x, cache reads at
 * 0.1x, and the long rates once all input passes the threshold. Other providers bill every input token at the input
 * rate, which never undercounts.
 */
export function usageUsd(provider: string, ev: Extract<LlmEvent, { type: 'usage' }>, price: Price): number {
  const long = price.long && ev.inputTokens > price.long.above ? price.long : undefined
  const usdIn = long?.usdIn ?? price.usdIn
  const usdOut = long?.usdOut ?? price.usdOut
  if (!CACHE_BILLED.has(provider)) return (ev.inputTokens * usdIn + ev.outputTokens * usdOut) / 1e6
  const write = ev.cacheWriteTokens ?? 0
  const read = ev.cacheReadTokens ?? 0
  const plain = Math.max(0, ev.inputTokens - write - read)
  return (plain * usdIn + write * usdIn * 1.25 + read * usdIn * 0.1 + ev.outputTokens * usdOut) / 1e6
}

export interface Budget {
  readonly capUsd: number
  spentUsd: number
  /** Set once a request or a prompt was refused for the cap. */
  stopped: boolean
}

export const createBudget = (capUsd: number): Budget => ({ capUsd, spentUsd: 0, stopped: false })

/** True while new requests may start: the spend is under the cap less the stop margin. */
export const canStart = (b: Budget): boolean => b.spentUsd < b.capUsd - STOP_MARGIN_USD

/**
 * `base` on `model`, adding each reply's cost to `budget`. A request that would start at or past the cap less the
 * margin throws instead of reaching the provider.
 */
export function budgetedClient(base: LlmClient, model: string, price: Price, budget: Budget): LlmClient {
  return {
    provider: base.provider,
    async *stream(req, signal) {
      if (!canStart(budget)) {
        budget.stopped = true
        throw new Error(`stopped at $${budget.spentUsd.toFixed(2)}, the $${budget.capUsd.toFixed(2)} cap less the $${STOP_MARGIN_USD.toFixed(2)} margin`)
      }
      for await (const ev of base.stream({ ...req, model }, signal)) {
        if (ev.type === 'usage') budget.spentUsd += usageUsd(base.provider, ev, price)
        yield ev
      }
    },
  }
}

/** Runs the prompts in order on a budgeted client; no prompt starts once the budget says stop, and the run ends there. */
export async function* runLive(prompts: readonly CreativePrompt[], opts: { geom: ToolHost['geom']; client: LlmClient; budget: Budget; timeoutMs?: number }): AsyncGenerator<{ prompt: CreativePrompt; run: PromptRun }> {
  for (const prompt of prompts) {
    if (!canStart(opts.budget)) {
      opts.budget.stopped = true
      return
    }
    const run = await runPrompt(prompt, { geom: opts.geom, client: opts.client, ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) })
    yield { prompt, run }
    if (opts.budget.stopped) return
  }
}
