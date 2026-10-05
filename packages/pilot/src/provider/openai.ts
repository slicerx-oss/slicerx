// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// OpenAI Responses API adapter. Stateless (`store: false`): reasoning state
// travels back to the API as encrypted items kept on the assistant message.
import type { LlmHttpRequest } from '@slicerx/contracts'
import { parseSse } from './sse'
import type { LlmAdapter, LlmEvent, LlmRequest, LlmStop } from './types'

const DEFAULT_BASE = 'https://api.openai.com/v1'

/** OpenAI function names allow only [A-Za-z0-9_-]; mimir tool names use dots. */
export const encodeToolName = (name: string): string => name.replaceAll('.', '__')
export const decodeToolName = (name: string): string => name.replaceAll('__', '.')

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function inputItems(req: LlmRequest): unknown[] {
  const items: unknown[] = []
  for (const m of req.messages) {
    switch (m.role) {
      case 'system':
        items.push({ role: 'developer', content: m.content })
        break
      case 'user':
        items.push({ role: 'user', content: m.content })
        break
      case 'assistant':
        if (m.raw && m.raw.length > 0) {
          items.push(...m.raw)
        } else {
          if (m.content) items.push({ role: 'assistant', content: m.content })
          for (const c of m.toolCalls ?? []) {
            items.push({ type: 'function_call', call_id: c.id, name: encodeToolName(c.name), arguments: c.arguments })
          }
        }
        break
      case 'tool':
        // The Responses API takes input_text and input_image parts as a function call's output.
        items.push({
          type: 'function_call_output',
          call_id: m.callId,
          output: m.images?.length
            ? [{ type: 'input_text', text: m.content }, ...m.images.map((i) => ({ type: 'input_image', image_url: `data:${i.mime};base64,${i.data}`, detail: 'high' }))]
            : m.content,
        })
        break
    }
  }
  return items
}

/**
 * Output items worth sending back. Without server-side storage, message and
 * function call ids cannot be referenced, so they are dropped; reasoning items
 * keep theirs because the encrypted content is bound to them.
 */
function replayable(item: Obj): Obj | null {
  const type = str(item['type'])
  if (type === 'reasoning') return item
  if (type === 'message' || type === 'function_call') {
    const { id: _id, status: _status, ...rest } = item
    return rest
  }
  return null
}

export function createOpenAiAdapter(): LlmAdapter {
  return {
    id: 'openai',
    build(req: LlmRequest, opts?: { baseUrl?: string }): LlmHttpRequest {
      const tools: unknown[] = req.tools.map((t) => ({
        type: 'function',
        name: encodeToolName(t.name),
        description: t.description,
        parameters: t.parameters,
        strict: false,
      }))
      if (req.webSearch) tools.push({ type: 'web_search' })
      const body: Obj = {
        model: req.model,
        input: inputItems(req),
        stream: true,
        store: false,
      }
      if (tools.length > 0) {
        body['tools'] = tools
        body['tool_choice'] = req.toolChoice ?? 'auto'
        body['parallel_tool_calls'] = true
      }
      if (req.reasoning) {
        body['reasoning'] = { effort: req.reasoning, summary: 'auto' }
        body['include'] = ['reasoning.encrypted_content']
      }
      if (req.maxOutputTokens) body['max_output_tokens'] = req.maxOutputTokens
      const base = (opts?.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')
      return {
        provider: 'openai',
        url: `${base}/responses`,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
      }
    },
    async *parse(body: AsyncIterable<Uint8Array>): AsyncIterable<LlmEvent> {
      const raw: unknown[] = []
      let sawCall = false
      let stop: LlmStop = 'end'
      let reasoningOpen = false
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
        const type = str(ev['type']) || (msg.event ?? '')
        switch (type) {
          case 'response.output_text.delta':
            yield { type: 'text', delta: str(ev['delta']) }
            break
          case 'response.reasoning_summary_text.delta':
            reasoningOpen = true
            yield { type: 'reasoning', delta: str(ev['delta']) }
            break
          case 'response.reasoning_summary_part.done':
            // Separate summary parts read better as paragraphs.
            if (reasoningOpen) yield { type: 'reasoning', delta: '\n\n' }
            break
          case 'response.output_item.done': {
            const item = ev['item']
            if (!isObj(item)) break
            const itype = str(item['type'])
            if (itype === 'function_call') {
              sawCall = true
              yield {
                type: 'tool_call',
                call: { id: str(item['call_id']), name: decodeToolName(str(item['name'])), arguments: str(item['arguments']) || '{}' },
              }
            } else if (itype === 'message') {
              const content = Array.isArray(item['content']) ? item['content'] : []
              for (const part of content) {
                if (!isObj(part) || !Array.isArray(part['annotations'])) continue
                for (const a of part['annotations']) {
                  if (isObj(a) && str(a['type']) === 'url_citation') {
                    yield { type: 'citation', url: str(a['url']), title: str(a['title']) }
                  }
                }
              }
            }
            const keep = replayable(item)
            if (keep) raw.push(keep)
            break
          }
          case 'response.completed':
          case 'response.incomplete': {
            const resp = isObj(ev['response']) ? ev['response'] : {}
            const usage = isObj(resp['usage']) ? resp['usage'] : {}
            yield { type: 'usage', inputTokens: num(usage['input_tokens']), outputTokens: num(usage['output_tokens']) }
            if (type === 'response.incomplete') stop = 'length'
            break
          }
          case 'response.failed': {
            const resp = isObj(ev['response']) ? ev['response'] : {}
            const err = isObj(resp['error']) ? resp['error'] : {}
            yield { type: 'error', message: str(err['message']) || 'The provider reported a failed response', retryable: false }
            stop = 'error'
            break
          }
          case 'error':
            yield { type: 'error', message: str(ev['message']) || 'Provider error', retryable: str(ev['code']) === 'rate_limit_exceeded' }
            stop = 'error'
            break
          default:
            break
        }
      }
      if (stop === 'end' && sawCall) stop = 'tool_calls'
      yield { type: 'done', stop, raw }
    },
  }
}
