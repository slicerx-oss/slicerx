// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a session's tokens and dollars go, measured from a replay with no model call. costClient wraps the replayed
// client as mimir cloud's (tool search on, the proxy's tool limit), so the runtime builds each request as the desktop
// tab builds it on mimir cloud: the system prompt, the tools that load up front, the rest deferred behind the search
// tool, and the history. Each request is counted with the runtime's own token estimate (@slicerx/pilot context.ts):
// the system prompt, the tools that load, the deferred tools a call found (a found tool's definition joins the chat at
// the search, so every later request carries it), the history, and the reply's text and calls. The provider caches the
// prompt from turn to turn, so the cost reads the part a request shares with the one before as a cache read and the
// rest as a cache write, as mimir cloud bills them (live.ts usageUsd). Thinking and images are not in a replay, so
// both are left out. Each request is priced by its own model where the recording keeps them (requestModels); a mixed
// session without that list is priced at its first model's rate and flagged, never printed as an exact figure.
import type { LlmClient, LlmMessage, LlmRequest } from '@slicerx/pilot'
import { messageTokens, MIMIR_CLOUD_MAX_TOOLS, toolsTokens } from '@slicerx/pilot'
import { HAIKU_5_5, MODEL_PRICES, type Price } from './live'

/** One request, counted. */
export interface CallCost {
  /** The person's message this request answers, counted from 1. */
  turn: number
  system: number
  /** The tools that load up front, with the search tool. */
  tools: number
  /** How many tools the request sends and how many of them wait behind the search. */
  toolCount: number
  deferred: number
  /** The definitions of the deferred tools the chat has found so far. */
  found: number
  history: number
  output: number
  /** The part of the input the request before it shared, read from the cache. */
  cached: number
  /** The tools the reply calls. */
  calls: string[]
}

/** The search tool's own definition, as the provider counts it (a type and a name). */
const SEARCH_TOOL_TOKENS = 20

type ToolDef = LlmRequest['tools'][number]

/** The tokens of a request's tools that load up front. */
const loadedTokens = (tools: readonly ToolDef[], search: boolean): number => toolsTokens(tools.filter((t) => !(search && t.deferred))) + (search ? SEARCH_TOOL_TOKENS : 0)

/** How many leading messages two requests share, byte for byte. */
function sharedMessages(a: readonly LlmMessage[], b: readonly LlmMessage[]): number {
  let n = 0
  while (n < a.length && n < b.length && JSON.stringify(a[n]) === JSON.stringify(b[n])) n++
  return n
}

/** The person's messages so far: a user message that carries one of `people` (the runtime puts the chat's context before it), not one of mimir's own notes. */
const personTurns = (messages: readonly LlmMessage[], people: ReadonlySet<string>): number => messages.filter((m) => m.role === 'user' && [...people].some((p) => m.content.includes(p))).length

/**
 * `inner` as mimir cloud's client: tool search on and the proxy's tool limit. Each request it answers is counted into
 * `calls`; `people` holds the person's messages, so a request is counted against the message it answers.
 */
export function costClient(inner: LlmClient, calls: CallCost[], people: ReadonlySet<string>): LlmClient {
  let before: LlmRequest | undefined
  const found = new Map<string, number>()
  return {
    provider: inner.provider,
    maxTools: MIMIR_CLOUD_MAX_TOOLS,
    toolSearch: true,
    async *stream(req, signal) {
      const search = req.toolSearch === true
      const system = req.messages.filter((m) => m.role === 'system').reduce((a, m) => a + messageTokens(m), 0)
      const rest = req.messages.filter((m) => m.role !== 'system')
      const tools = loadedTokens(req.tools, search)
      const history = rest.reduce((a, m) => a + messageTokens(m), 0)
      const foundNow = [...found.values()].reduce((a, n) => a + n, 0)
      let cached = 0
      if (before && JSON.stringify(before.tools) === JSON.stringify(req.tools) && JSON.stringify(before.messages.filter((m) => m.role === 'system')) === JSON.stringify(req.messages.filter((m) => m.role === 'system'))) {
        const prev = before.messages.filter((m) => m.role !== 'system')
        const shared = sharedMessages(prev, rest)
        cached = system + tools + rest.slice(0, shared).reduce((a, m) => a + messageTokens(m), 0) + foundNow
      }
      const call: CallCost = { turn: personTurns(req.messages, people), system, tools, toolCount: req.tools.length, deferred: search ? req.tools.filter((t) => t.deferred).length : 0, found: foundNow, history, output: 0, cached, calls: [] }
      before = req
      const reply: Extract<LlmMessage, { role: 'assistant' }> = { role: 'assistant', content: '', toolCalls: [] }
      for await (const ev of inner.stream(req, signal)) {
        if (ev.type === 'text') reply.content += ev.delta
        if (ev.type === 'tool_call') {
          call.calls.push(ev.call.name)
          reply.toolCalls!.push(ev.call)
          // a deferred tool is found by a search before its first call, and its definition stays in the chat from then on
          const def = search ? req.tools.find((t) => t.deferred && t.name === ev.call.name) : undefined
          if (def && !found.has(def.name)) found.set(def.name, toolsTokens([def]))
        }
        yield ev
      }
      call.output = messageTokens(reply)
      calls.push(call)
    },
  }
}

/** What a live capture's provider said its requests cost, summed: the real counts, thinking included, where a recording keeps them. */
export function recordedUsage(steps: readonly { usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number } }[]): { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  const kept = steps.flatMap((s) => (s.usage ? [s.usage] : []))
  if (!kept.length) return undefined
  return { requests: kept.length, input: kept.reduce((a, u) => a + u.input, 0), output: kept.reduce((a, u) => a + u.output, 0), cacheRead: kept.reduce((a, u) => a + (u.cacheRead ?? 0), 0), cacheWrite: kept.reduce((a, u) => a + (u.cacheWrite ?? 0), 0) }
}

/** What a recording says about the models behind its requests. */
export interface RecordedModels {
  /** The session's model label: one name, or the names joined by '+' when mimir cloud moved to another (a refused request adds 'refused'). */
  model: string
  /** The model of each request the capture sent, 'refused' for one the proxy refused. */
  requestModels?: readonly string[]
}

/** The model each replayed request ran on, or the note that says why it could not be told. */
export interface RequestPricing {
  /** One model name per replayed request. */
  models: string[]
  note?: string
}

/**
 * Which model each of `requests` replayed requests ran on. A refused request got no reply, so it has no step and no
 * replayed request: dropping the 'refused' entries from `requestModels` leaves one name per replayed request, in order.
 * When that count is not `requests`, or a name has no price, the list is not trusted. A session whose models are not
 * all the first one's is then priced at the first model's rate and says so; one model throughout is priced at its own.
 */
export function requestPricing(rec: RecordedModels, requests: number): RequestPricing {
  const names = rec.model.split('+').filter((m) => m !== 'refused')
  const first = names[0] ?? rec.model
  const list = rec.requestModels?.filter((m) => m !== 'refused')
  const aligned = list !== undefined && list.length === requests
  if (aligned && list.every((m) => MODEL_PRICES[m])) return { models: list }
  const others = aligned ? list.filter((m) => m !== first).length : undefined
  const mixed = names.some((m) => m !== first) || (list?.some((m) => m !== first) ?? false)
  const models = Array.from({ length: requests }, () => first)
  if (!mixed) return { models }
  const count = others === undefined ? 'the number of requests that ran on another model is unknown' : `${others} request${others === 1 ? '' : 's'} ran on another model`
  return { models, note: `priced at the first model's rate; ${count}` }
}

/** A session's requests, summed. */
export interface SessionCost {
  id: string
  calls: number
  turns: number
  system: number
  tools: number
  found: number
  history: number
  input: number
  output: number
  cached: number
  usd: number
  /** Requests and dollars by the model that served them. */
  byModel: Record<string, { calls: number; usd: number }>
  /** Set when the dollars are not exact: the models behind the requests were not all known. */
  note?: string
}

const inputOf = (c: CallCost): number => c.system + c.tools + c.found + c.history

/** What one request bills at `price`: the cached part at 0.1x, the rest written to the cache at 1.25x, and the output. */
export function callUsd(c: CallCost, price: Price = HAIKU_5_5): number {
  const input = inputOf(c)
  const rate = price.long && input > price.long.above ? price.long : price
  return (c.cached * rate.usdIn * 0.1 + (input - c.cached) * rate.usdIn * 1.25 + c.output * rate.usdOut) / 1e6
}

/** A session's counts and dollars. `rec` is the recording's model label and request list; without it every request prices at Haiku 5.5. */
export function sessionCost(id: string, calls: readonly CallCost[], rec?: RecordedModels): SessionCost {
  const sum = (f: (c: CallCost) => number): number => calls.reduce((a, c) => a + f(c), 0)
  const priced: RequestPricing = rec ? requestPricing(rec, calls.length) : { models: calls.map(() => 'claude-haiku-5-5') }
  const byModel: SessionCost['byModel'] = {}
  let usd = 0
  calls.forEach((c, i) => {
    const model = priced.models[i]!
    const u = callUsd(c, MODEL_PRICES[model] ?? HAIKU_5_5)
    const row = (byModel[model] ??= { calls: 0, usd: 0 })
    row.calls++
    row.usd += u
    usd += u
  })
  return {
    id,
    calls: calls.length,
    turns: new Set(calls.map((c) => c.turn)).size,
    system: sum((c) => c.system),
    tools: sum((c) => c.tools),
    found: sum((c) => c.found),
    history: sum((c) => c.history),
    input: sum(inputOf),
    output: sum((c) => c.output),
    cached: sum((c) => c.cached),
    usd,
    byModel,
    ...(priced.note ? { note: priced.note } : {}),
  }
}

const COLUMNS = ['calls', 'turns', 'system', 'tools', 'found', 'history', 'input', 'output', 'cached'] as const

/** The sessions as a table, with the totals and the mean per request under them. */
export function costTable(sessions: readonly SessionCost[]): string {
  // a figure that is not exact reads with a leading ~
  const row = (id: string, s: Pick<SessionCost, (typeof COLUMNS)[number] | 'usd'>, flagged = false): string => `${id.padEnd(24)}${COLUMNS.map((k) => String(Math.round(s[k])).padStart(9)).join('')}${`${flagged ? '~' : ''}${s.usd.toFixed(4)}`.padStart(10)}`
  const total = { calls: 0, turns: 0, system: 0, tools: 0, found: 0, history: 0, input: 0, output: 0, cached: 0, usd: 0 }
  for (const s of sessions) for (const k of [...COLUMNS, 'usd'] as const) total[k] += s[k]
  const per = Object.fromEntries([...COLUMNS, 'usd'].map((k) => [k, total[k as keyof typeof total] / Math.max(1, total.calls)])) as typeof total
  per.calls = 1
  const flagged = sessions.some((s) => s.note !== undefined)
  per.turns = total.turns / Math.max(1, total.calls)
  return [
    `${'session'.padEnd(24)}${COLUMNS.map((k) => k.padStart(9)).join('')}${'usd'.padStart(10)}`,
    ...sessions.map((s) => row(s.id, s, s.note !== undefined)),
    row('total', total, flagged),
    row('per request', per, flagged),
    ...sessions.flatMap((s) => (s.note ? [`~ ${s.id}: ${s.note}`] : [])),
    `calls per person turn: ${(total.calls / Math.max(1, total.turns)).toFixed(2)}`,
  ].join('\n')
}
