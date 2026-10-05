// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where the pairing host keeps its identity and its pairings. Both hold secrets (the identity's private keys,
// each phone's device key), so they live in one sealed document that a DocStore keeps. The desktop app's DocStore
// seals in Rust with a key in the system keychain; the browser's seals with a non-extractable WebCrypto key.
import type { IdentityStore, PairingRecord, PairingStore, StoredIdentity } from '@slicerx/pair'

/** Keeps one text document, sealed. */
export interface DocStore {
  read(): Promise<string | null>
  write(text: string): Promise<void>
}

interface Doc {
  v: 1
  identity: StoredIdentity | null
  pairings: PairingRecord[]
  revoked: string[]
}

const empty = (): Doc => ({ v: 1, identity: null, pairings: [], revoked: [] })

/** The sealed document exists but does not open (another key, damage): nothing may overwrite it. */
export class SealedDocError extends Error {}

export function sealedPairStores(store: DocStore): { identity: IdentityStore; pairings: PairingStore } {
  // Writes queue up so two quick pairings cannot overwrite each other.
  let chain: Promise<unknown> = Promise.resolve()
  /** The document, empty when there is none yet; `broken` when one exists but does not open. */
  const open = async (): Promise<{ doc: Doc; broken: boolean }> => {
    try {
      const text = await store.read()
      if (text === null) return { doc: empty(), broken: false }
      const doc = JSON.parse(text) as Doc
      return doc?.v === 1 ? { doc, broken: false } : { doc: empty(), broken: true }
    } catch {
      return { doc: empty(), broken: true }
    }
  }
  // Reads of a document that does not open see nothing, so the app keeps running.
  const load = async (): Promise<Doc> => (await open()).doc
  const update = (fn: (d: Doc) => void): Promise<void> => {
    const run = chain.then(async () => {
      const { doc, broken } = await open()
      // Writing now would replace the identity and every pairing in it with a new, nearly empty one.
      if (broken) throw new SealedDocError('The saved phone pairings do not open, so they were left untouched.')
      fn(doc)
      await store.write(JSON.stringify(doc))
    })
    chain = run.catch(() => undefined)
    return run
  }
  const read = async <T>(fn: (d: Doc) => T): Promise<T> => {
    await chain
    return fn(await load())
  }
  return {
    identity: {
      load: () => read((d) => d.identity),
      save: (identity) => update((d) => void (d.identity = structuredClone(identity))),
    },
    pairings: {
      list: () => read((d) => structuredClone(d.pairings)),
      put: (r) => update((d) => void (d.pairings = [...d.pairings.filter((x) => x.pairingId !== r.pairingId), structuredClone(r)])),
      delete: (id) => update((d) => void (d.pairings = d.pairings.filter((x) => x.pairingId !== id))),
      revokedGrants: () => read((d) => d.revoked),
      addRevokedGrant: (id) => update((d) => void (d.revoked = [...new Set([...d.revoked, id])])),
    },
  }
}

const DB = 'slicerx-pair'

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1)
    open.onupgradeneeded = () => open.result.createObjectStore('kv')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode)
      const req = fn(tx.objectStore('kv'))
      tx.oncomplete = () => {
        open.result.close()
        resolve(req.result)
      }
      tx.onerror = () => reject(tx.error)
    }
  })
}

/** Gets the key, or stores `fresh` when there is none, in one read-write transaction. */
function keyOrStore(fresh: CryptoKey): Promise<CryptoKey> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1)
    open.onupgradeneeded = () => open.result.createObjectStore('kv')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', 'readwrite')
      const kv = tx.objectStore('kv')
      let key = fresh
      const got = kv.get('key')
      got.onsuccess = () => {
        if (got.result) key = got.result as CryptoKey
        else kv.put(fresh, 'key')
      }
      tx.oncomplete = () => {
        open.result.close()
        resolve(key)
      }
      tx.onerror = () => reject(tx.error)
    }
  })
}

/**
 * Browser DocStore: AES-GCM with a non-extractable key, both kept in IndexedDB. Non-extractable only
 * stops page script from exporting the key: the browser keeps its material in the same profile files,
 * so a copied browser profile opens the document. It protects against other sites and casual reads,
 * not against someone with the profile on disk. The desktop app keeps its key in the system keychain.
 */
export function browserDocStore(c: Crypto = globalThis.crypto): DocStore {
  const key = async (): Promise<CryptoKey> => {
    const have = await idb<CryptoKey | undefined>('readonly', (s) => s.get('key'))
    if (have) return have
    // Two tabs may both get here: the transaction keeps whichever key was stored first.
    return keyOrStore(await c.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']))
  }
  return {
    async read() {
      const bytes = await idb<Uint8Array | undefined>('readonly', (s) => s.get('sealed'))
      if (!bytes) return null
      return new TextDecoder().decode(await c.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await key(), bytes.slice(12)))
    },
    async write(text) {
      const iv = c.getRandomValues(new Uint8Array(12))
      const sealed = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(text)))
      const all = new Uint8Array(12 + sealed.length)
      all.set(iv)
      all.set(sealed, 12)
      await idb('readwrite', (s) => s.put(all, 'sealed'))
    },
  }
}
