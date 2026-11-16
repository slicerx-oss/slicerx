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
  /** The reply was cut off at the output limit before these arguments were complete; the call never runs. */
  incomplete?: true
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
      /** What the provider signed the reasoning in `raw` against (reasoning-binding.ts bindingKey). */
      bound?: string
    }
  | { role: 'tool'; callId: string; content: string; images?: LlmImage[] }
  /**
   * The app offering (`add`) or withdrawing (`remove`) tools of the chat's catalog by name, mid-chat, on a request that
   * sends the whole catalog through tool search. It carries no words (`content` is always empty); providers without
   * tool search skip it.
   */
  | { role: 'tools'; content: ''; add: string[]; remove: string[] }

export interface LlmToolDef {
  name: string
  description: string
  parameters: JsonSchema
  /** Left out of the model's context until a tool search finds it (`toolSearch` requests only). */
  deferred?: boolean
}

export interface LlmRequest {
  model: string
  messages: LlmMessage[]
  tools: LlmToolDef[]
  toolChoice?: 'auto' | 'none' | 'required'
  maxOutputTokens?: number
  reasoning?: 'low' | 'medium' | 'high'
  /**
   * false asks for no thinking at all, on models that think when the request leaves it out too: a short answer whose
   * output limit must go to the answer (a sizes search). Left out, the model's own default holds.
   */
  thinking?: false
  /** Enable the provider's hosted web search tool for this request. */
  webSearch?: boolean
  /**
   * The request sends the chat's whole tool catalog with the provider's tool search tool, most of it deferred, and its
   * `tools` messages (LlmMessage) as tool changes. Only a client with `toolSearch` takes it.
   */
  toolSearch?: boolean
  /** The pilot session this turn belongs to; mimir cloud files a shared session under it. */
  session?: string
  /** The tier the runtime picked for this turn. mimir cloud asks its proxy for the stronger model on muninn. */
  tier?: Tier
  /**
   * The index in `messages` of the message the earlier turns end with, the turn's opening request: a provider with a
   * prompt cache caches the prompt through it, so the next turn reads it back (runtime.ts, fold.ts).
   */
  cacheAt?: number
}

export type LlmStop = 'end' | 'tool_calls' | 'length' | 'error'

export type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; call: LlmToolCall }
  | { type: 'citation'; url: string; title: string }
  /** `webSearches`: the hosted web searches the reply ran, when the provider reports them. */
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; webSearches?: number }
  | { type: 'done'; stop: LlmStop; raw?: unknown[] }
  /**
   * `code` is mimir cloud's refusal code (`day_used`, `paused`, ...). `searchRefused`: a mimir cloud proxy deployed before
   * tool search refused this tool search request for its shape; the client no longer takes tool search on it
   * (LlmClient.toolSearch), and the runtime sends the request once more with the per-turn pick.
   */
  | { type: 'error'; message: string; retryable: boolean; code?: string; searchRefused?: true }
  /** The model that answered, when the reply names it (mimir cloud's `x-sx-model`). Comes before the reply's text. */
  | { type: 'model'; model: string }
  /**
   * mimir cloud's proxy takes a request that sends the whole tool catalog through tool search (its `mimir` stream event,
   * supabase/functions/mimir/handler.ts). The transport client takes back an earlier refusal on it (LlmClient.toolSearch)
   * and passes it on no further.
   */
  | { type: 'tool_search' }

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
  /**
   * The provider runs a tool search over deferred tools and takes tool changes mid-chat (LlmRequest.toolSearch). It can
   * change while the client runs: a mimir cloud proxy deployed before tool search turns it false by refusing a tool
   * search request, and true again by saying in a reply that it takes tool search.
   */
  readonly toolSearch?: boolean
  stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmEvent>
}
