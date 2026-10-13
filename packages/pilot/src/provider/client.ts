// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { LlmTransport } from '@slicerx/contracts'
import { createAnthropicAdapter } from './anthropic'
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

/** The proxy's save headers. Off says so; on files the chat under its session and app version when they are valid. With no share setting at all the proxy follows the edition's default. */
export function cloudHeaders(share: CloudShare | undefined, session: string | undefined): Record<string, string> {
  if (!share) return {}
  if (!share.on) return { 'x-sx-share': '0' }
  return {
    'x-sx-share': '1',
    ...(session && SESSION.test(session) ? { 'x-sx-session': session } : {}),
    ...(VERSION.test(share.version) ? { 'x-sx-version': share.version } : {}),
  }
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
      if (cloud) http = { ...http, provider: MIMIR_CLOUD, headers: { ...http.headers, ...cloudHeaders(opts.share?.(), req.session) } }
      let body: AsyncIterable<Uint8Array>
      try {
        body = transport.stream(http, signal)
      } catch (e) {
        yield failure(e)
        yield { type: 'done', stop: 'error' }
        return
      }
      try {
        yield* adapter.parse(body)
      } catch (e) {
        if (signal?.aborted) throw e
        yield failure(e)
        yield { type: 'done', stop: 'error' }
      }
    },
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
