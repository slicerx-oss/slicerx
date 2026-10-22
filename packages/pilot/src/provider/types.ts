// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Provider-neutral request and event shapes. Adapters translate these to and
// from one vendor's wire format; the agent loop only sees these.
import type { JsonSchema, LlmHttpRequest } from '@slicerx/contracts'
import type { Tier } from '../models'

/** An image the model sees, such as a camera frame a tool returned. Base64 without a data: prefix. */
export interface LlmImage {
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
  data: string
}

/** A document the model reads, such as a PDF drawing the person attached. Base64 without a data: prefix. */
export interface LlmDocument {
  mime: 'application/pdf'
  data: string
  /** The file's name, so the model can refer to it. */
  name: string
}

export interface LlmToolCall {
  id: string
  name: string
  /** Raw JSON text as the model produced it; validated before use. */
  arguments: string
}

export type LlmMessage =
  | { role: 'system'; content: string }
  /** The person's files ride on their message: pictures as images, PDFs as documents. */
  | { role: 'user'; content: string; images?: LlmImage[]; documents?: LlmDocument[] }
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
  /** The pilot session this turn belongs to; mimir cloud files a shared session under it. */
  session?: string
  /** The tier the runtime picked for this turn. mimir cloud asks its proxy for the stronger model on muninn. */
  tier?: Tier
}

export type LlmStop = 'end' | 'tool_calls' | 'length' | 'error'

export type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; call: LlmToolCall }
  | { type: 'citation'; url: string; title: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: 'done'; stop: LlmStop; raw?: unknown[] }
  /** `code` is mimir cloud's refusal code (`day_used`, `paused`, ...). */
  | { type: 'error'; message: string; retryable: boolean; code?: string }
  /** The model that answered, when the reply names it (mimir cloud's `x-sx-model`). Comes before the reply's text. */
  | { type: 'model'; model: string }

/** Builds one HTTP request and parses its SSE body. Never sees a key. */
export interface LlmAdapter {
  id: string
  /** The most tools one request may carry, when the API has a limit; unset has none. The runtime stays at or under it. */
  maxTools?: number
  build(req: LlmRequest, opts?: { baseUrl?: string }): LlmHttpRequest
  parse(body: AsyncIterable<Uint8Array>): AsyncIterable<LlmEvent>
}

/** What the agent loop calls. An adapter plus a transport, or a scripted stand-in. */
export interface LlmClient {
  provider: string
  /** The adapter's tool limit (LlmAdapter.maxTools); unset has none. */
  maxTools?: number
  stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmEvent>
}
