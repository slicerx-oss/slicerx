// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where this build keeps the phone pairing secrets, named by the app entry at startup. The entry may hand over a
// loader instead of the stores, so the sealing code is fetched when the printer bridge first connects and not before
// the first screen. Small on purpose: the connection code reads it, and the entry calls it at startup.
import type { IdentityStore, PairingStore } from '@slicerx/pair'

export interface PairStorage {
  identity: IdentityStore
  pairings: PairingStore
  /** How this computer shows in a phone's list. */
  name: string
  kind: 'desktop' | 'web'
}

type Loader = () => Promise<PairStorage | null>

let storage: PairStorage | null = null
let loader: Loader | null = null
let loaded: Promise<PairStorage | null> | null = null

/** Called by the app entry, once, with where this build keeps secrets, or a function that makes it on first use. */
export function setPairStorage(s: PairStorage | Loader | null): void {
  loaded = null
  if (typeof s === 'function') {
    storage = null
    loader = s
  } else {
    storage = s
    loader = null
  }
}

/** The storage once the entry's loader has made it (a failed load is tried again next time), or null where there is none. */
export function pairStorageReady(): Promise<PairStorage | null> {
  if (!loader) return Promise.resolve(storage)
  const make = loader
  loaded ??= make().then(
    (s) => {
      storage = s
      return s
    },
    (e: unknown) => {
      loaded = null
      throw e
    },
  )
  return loaded
}

/** What is there now: null until a loader has made it. */
export const pairStorage = (): PairStorage | null => storage
