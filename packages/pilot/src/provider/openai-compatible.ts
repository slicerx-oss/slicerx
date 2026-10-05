// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// OpenAI-compatible /v1/chat/completions adapter with streaming and tools, for
// local servers (Ollama, LM Studio) reached by base URL. No key is involved:
// the host transport sends none. Reasoning effort and hosted web search do not
// exist on this API and are ignored.
import type { LlmHttpRequest } from '@slicerx/contracts'
import { decodeToolName, encodeToolName } from './openai'
import { parseSse } from './sse'
import type { LlmAdapter, LlmEvent, LlmRequest, LlmStop } from './types'

/** Ollama's default; LM Studio uses http://127.0.0.1:1234/v1. */
const DEFAULT_BASE = 'http://127.0.0.1:11434/v1'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function messageList(req: LlmRequest): Obj[] {
  const out: Obj[] = []
  // Chat completions take no images in tool messages, and tool messages must
  // directly follow their assistant turn, so images go in one user message after them.
  let images: { callId: string; parts: Obj[] }[] = []
  const flush = (): void => {
    if (images.length === 0) return
    out.push({ role: 'user', content: images.flatMap((x) => [{ type: 'text', text: `Image returned by tool call ${x.callId}:` }, ...x.parts]) })
    images = []
  }
  for (const m of req.messages) {
    if (m.role !== 'tool') flush()
    switch (m.role) {
      case 'system':
      case 'user':
        out.push({ role: m.role, content: m.content })
        break
      case 'assistant': {
        const calls = (m.toolCalls ?? []).map((c) => ({ id: c.id, type: 'function', function: { name: encodeToolName(c.name), arguments: c.arguments } }))
        out.push({ role: 'assistant', content: m.content || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) })
        break
      }
      case 'tool':
        out.push({ role: 'tool', tool_call_id: m.callId, content: m.content })
        if (m.images?.length) images.push({ callId: m.callId, parts: m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } })) })
        break
    }
  }
  flush()
  return out
}

export function createOpenAiCompatibleAdapter(): LlmAdapter {
  return {
    id: 'openai-compatible',
    build(req: LlmRequest, opts?: { baseUrl?: string }): LlmHttpRequest {
      const body: Obj = { model: req.model, messages: messageList(req), stream: true, stream_options: { include_usage: true } }
      if (req.tools.length > 0) {
        body['tools'] = req.tools.map((t) => ({ type: 'function', function: { name: encodeToolName(t.name), description: t.description, parameters: t.parameters } }))
        body['tool_choice'] = req.toolChoice ?? 'auto'
      }
      if (req.maxOutputTokens) body['max_tokens'] = req.maxOutputTokens
      const base = (opts?.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')
      return {
        provider: 'openai-compatible',
        url: `${base}/chat/completions`,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
      }
    },
    async *parse(body: AsyncIterable<Uint8Array>): AsyncIterable<LlmEvent> {
      const calls = new Map<number, { id: string; name: string; args: string }>()
      let finish = ''
      let usage: { i: number; o: number } | null = null
      let failed = false
      for await (const msg of parseSse(body)) {
        if (msg.data === '[DONE]') break
        let ev: unknown
        try {
          ev = JSON.parse(msg.data)
        } catch {
          yield { type: 'error', message: 'Provider sent a malformed stream event', retryable: true }
          continue
        }
        if (!isObj(ev)) continue
        if (isObj(ev['error'])) {
          yield { type: 'error', message: str(ev['error']['message']) || 'Provider error', retryable: false }
          failed = true
          continue
        }
        if (isObj(ev['usage'])) usage = { i: num(ev['usage']['prompt_tokens']), o: num(ev['usage']['completion_tokens']) }
        const choice = Array.isArray(ev['choices']) && isObj(ev['choices'][0]) ? ev['choices'][0] : null
        if (!choice) continue
        if (str(choice['finish_reason'])) finish = str(choice['finish_reason'])
        const d = isObj(choice['delta']) ? choice['delta'] : {}
        const reasoning = str(d['reasoning_content']) || str(d['reasoning'])
        if (reasoning) yield { type: 'reasoning', delta: reasoning }
        if (str(d['content'])) yield { type: 'text', delta: str(d['content']) }
        for (const tc of Array.isArray(d['tool_calls']) ? d['tool_calls'] : []) {
          if (!isObj(tc)) continue
          const index = num(tc['index'])
          const cur = calls.get(index) ?? { id: '', name: '', args: '' }
          const fn = isObj(tc['function']) ? tc['function'] : {}
          if (str(tc['id'])) cur.id = str(tc['id'])
          if (str(fn['name'])) cur.name = str(fn['name'])
          // Some servers send the arguments as an object in one piece.
          const a = fn['arguments']
          if (typeof a === 'string') cur.args += a
          else if (isObj(a)) cur.args = JSON.stringify(a)
          calls.set(index, cur)
        }
      }
      let stop: LlmStop = finish === 'length' ? 'length' : 'end'
      for (const [index, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        if (!c.name) continue
        yield { type: 'tool_call', call: { id: c.id || `call_${index}`, name: decodeToolName(c.name), arguments: c.args || '{}' } }
        if (stop === 'end') stop = 'tool_calls'
      }
      if (failed) stop = 'error'
      if (usage) yield { type: 'usage', inputTokens: usage.i, outputTokens: usage.o }
      yield { type: 'done', stop }
    },
  }
}
