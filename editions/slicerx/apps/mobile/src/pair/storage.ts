// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The phone's pairing identity and paired computers, in the iOS Keychain and Android Keystore.
// Both hold secret keys, so they never go to AsyncStorage.
import { PairingRecord, StoredIdentity, type IdentityStore, type PairingStore } from '@slicerx/pair'
import { secureAuthStorage } from '../host/secure-storage'

const IDENTITY = 'slicerx.pair.identity'
const RECORDS = 'slicerx.pair.records'
const REVOKED = 'slicerx.pair.revoked'

async function readJson(key: string): Promise<unknown> {
  const raw = await secureAuthStorage.getItem(key)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

export const secureIdentityStore: IdentityStore = {
  async load() {
    const r = StoredIdentity.safeParse(await readJson(IDENTITY))
    return r.success ? r.data : null
  },
  save: (identity) => secureAuthStorage.setItem(IDENTITY, JSON.stringify(identity)),
}

/** Writes go one at a time, so two quick changes cannot overwrite each other. */
export function securePairingStore(): PairingStore {
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }
  const records = async (): Promise<PairingRecord[]> => {
    const raw = await readJson(RECORDS)
    if (!Array.isArray(raw)) return []
    return raw.flatMap((r) => {
      const p = PairingRecord.safeParse(r)
      return p.success ? [p.data] : []
    })
  }
  const revoked = async (): Promise<string[]> => {
    const raw = await readJson(REVOKED)
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  }
  return {
    list: () => serial(records),
    put: (record) =>
      serial(async () => {
        const all = (await records()).filter((r) => r.pairingId !== record.pairingId)
        await secureAuthStorage.setItem(RECORDS, JSON.stringify([...all, record]))
      }),
    delete: (pairingId) =>
      serial(async () => {
        const all = await records()
        await secureAuthStorage.setItem(RECORDS, JSON.stringify(all.filter((r) => r.pairingId !== pairingId)))
      }),
    revokedGrants: () => serial(revoked),
    addRevokedGrant: (grantId) =>
      serial(async () => {
        const all = await revoked()
        await secureAuthStorage.setItem(REVOKED, JSON.stringify([...new Set([...all, grantId])].slice(-200)))
      }),
  }
}
