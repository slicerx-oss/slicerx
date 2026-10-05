// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which transport and model config mimir uses. A host with its own transport and keychain
// (desktop, sx-link) keeps it; the browser build uses the encrypted key store and calls the
// provider directly. Adapters: openai (Responses API), anthropic (Messages API) and
// openai-compatible (chat completions, for Ollama and LM Studio).
import type { Host, LlmTransport } from '@slicerx/contracts'
import type { EditionConfig } from '@slicerx/edition-config'
import { get, type PilotPref } from '../state/store'
import { keyStoreFor, PROVIDERS } from './keys'
import { browserTransport } from './transport'

export function pilotTransport(host: Host): LlmTransport | null {
  const pref = get().pilot
  if (pref && pref.mode === 'off') return null
  if (!pref?.provider) return host.llm ?? null
  if (host.capabilities.secureStorage && host.llm) return host.llm
  return browserTransport(keyStoreFor(host), () => {
    const p = get().pilot
    return p?.provider ? { provider: p.provider, ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), ...(p.model ? { model: p.model } : {}) } : null
  })
}

/** The adapter and model mimir runs for the connection, or null when nothing is set up. */
export function pilotModel(edition: EditionConfig, pref: PilotPref | null): { provider: string; model: string; baseUrl?: string } | null {
  if (!pref?.provider) {
    const ai = edition.ai
    return ai.provider === 'none' ? null : { provider: ai.provider, model: ai.model, ...(ai.baseUrl ? { baseUrl: ai.baseUrl } : {}) }
  }
  const info = PROVIDERS[pref.provider]
  const model = pref.model || info.defaultModel
  // The Anthropic adapter adds /v1 itself; the others take the base with /v1.
  if (pref.provider === 'anthropic') return { provider: 'anthropic', model, baseUrl: (pref.baseUrl || info.defaultBase).replace(/\/v1\/?$/, '') }
  if (pref.provider === 'local') return { provider: 'openai-compatible', model, baseUrl: pref.baseUrl || info.defaultBase }
  return { provider: 'openai', model, baseUrl: pref.baseUrl || info.defaultBase }
}
