// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Long-term device identity (an Ed25519 signing key and an X25519 key-agreement key), the
// pairing records built on it, and the storage interfaces each platform implements.
import { z } from 'zod'
import { fromB64url, toB64url } from './bytes'
import { dhKeyPair, sha256, signKeyPair, type PairEnv } from './crypto'
import { DeviceGrant, Endpoints, Id16, Key32, PublicIdentity, Rights, type DevicePlatform } from './schema'

export interface DeviceIdentity {
  public: PublicIdentity
  signSecret: Uint8Array
  dhSecret: Uint8Array
}

export const deviceIdFor = (signPub: Uint8Array): string => toB64url(sha256(signPub).slice(0, 16))

export function createIdentity(env: PairEnv, name: string, platform: DevicePlatform): DeviceIdentity {
  const s = signKeyPair(env)
  const d = dhKeyPair(env)
  return {
    public: {
      deviceId: deviceIdFor(s.publicKey),
      name: cleanLabel(name),
      platform,
      signPub: toB64url(s.publicKey),
      dhPub: toB64url(d.publicKey),
    },
    signSecret: s.secretKey,
    dhSecret: d.secretKey,
  }
}

/** Trims, drops control characters, and fits a label into the 64 character wire limit. */
export function cleanLabel(text: string): string {
  // eslint-disable-next-line no-control-regex
  const t = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim().slice(0, 64)
  return t === '' ? 'Device' : t
}

export const StoredIdentity = z.object({ public: PublicIdentity, signSecret: Key32, dhSecret: Key32 })
export type StoredIdentity = z.infer<typeof StoredIdentity>

export const storeIdentity = (id: DeviceIdentity): StoredIdentity => ({
  public: id.public,
  signSecret: toB64url(id.signSecret),
  dhSecret: toB64url(id.dhSecret),
})

export function loadIdentity(stored: unknown): DeviceIdentity | null {
  const r = StoredIdentity.safeParse(stored)
  if (!r.success) return null
  const signSecret = fromB64url(r.data.signSecret)
  const dhSecret = fromB64url(r.data.dhSecret)
  if (!signSecret || !dhSecret) return null
  return { public: r.data.public, signSecret, dhSecret }
}

/**
 * One trusted peer. On a host the peer is a phone; on a phone the peer is a host.
 * `deviceKey` is secret: stores must keep records in the OS keychain or secure storage.
 */
export const PairingRecord = z.object({
  pairingId: Id16,
  peer: PublicIdentity,
  deviceKey: Key32,
  /** The phone's rights on the host. A phone keeps a copy for its UI; only the host's copy counts. */
  rights: Rights,
  createdAt: z.number().int().nonnegative(),
  /** How to reach the host. Phone side only. */
  endpoints: Endpoints.optional(),
  accountId: z.string().max(64).optional(),
  /** Set when a trusted device introduced this phone with a grant. */
  introducedBy: Id16.optional(),
  grantId: Id16.optional(),
  /** Phone side: the grant to present on first contact. Dropped once the host has accepted it. */
  pendingGrant: DeviceGrant.optional(),
  lastSeenAt: z.number().int().nonnegative().optional(),
  /** Phone side: unpaired here while the host could not be told. Kept, with its key, until the host confirms. */
  pendingRevoke: z.literal(true).optional(),
})
export type PairingRecord = z.infer<typeof PairingRecord>

export interface PairingStore {
  list(): Promise<PairingRecord[]>
  put(record: PairingRecord): Promise<void>
  delete(pairingId: string): Promise<void>
  /** Grant ids of revoked introductions, so a revoked grant cannot pair again. Host side. */
  revokedGrants(): Promise<string[]>
  addRevokedGrant(grantId: string): Promise<void>
}

export interface IdentityStore {
  load(): Promise<StoredIdentity | null>
  save(identity: StoredIdentity): Promise<void>
}

/** For tests and for hosts that should forget pairings on restart. */
export function memoryPairingStore(initial: PairingRecord[] = []): PairingStore {
  const records = new Map(initial.map((r) => [r.pairingId, structuredClone(r)]))
  const revoked = new Set<string>()
  return {
    list: async () => [...records.values()].map((r) => structuredClone(r)),
    put: async (r) => {
      records.set(r.pairingId, structuredClone(PairingRecord.parse(r)))
    },
    delete: async (id) => {
      records.delete(id)
    },
    revokedGrants: async () => [...revoked],
    addRevokedGrant: async (id) => {
      revoked.add(id)
    },
  }
}

export function memoryIdentityStore(): IdentityStore {
  let saved: StoredIdentity | null = null
  return {
    load: async () => saved,
    save: async (id) => {
      saved = structuredClone(id)
    },
  }
}

/** Loads the identity, or creates and saves one on first run. */
export async function ensureIdentity(store: IdentityStore, env: PairEnv, name: string, platform: DevicePlatform): Promise<DeviceIdentity> {
  const existing = loadIdentity(await store.load())
  if (existing) return existing
  const created = createIdentity(env, name, platform)
  await store.save(storeIdentity(created))
  return created
}

export const ALL_RIGHTS: Rights = { request: true, approve: true, introduce: true }
export const NO_RIGHTS: Rights = { request: false, approve: false, introduce: false }

export const intersectRights = (a: Rights, b: Rights): Rights => ({
  request: a.request && b.request,
  approve: a.approve && b.approve,
  introduce: a.introduce && b.introduce,
})
