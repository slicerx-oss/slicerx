// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Anthropic Messages API adapter with streaming and tools. The transport adds
// `x-api-key` and `anthropic-version` (and, in a browser,
// `anthropic-dangerous-direct-browser-access`); this code never sees a key.
// Thinking blocks and server tool blocks are kept whole on the assistant message
// (`raw`) because their signatures must be sent back unchanged.
import type { LlmHttpRequest } from '@slicerx/contracts'
import { decodeToolName, encodeToolName } from './openai'
import { parseSse } from './sse'
import type { LlmAdapter, LlmEvent, LlmRequest, LlmStop } from './types'

const DEFAULT_BASE = 'https://api.anthropic.com'
const BUDGET = { low: 2048, medium: 8192, high: 16000 } as const
// a reply's room when a current model thinks adaptively and nothing else is set: a design turn's thinking can run past
// 16000 before its first tool call; a reply is billed for what it uses
export const ADAPTIVE_OUTPUT = 32000
const EPHEMERAL = { type: 'ephemeral' } as const
/** The tool search tool a `toolSearch` request carries, never deferred. */
export const TOOL_SEARCH_TOOL = { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' } as const
/** The beta that takes tool_addition and tool_removal blocks by reference in a system message. */
export const TOOL_CHANGES_BETA = 'mid-conversation-tool-changes-2026-07-01'

/**
 * Models that take tool search and tool changes in a mid-chat system message both, so a chat on one can send its whole
 * catalog once and change it only by appending.
 */
export function toolSearchModel(model: string): boolean {
  return /^claude-(fable|mythos)-5(-|$)|^claude-(opus-5|sonnet-5-5|haiku-5-5|opus-4-8)(-|$)/.test(model)
}

/** Models that think adaptively and take `output_config.effort`; `budget_tokens` is a 400 on them. */
export function adaptiveThinking(model: string): boolean {
  return /^claude-(fable|mythos|opus|sonnet|haiku)-5(-|$)|^claude-(opus-4-[678]|sonnet-4-6)(-|$)/.test(model)
}

/** Models that think even when the request leaves `thinking` out. */
function thinksByDefault(model: string): boolean {
  return /^claude-(fable|mythos|opus|sonnet|haiku)-5(-|$)/.test(model)
}

/** Models that refuse a forced tool choice (`any` or `tool`) with a 400. */
export function noForcedTools(model: string): boolean {
  return /^claude-(opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1)(-|$)/.test(model)
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Whether a tool call's streamed arguments are whole JSON; a reply cut off at the output limit leaves them mid-way. */
function wholeJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function parseArgs(text: string): unknown {
  try {
    const v: unknown = JSON.parse(text || '{}')
    return isObj(v) ? v : {}
  } catch {
    return {}
  }
}

/** Messages in Anthropic's shape: tool results ride in user messages, consecutive ones merged. */
function messageList(req: LlmRequest): { system: string; messages: Obj[] } {
  const system: string[] = []
  const messages: Obj[] = []
  const last = (): Obj | undefined => messages[messages.length - 1]
  for (const m of req.messages) {
    switch (m.role) {
      case 'system':
        system.push(m.content)
        break
      case 'user': {
        // the person's files go ahead of their words, PDFs as documents and pictures as images
        const files: Obj[] = [
          ...(m.documents ?? []).map((d) => ({ type: 'document', source: { type: 'base64', media_type: d.mime, data: d.data }, title: d.name })),
          ...(m.images ?? []).map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })),
        ]
        messages.push({ role: 'user', content: files.length ? [...files, { type: 'text', text: m.content }] : m.content })
        break
      }
      case 'assistant': {
        if (m.raw && m.raw.length > 0) {
          messages.push({ role: 'assistant', content: m.raw })
          break
        }
        const blocks: Obj[] = []
        if (m.content) blocks.push({ type: 'text', text: m.content })
        for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: encodeToolName(c.name), input: parseArgs(c.arguments) })
        if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks })
        break
      }
      case 'tools': {
        // tool changes go only with a tool search request; elsewhere the chat's tools are sent as they are
        if (!req.toolSearch || m.add.length + m.remove.length === 0) break
        const ref = (name: string) => ({ type: 'tool_reference', name: encodeToolName(name) })
        messages.push({ role: 'system', content: [...m.add.map((n) => ({ type: 'tool_addition', tool: ref(n) })), ...m.remove.map((n) => ({ type: 'tool_removal', tool: ref(n) }))] })
        break
      }
      case 'tool': {
        const content = m.images?.length
          ? [{ type: 'text', text: m.content }, ...m.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } }))]
          : m.content
        const block = { type: 'tool_result', tool_use_id: m.callId, content }
        const prev = last()
        if (prev && prev['role'] === 'user' && Array.isArray(prev['content']) && (prev['content'] as Obj[]).every((b) => b['type'] === 'tool_result')) (prev['content'] as Obj[]).push(block)
        else messages.push({ role: 'user', content: [block] })
        break
      }
    }
  }
  return { system: system.join('\n\n'), messages }
}

/**
 * The pages a reply's web searches returned, each once by url, in the order returned: the web_search_tool_result
 * blocks of its `done` raw content. A search that failed returns an error in place of its list, and gives none.
 */
export function searchedPages(raw: readonly unknown[] | undefined): { url: string; title: string }[] {
  const pages: { url: string; title: string }[] = []
  for (const b of raw ?? []) {
    if (!isObj(b) || b['type'] !== 'web_search_tool_result' || !Array.isArray(b['content'])) continue
    for (const r of b['content']) {
      const url = isObj(r) && r['type'] === 'web_search_result' ? str(r['url']) : ''
      if (url && !pages.some((p) => p.url === url)) pages.push({ url, title: str((r as Obj)['title']) })
    }
  }
  return pages
}

/**
 * A reply's content as the chat keeps it: a server tool call the provider never ran (a tool search streamed after a
 * client tool call, when the reply stopped for the client's call) has no result block in the reply, and the provider
 * refuses every later request that carries it unanswered, so it is left out. Every other block stays as it came,
 * thinking included.
 */
export function withoutUnansweredServerCalls(raw: readonly unknown[]): unknown[] {
  const answered = new Set(raw.filter((b) => isObj(b) && /_tool_result$/.test(str(b['type']))).map((b) => str((b as Obj)['tool_use_id'])))
  return raw.filter((b) => !(isObj(b) && b['type'] === 'server_tool_use' && !answered.has(str(b['id']))))
}

// No maxTools: the Messages API documents no limit on the number of tools in a request.
export function createAnthropicAdapter(): LlmAdapter {
  return {
    id: 'anthropic',
    build(req: LlmRequest, opts?: { baseUrl?: string }): LlmHttpRequest {
      const { system, messages } = messageList(req)
      const search = req.toolSearch === true
      const tools: Obj[] = req.tools.map((t) => ({ name: encodeToolName(t.name), description: t.description, input_schema: t.parameters, ...(search && t.deferred ? { defer_loading: true } : {}) }))
      // the tools and the system prompt are the same every turn, so they are read from the cache after the first; the
      // point goes on the last tool that loads, as a deferred one takes none
      const lastTool = tools.findLast((t) => t['defer_loading'] !== true)
      if (lastTool) lastTool['cache_control'] = { ...EPHEMERAL }
      if (search) tools.push({ ...TOOL_SEARCH_TOOL })
      if (req.webSearch) tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 3 })
      const adaptive = adaptiveThinking(req.model)
      // current models think adaptively and take an effort; older ones a token budget
      const budget = req.reasoning && !adaptive ? BUDGET[req.reasoning] : 0
      const body: Obj = {
        model: req.model,
        max_tokens: req.maxOutputTokens ?? (budget > 0 ? budget + 8192 : req.reasoning ? ADAPTIVE_OUTPUT : 8192),
        messages,
        stream: true,
      }
      if (system) body['system'] = [{ type: 'text', text: system, cache_control: { ...EPHEMERAL } }]
      // and the conversation so far is read from the cache on the next step of a tool loop (the provider moves this point to the last block)
      body['cache_control'] = { ...EPHEMERAL }
      if (budget > 0) body['thinking'] = { type: 'enabled', budget_tokens: Math.min(budget, num(body['max_tokens']) - 1024) }
      if (adaptive && req.reasoning) {
        body['thinking'] = { type: 'adaptive' }
        body['output_config'] = { effort: req.reasoning }
      }
      // no thinking asked for: said outright, since current models think when the field is left out
      const off = req.thinking === false
      if (off) {
        body['thinking'] = { type: 'disabled' }
        delete body['output_config']
      }
      if (tools.length > 0) {
        body['tools'] = tools
        // forced tool use is not allowed together with thinking, and some models refuse it outright
        const choice = req.toolChoice ?? 'auto'
        const thinking = !off && (budget > 0 || (adaptive && Boolean(req.reasoning)) || thinksByDefault(req.model))
        const forced = choice === 'required' && !thinking && !noForcedTools(req.model)
        body['tool_choice'] = choice === 'none' ? { type: 'none' } : forced ? { type: 'any' } : { type: 'auto' }
      }
      const base = (opts?.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')
      return {
        provider: 'anthropic',
        url: `${base}/v1/messages`,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(messages.some((m) => m['role'] === 'system') ? { 'anthropic-beta': TOOL_CHANGES_BETA } : {}) },
        body: JSON.stringify(body),
      }
    },
    async *parse(body: AsyncIterable<Uint8Array>): AsyncIterable<LlmEvent> {
      const blocks = new Map<number, Obj>()
      const partial = new Map<number, string>()
      // tool_use blocks that have not stopped yet: one the output limit cut off may never get its stop
      const open = new Set<number>()
      let sawCall = false
      let stop: LlmStop = 'end'
      let inputTokens = 0
      let outputTokens = 0
      let cacheReadTokens = 0
      let cacheWriteTokens = 0
      // reported as usage.server_tool_use.web_search_requests; undefined until the reply names it
      let webSearches: number | undefined
      const searchesIn = (u: Obj): void => {
        const s = isObj(u['server_tool_use']) ? u['server_tool_use']['web_search_requests'] : undefined
        if (typeof s === 'number' && Number.isFinite(s)) webSearches = Math.max(webSearches ?? 0, s)
      }
      for await (const msg of parseSse(body)) {
        let ev: unknown
        try {
          ev = JSON.parse(msg.data)
        } catch {
          yield { type: 'error', message: 'Provider sent a malformed stream event', retryable: true }
          continue
        }
        if (!isObj(ev)) continue
        const type = str(ev['type']) || (msg.event ?? '')
        const index = num(ev['index'])
        switch (type) {
          case 'message_start': {
            const m = isObj(ev['message']) ? ev['message'] : {}
            const u = isObj(m['usage']) ? m['usage'] : {}
            cacheReadTokens = num(u['cache_read_input_tokens'])
            cacheWriteTokens = num(u['cache_creation_input_tokens'])
            searchesIn(u)
            inputTokens = num(u['input_tokens']) + cacheWriteTokens + cacheReadTokens
            outputTokens = num(u['output_tokens'])
            break
          }
          case 'content_block_start': {
            const b = isObj(ev['content_block']) ? { ...ev['content_block'] } : {}
            if (b['type'] === 'text') b['text'] = str(b['text'])
            if (b['type'] === 'thinking') {
              b['thinking'] = str(b['thinking'])
              b['signature'] = str(b['signature'])
            }
            blocks.set(index, b)
            partial.set(index, '')
            if (b['type'] === 'tool_use') open.add(index)
            break
          }
          case 'content_block_delta': {
            const d = isObj(ev['delta']) ? ev['delta'] : {}
            const b = blocks.get(index)
            switch (str(d['type'])) {
              case 'text_delta':
                if (b) b['text'] = str(b['text']) + str(d['text'])
                yield { type: 'text', delta: str(d['text']) }
                break
              case 'thinking_delta':
                if (b) b['thinking'] = str(b['thinking']) + str(d['thinking'])
                yield { type: 'reasoning', delta: str(d['thinking']) }
                break
              case 'signature_delta':
                if (b) b['signature'] = str(b['signature']) + str(d['signature'])
                break
              case 'input_json_delta':
                partial.set(index, (partial.get(index) ?? '') + str(d['partial_json']))
                break
              case 'citations_delta': {
                const c = isObj(d['citation']) ? d['citation'] : {}
                if (str(c['type']) === 'web_search_result_location') yield { type: 'citation', url: str(c['url']), title: str(c['title']) }
                if (b) b['citations'] = [...(Array.isArray(b['citations']) ? b['citations'] : []), c]
                break
              }
              default:
                break
            }
            break
          }
          case 'content_block_stop': {
            const b = blocks.get(index)
            if (!b) break
            const json = partial.get(index) ?? ''
            if (b['type'] === 'tool_use' || b['type'] === 'server_tool_use') {
              const input = json ? parseArgs(json) : isObj(b['input']) ? b['input'] : {}
              b['input'] = input
              if (b['type'] === 'tool_use') {
                open.delete(index)
                sawCall = true
                yield { type: 'tool_call', call: { id: str(b['id']), name: decodeToolName(str(b['name'])), arguments: JSON.stringify(input), ...(json && !wholeJson(json) ? { incomplete: true as const } : {}) } }
              }
            }
            break
          }
          case 'message_delta': {
            const d = isObj(ev['delta']) ? ev['delta'] : {}
            const u = isObj(ev['usage']) ? ev['usage'] : {}
            outputTokens = num(u['output_tokens']) || outputTokens
            searchesIn(u)
            const reason = str(d['stop_reason'])
            if (reason === 'max_tokens') stop = 'length'
            else if (reason === 'tool_use') stop = 'tool_calls'
            break
          }
          case 'message_stop':
            break
          // mimir cloud's own event, ahead of the provider's: its proxy takes tool search requests
          case 'mimir':
            if (ev['tool_search'] === true) yield { type: 'tool_search' }
            break
          case 'error': {
            const e = isObj(ev['error']) ? ev['error'] : {}
            const kind = str(e['type'])
            yield { type: 'error', message: str(e['message']) || 'Provider error', retryable: kind === 'overloaded_error' || kind === 'rate_limit_error' || kind === 'api_error' }
            stop = 'error'
            break
          }
          default:
            break
        }
      }
      // a tool_use the stream never stopped is still in raw, so it is a call too: marked incomplete, it is answered, not run
      for (const index of [...open].sort((a, b) => a - b)) {
        const b = blocks.get(index)
        if (!b) continue
        b['input'] = {}
        sawCall = true
        yield { type: 'tool_call', call: { id: str(b['id']), name: decodeToolName(str(b['name'])), arguments: '{}', incomplete: true } }
      }
      if (stop === 'end' && sawCall) stop = 'tool_calls'
      yield { type: 'usage', inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, ...(webSearches === undefined ? {} : { webSearches }) }
      const raw = withoutUnansweredServerCalls([...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b))
      yield { type: 'done', stop, raw }
    },
  }
}
