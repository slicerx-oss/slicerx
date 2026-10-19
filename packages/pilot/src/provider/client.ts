// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { LlmTransport } from '@slicerx/contracts'
import { createAnthropicAdapter } from './anthropic'
import { HUGINN, MUNINN, type Tier } from '../models'
import { ASSISTANT_NAME } from '../name'
import { createOpenAiAdapter } from './openai'
import { createOpenAiCompatibleAdapter } from './openai-compatible'
import type { LlmAdapter, LlmClient, LlmEvent, LlmRequest } from './types'

const ADAPTERS: Record<string, () => LlmAdapter> = {
  openai: createOpenAiAdapter,
  anthropic: createAnthropicAdapter,
  'openai-compatible': createOpenAiCompatibleAdapter,
  // the edition's proxy speaks the Messages API; the host adds the install token
  'mimir-cloud': createAnthropicAdapter,
}

/** The mimir cloud provider id. Its requests keep this id so the host sends them to the proxy only. */
export const MIMIR_CLOUD = 'mimir-cloud'

/** Whether mimir cloud may save the chat, read when each request is built. Partner apps pass their own switch here. */
export interface CloudShare {
  /** false sends x-sx-share: 0, which mimir cloud never saves. */
  on: boolean
  /** The app version, filed with a shared session. */
  version: string
}

const SESSION = /^[A-Za-z0-9_-]{1,64}$/
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/

/** The tier header value that asks mimir cloud for its stronger model. Anything else gets the base model. */
export const CLOUD_STEP = 'step'
/** The tier header value for the base model. */
export const CLOUD_BASE = 'base'

/**
 * The proxy's headers. `x-sx-tier` asks for the stronger model on a muninn turn; the proxy decides within the edition's
 * limits and names the model it used in `x-sx-model`. The save headers: off says so; on files the chat under its session
 * and app version when they are valid. With no share setting at all the proxy follows the edition's default.
 */
export function cloudHeaders(share: CloudShare | undefined, session: string | undefined, tier: Tier = HUGINN): Record<string, string> {
  const step = { 'x-sx-tier': tier === MUNINN ? CLOUD_STEP : CLOUD_BASE }
  if (!share) return step
  if (!share.on) return { ...step, 'x-sx-share': '0' }
  return {
    ...step,
    'x-sx-share': '1',
    ...(session && SESSION.test(session) ? { 'x-sx-session': session } : {}),
    ...(VERSION.test(share.version) ? { 'x-sx-version': share.version } : {}),
  }
}

/** A model id as mimir cloud names it in `x-sx-model`; anything else is ignored. */
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/

/** The model a mimir cloud reply names, when it is a plain model id. */
export function cloudModel(headers: Record<string, string> | undefined): string | undefined {
  const m = headers?.['x-sx-model']?.trim()
  return m && MODEL_ID.test(m) ? m : undefined
}

export function adapterFor(provider: string): LlmAdapter {
  const make = ADAPTERS[provider]
  if (!make) throw new Error(`No ${ASSISTANT_NAME} adapter for provider "${provider}"`)
  return make()
}

/** Joins an adapter with the host transport. The transport adds the key; this code never sees it. */
export function createTransportClient(transport: LlmTransport, provider: string, opts: { baseUrl?: string; share?: () => CloudShare } = {}): LlmClient {
  const adapter = adapterFor(provider)
  const cloud = provider === MIMIR_CLOUD
  // mimir cloud's refusals (daily caps, a pause) are shown as the proxy wrote them, never retried elsewhere
  const failure = (e: unknown): LlmEvent => {
    if (!cloud) return { type: 'error', message: errorText(e), retryable: true }
    const code = errorCode(e)
    return { type: 'error', message: errorText(e).replace(/^\d{3}: /, ''), retryable: false, ...(code ? { code } : {}) }
  }
  return {
    provider,
    async *stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmEvent> {
      let http = adapter.build(req, opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl })
      if (cloud) http = { ...http, provider: MIMIR_CLOUD, headers: { ...http.headers, ...cloudHeaders(opts.share?.(), req.session, req.tier) } }
      let headers: Record<string, string> | undefined
      let body: AsyncIterable<Uint8Array>
      try {
        body = cloud ? transport.stream(http, signal, (h) => (headers = h)) : transport.stream(http, signal)
      } catch (e) {
        yield failure(e)
        yield { type: 'done', stop: 'error' }
        return
      }
      try {
        if (!cloud) {
          yield* adapter.parse(body)
          return
        }
        // the transport reads the headers before the first chunk, so the model that answered is known before any text
        const it = body[Symbol.asyncIterator]()
        const first = await it.next()
        const model = cloudModel(headers)
        if (model) yield { type: 'model', model }
        yield* adapter.parse(replay(first, it))
      } catch (e) {
        if (signal?.aborted) throw e
        yield failure(e)
        yield { type: 'done', stop: 'error' }
      }
    },
  }
}

/** The body again from its first chunk, already read, and the rest. */
async function* replay(first: IteratorResult<Uint8Array>, rest: AsyncIterator<Uint8Array>): AsyncIterable<Uint8Array> {
  if (first.done) return
  try {
    yield first.value
    for (let r = await rest.next(); !r.done; r = await rest.next()) yield r.value
  } finally {
    // a reader that leaves early still stops the transport
    await rest.return?.()
  }
}

/** Error text safe to show: no headers, no bodies beyond a short provider message. */
export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-...').slice(0, 300)
}

/** mimir cloud's refusal code on a transport error, when it is a plain word. */
export function errorCode(e: unknown): string | undefined {
  const code = e && typeof e === 'object' && 'code' in e ? (e as { code: unknown }).code : undefined
  return typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : undefined
}
