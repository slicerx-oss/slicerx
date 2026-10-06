// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where mimir's API key lives. Desktop: the keychain item the model transport reads (service
// slicerx-<provider>-api-key, account slicerx), through the host's key commands. Browser: AES-GCM
// encrypted in localStorage, with a key Web Crypto generated as non-extractable and kept in
// IndexedDB, so the key's bytes never exist in script-readable storage. Either way the key is read
// only by the transport that calls the chosen provider; it is never logged, exported or shown to
// mimir.
import type { Host } from '@slicerx/contracts'
import { chatGptFor, type ChatGptHost } from './chatgpt'

export type PilotProvider = 'openai' | 'anthropic' | 'local'

export interface ProviderInfo {
  id: PilotProvider
  label: string
  needsKey: boolean
  keyHint: string
  /** Where the key or server comes from, for the help line. */
  where: string
  defaultBase: string
  defaultModel: string
}

export const PROVIDERS: Readonly<Record<PilotProvider, ProviderInfo>> = {
  openai: { id: 'openai', label: 'OpenAI', needsKey: true, keyHint: 'sk-...', where: 'Create a key at platform.openai.com, under API keys.', defaultBase: 'https://api.openai.com/v1', defaultModel: 'gpt-6-sol' },
  anthropic: { id: 'anthropic', label: 'Anthropic', needsKey: true, keyHint: 'sk-ant-...', where: 'Create a key in the Anthropic Console, under API keys.', defaultBase: 'https://api.anthropic.com/v1', defaultModel: 'claude-opus-5-5' },
  local: { id: 'local', label: 'Local model', needsKey: false, keyHint: '', where: 'llama.cpp, LocalAI, vLLM, or Ollama on another computer, such as http://192.168.1.50:8080/v1.', defaultBase: 'http://localhost:11434/v1', defaultModel: 'llama3.1' },
}

export interface KeyStore {
  /** True when a key is stored for the provider. */
  has(provider: PilotProvider): Promise<boolean>
  set(provider: PilotProvider, key: string): Promise<void>
  /** For the transport only. */
  get(provider: PilotProvider): Promise<string | null>
  delete(provider: PilotProvider): Promise<void>
}

/** The host's key commands (desktop): they write the keychain item the model transport reads. */
export type ApiKeyHost = Pick<ChatGptHost, 'hasApiKey' | 'setApiKey' | 'clearApiKey'>

/** The `local` slot holds the optional key of a model server on the network, in its own keychain item. */
/** Desktop: the system keychain, through the host. The host reads it when it calls the provider. */
export function keychainStore(keys: ApiKeyHost): KeyStore {
  return {
    has: (p) => keys.hasApiKey(p),
    set: (p, key) => keys.setApiKey(p, key),
    // Write only from the webview: the host's own transport reads the keychain.
    get: async () => null,
    delete: (p) => keys.clearApiKey(p),
  }
}

const LS = (p: PilotProvider) => `slicerx.pilot.key.${p}`
const DB = 'slicerx-keys'
const STORE = 'keys'
const KEY_ID = 'pilot'

function idb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
}

/** Keys held for this page only when IndexedDB is unavailable (private windows, tests). */
let memoryKey: CryptoKey | null = null

async function wrappingKey(): Promise<CryptoKey> {
  const db = await idb()
  if (db) {
    const found = await new Promise<CryptoKey | undefined>((resolve) => {
      const r = db.transaction(STORE).objectStore(STORE).get(KEY_ID)
      r.onsuccess = () => resolve(r.result as CryptoKey | undefined)
      r.onerror = () => resolve(undefined)
    })
    if (found) return found
  } else if (memoryKey) return memoryKey
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  if (db) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(key, KEY_ID)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Could not keep the key'))
    })
  } else memoryKey = key
  return key
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** Browser storage: AES-GCM with a non-extractable key. */
export function browserStore(storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): KeyStore {
  return {
    async has(p) {
      return Boolean(storage?.getItem(LS(p)))
    },
    async set(p, key) {
      if (!storage) throw new Error('This browser does not allow storage for this page.')
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await wrappingKey(), new TextEncoder().encode(key))
      storage.setItem(LS(p), JSON.stringify({ v: 1, iv: b64(iv), data: b64(new Uint8Array(data)) }))
    },
    async get(p) {
      const raw = storage?.getItem(LS(p))
      if (!raw) return null
      try {
        const { iv, data } = JSON.parse(raw) as { iv: string; data: string }
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await wrappingKey(), unb64(data))
        return new TextDecoder().decode(plain)
      } catch {
        // A key from another browser profile or a cleared IndexedDB cannot be read; ask again.
        return null
      }
    },
    async delete(p) {
      storage?.removeItem(LS(p))
    },
  }
}

export function keyStoreFor(host: Host): KeyStore {
  const keys = host.capabilities.secureStorage ? chatGptFor(host) : null
  return keys ? keychainStore(keys) : browserStore()
}
