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

/** Whether mimir cloud may keep the session, read when each request is built. */
export interface CloudShare {
  on: boolean
  /** The app version, filed with a shared session. */
  version: string
}

const SESSION = /^[A-Za-z0-9_-]{1,64}$/
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/

/** The proxy's share headers: only with sharing on and a session and version it accepts. */
export function cloudHeaders(share: CloudShare | undefined, session: string | undefined): Record<string, string> {
  if (!share?.on || !session || !SESSION.test(session) || !VERSION.test(share.version)) return {}
  return { 'x-sx-share': '1', 'x-sx-session': session, 'x-sx-version': share.version }
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
  const failure = (e: unknown): LlmEvent => (cloud ? { type: 'error', message: errorText(e).replace(/^\d{3}: /, ''), retryable: false } : { type: 'error', message: errorText(e), retryable: true })
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
