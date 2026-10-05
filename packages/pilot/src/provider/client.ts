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
}

export function adapterFor(provider: string): LlmAdapter {
  const make = ADAPTERS[provider]
  if (!make) throw new Error(`No ${ASSISTANT_NAME} adapter for provider "${provider}"`)
  return make()
}

/** Joins an adapter with the host transport. The transport adds the key; this code never sees it. */
export function createTransportClient(transport: LlmTransport, provider: string, opts: { baseUrl?: string } = {}): LlmClient {
  const adapter = adapterFor(provider)
  return {
    provider,
    async *stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmEvent> {
      const http = adapter.build(req, opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl })
      let body: AsyncIterable<Uint8Array>
      try {
        body = transport.stream(http, signal)
      } catch (e) {
        yield { type: 'error', message: errorText(e), retryable: true }
        yield { type: 'done', stop: 'error' }
        return
      }
      try {
        yield* adapter.parse(body)
      } catch (e) {
        if (signal?.aborted) throw e
        yield { type: 'error', message: errorText(e), retryable: true }
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
