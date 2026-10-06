// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Sign in with ChatGPT: the desktop app registers a host that runs the browser sign-in and keeps
// the connection in the keychain (packages/pilot/llm chatgpt.rs). The browser build has none and
// shows the API key option only. The webview never sees a token.
import type { Host } from '@slicerx/contracts'
import { useSyncExternalStore } from 'react'

export interface ChatGptCapabilities {
  text: boolean
  tools: boolean
  images: boolean
  model: string
  checkedAt: number
}

export interface ChatGptAccount {
  email: string | null
  name: string | null
  /** True when the person granted plan usage, not just sign-in. */
  planUsage: boolean
  connectedAt: number
  capabilities: ChatGptCapabilities | null
}

export interface ChatGptHost {
  /** Opens the browser for sign-in and resolves once the person finished or gave up. */
  connect(): Promise<ChatGptAccount>
  account(): Promise<ChatGptAccount | null>
  disconnect(): Promise<void>
  /** The pasted key lives in the keychain item the model transport reads (service slicerx-<provider>-api-key, account slicerx). */
  setApiKey(provider: 'openai' | 'anthropic' | 'local', key: string): Promise<void>
  hasApiKey(provider: 'openai' | 'anthropic' | 'local'): Promise<boolean>
  clearApiKey(provider: 'openai' | 'anthropic' | 'local'): Promise<void>
  /**
   * The model listing of a local server by address, fetched by the host with the optional local
   * key from the keychain (the webview cannot reach the network or read the key).
   */
  localModels?(baseUrl: string): Promise<string>
}

type Factory = (host: Host) => ChatGptHost
let factory: Factory | null = null
const listeners = new Set<() => void>()

/** Called once by an app entry that can sign in (the desktop app). */
export function registerChatGpt(f: Factory | null): void {
  factory = f
  for (const l of listeners) l()
}

export function chatGptFor(host: Host): ChatGptHost | null {
  return factory ? factory(host) : null
}

export function useChatGpt(host: Host): ChatGptHost | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => factory,
    () => null,
  )
    ? chatGptFor(host)
    : null
}
