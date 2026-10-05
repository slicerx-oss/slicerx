// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Provider-neutral request and event shapes. Adapters translate these to and
// from one vendor's wire format; the agent loop only sees these.
import type { JsonSchema, LlmHttpRequest } from '@slicerx/contracts'

/** An image the model sees, such as a camera frame a tool returned. Base64 without a data: prefix. */
export interface LlmImage {
  mime: 'image/jpeg' | 'image/png' | 'image/webp'
  data: string
}

export interface LlmToolCall {
  id: string
  name: string
  /** Raw JSON text as the model produced it; validated before use. */
  arguments: string
}

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string
      toolCalls?: LlmToolCall[]
      /** Provider items to send back verbatim on the next turn (reasoning state). */
      raw?: unknown[]
    }
  | { role: 'tool'; callId: string; content: string; images?: LlmImage[] }

export interface LlmToolDef {
  name: string
  description: string
  parameters: JsonSchema
}

export interface LlmRequest {
  model: string
  messages: LlmMessage[]
  tools: LlmToolDef[]
  toolChoice?: 'auto' | 'none' | 'required'
  maxOutputTokens?: number
  reasoning?: 'low' | 'medium' | 'high'
  /** Enable the provider's hosted web search tool for this request. */
  webSearch?: boolean
}

export type LlmStop = 'end' | 'tool_calls' | 'length' | 'error'

export type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; call: LlmToolCall }
  | { type: 'citation'; url: string; title: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; stop: LlmStop; raw?: unknown[] }
  | { type: 'error'; message: string; retryable: boolean }

/** Builds one HTTP request and parses its SSE body. Never sees a key. */
export interface LlmAdapter {
  id: string
  build(req: LlmRequest, opts?: { baseUrl?: string }): LlmHttpRequest
  parse(body: AsyncIterable<Uint8Array>): AsyncIterable<LlmEvent>
}

/** What the agent loop calls. An adapter plus a transport, or a scripted stand-in. */
export interface LlmClient {
  provider: string
  stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmEvent>
}
