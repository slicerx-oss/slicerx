// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Offline AuthClient over the bundled seed's example accounts.
import type { AccountExport, ApiToken, ApiTokenScope, AuthClient, AuthProvider, EffectiveRole, PairedDeviceEvent, Session, SignInMethod, StoreErrorCode, StoreResult } from '@slicerx/contracts'
import { toDevice } from '../map'
import type { PairedDeviceRow, SeedData } from '../rows'
import { validateDevice } from '../validate'
import { ACCOUNT_DELETION_POLICY } from './account'

export interface OfflineOptions {
  offline: true
  /** Start signed in as this handle. Defaults to the demo member "rv"; null starts signed out. */
  signedInAs?: string | null
  /** Clock for new rows. Tests pass a fixed one. */
  now?: () => Date
  /** Id source for new rows. Defaults to crypto.randomUUID. */
  newId?: () => string
  /** Supply a seed directly instead of loading the bundled one (tests). */
  seed?: SeedData
  /** Sign-in methods to offer. Defaults to email only. */
  signIn?: SignInMethod[]
}

export const ok = <T>(value: T): StoreResult<T> => ({ ok: true, value })
export const fail = <T>(code: StoreErrorCode, message: string): StoreResult<T> => ({ ok: false, code, message })

const SCOPES: readonly ApiTokenScope[] = ['read', 'mcp', 'cli', 'cloud_slice', 'link', 'sxlock_open', 'sxlock_seal']
const MAX_TOKENS = 20
const NO_SXLOCK = { ok: false as const, reason: 'unavailable' as const, message: 'Locked projects need a SlicerX account service, and this build has none.' }
const MAX_DEVICES = 10

/** State shared by the offline auth and store parts of one client. */
export interface OfflineContext {
  db(): Promise<SeedData>
  currentUser(): Promise<string | null>
  setUser(id: string | null): Promise<void>
  sessionFor(id: string | null): Promise<Session | null>
  /** The role my_role() would answer for this user; 'banned' for a banned account, null for nobody. */
  roleOf(id: string | null): Promise<EffectiveRole | null>
  listeners: Set<(s: Session | null) => void>
  /** Offline API tokens, in memory. Banning a member revokes theirs, as the database does. */
  tokens: { userId: string; token: ApiToken }[]
  now(): Date
  newId(): string
}

async function loadBundledSeed(): Promise<SeedData> {
  const mod = await import('../offline-seed')
  return mod.bundledSeed()
}

export function createOfflineContext(opts: OfflineOptions): OfflineContext {
  let dbPromise: Promise<SeedData> | null = null
  // Deep copy so mutations never leak into the shared module-level seed.
  const db = () => (dbPromise ??= (opts.seed ? Promise.resolve(opts.seed) : loadBundledSeed()).then((s) => structuredClone(s)))
  let userId: string | null | undefined
  const listeners = new Set<(s: Session | null) => void>()

  async function currentUser(): Promise<string | null> {
    if (userId !== undefined) return userId
    const d = await db()
    const handle = opts.signedInAs === undefined ? 'rv' : opts.signedInAs
    userId = handle === null ? null : (d.profiles.find((p) => p.handle === handle)?.id ?? null)
    return userId
  }

  async function sessionFor(id: string | null): Promise<Session | null> {
    if (!id) return null
    const d = await db()
    const p = d.profiles.find((x) => x.id === id)
    const u = d.users.find((x) => x.id === id)
    if (!p) return null
    const creator = d.creators.find((c) => c.owner_id === id)
    return {
      userId: id,
      handle: p.handle,
      displayName: p.display_name,
      role: p.banned_at !== null ? 'banned' : p.role,
      ...(creator ? { creatorId: creator.id } : {}),
      ...(u ? { email: u.email } : {}),
    }
  }

  async function roleOf(id: string | null): Promise<EffectiveRole | null> {
    if (!id) return null
    const p = (await db()).profiles.find((x) => x.id === id)
    if (!p) return null
    return p.banned_at !== null ? 'banned' : p.role
  }

  return {
    db,
    currentUser,
    sessionFor,
    roleOf,
    listeners,
    tokens: [],
    async setUser(id) {
      userId = id
      const s = await sessionFor(id)
      for (const cb of listeners) cb(s)
    },
    now: opts.now ?? (() => new Date()),
    newId: opts.newId ?? (() => crypto.randomUUID()),
  }
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export function offlineAuth(ctx: OfflineContext): AuthClient {
  // Offline tokens live in memory for the life of the client and work nowhere else.
  const tokens = ctx.tokens
  const deletions = new Map<string, { requestedAt: string; purgeAfter: string }>()
  const devices: PairedDeviceRow[] = []
  const deviceListeners = new Set<(e: PairedDeviceEvent) => void>()
  // Like Realtime, a listener hears only the signed-in member's own devices.
  const emitDevice = async (row: PairedDeviceRow, type: PairedDeviceEvent['type']) => {
    if ((await ctx.currentUser()) !== row.user_id) return
    for (const cb of [...deviceListeners]) cb({ type, device: toDevice(row) })
  }
  const revokeAll = (uid: string) => {
    let n = 0
    for (const t of tokens) {
      if (t.userId === uid && !t.token.revokedAt) {
        t.token = { ...t.token, revokedAt: ctx.now().toISOString() }
        n += 1
      }
    }
    return n
  }

  return {
    mode: 'offline',

    async session() {
      return ctx.sessionFor(await ctx.currentUser())
    },

    signInMethods: () => ['email'],

    async signInWithEmail(email: string) {
      const d = await ctx.db()
      const u = d.users.find((x) => x.email.toLowerCase() === email.trim().toLowerCase())
      if (!u) return fail('not_found', 'Offline mode only knows the seeded example accounts')
      if ((await ctx.roleOf(u.id)) === 'banned') return fail('forbidden', 'This account is banned')
      await ctx.setUser(u.id)
      return ok(undefined)
    },

    async signInWithOAuth(_provider: AuthProvider) {
      return fail('offline', 'OAuth needs a Supabase project; offline mode signs in with a seeded email')
    },

    async completeSignIn(_url: string) {
      const s = await ctx.sessionFor(await ctx.currentUser())
      return s ? ok(s) : fail('not_signed_in', 'Nothing to complete in offline mode')
    },

    async signOut() {
      await ctx.setUser(null)
    },

    onSessionChange(cb) {
      ctx.listeners.add(cb)
      return () => {
        ctx.listeners.delete(cb)
      }
    },

    // Offline mode has no backend, so there is no token to hand to edition services.
    getAccessToken: async () => null,
    accessToken: async () => null,
    onTokenChange: () => () => {},

    async apiTokens() {
      const uid = await ctx.currentUser()
      return tokens.filter((t) => t.userId === uid).map((t) => t.token)
    },

    async createApiToken(input) {
      const uid = await ctx.currentUser()
      if (!uid) return fail('not_signed_in', 'Sign in first')
      const name = input.name.trim()
      if (name.length < 1 || name.length > 60) return fail('invalid', 'Token names are 1 to 60 characters')
      if (input.scopes.length === 0 || input.scopes.some((s) => !SCOPES.includes(s))) return fail('invalid', 'Pick at least one known scope')
      const days = input.expiresInDays === undefined ? 90 : input.expiresInDays
      if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) return fail('invalid', 'Tokens expire after 1 to 365 days')
      const rate = input.rateLimitPerMinute ?? 60
      if (!Number.isInteger(rate) || rate < 1 || rate > 600) return fail('invalid', 'Rate limits are 1 to 600 requests per minute')
      if (deletions.has(uid)) return fail('conflict', 'This account is scheduled for deletion')
      if (tokens.filter((t) => t.userId === uid && !t.token.revokedAt).length >= MAX_TOKENS) return fail('conflict', 'Token limit reached; revoke one first')
      const secret = `sxk_${randomHex(32)}`
      const created = ctx.now()
      const token: ApiToken = {
        id: ctx.newId(),
        name,
        prefix: secret.slice(0, 12),
        scopes: [...new Set(input.scopes)],
        rateLimitPerMinute: rate,
        createdAt: created.toISOString(),
        ...(days === null ? {} : { expiresAt: new Date(created.getTime() + days * 86_400_000).toISOString() }),
      }
      tokens.push({ userId: uid, token })
      return ok({ token, secret })
    },

    async revokeApiToken(id) {
      const uid = await ctx.currentUser()
      if (!uid) return fail('not_signed_in', 'Sign in first')
      const t = tokens.find((x) => x.userId === uid && x.token.id === id && !x.token.revokedAt)
      if (!t) return fail('not_found', 'Token not found')
      t.token = { ...t.token, revokedAt: ctx.now().toISOString() }
      return ok(undefined)
    },

    async revokeAllApiTokens() {
      const uid = await ctx.currentUser()
      return uid ? ok({ revoked: revokeAll(uid) }) : fail('not_signed_in', 'Sign in first')
    },

    // Locked projects need the account service: the offline client has no server to hold the keys.
    sxlockSeal: async () => NO_SXLOCK,
    sxlockOpen: async () => NO_SXLOCK,
    sxlockKeys: async () => [],
    rotateSxlockKey: async () => NO_SXLOCK,
    revokeSxlockKey: async () => NO_SXLOCK,

    async listPairedDevices() {
      const uid = await ctx.currentUser()
      return devices
        .filter((x) => x.user_id === uid)
        .sort((a, b) => b.linked_at.localeCompare(a.linked_at))
        .map(toDevice)
    },

    async addPairedDevice(input) {
      const uid = await ctx.currentUser()
      if (!uid) return fail('not_signed_in', 'Sign in first')
      if ((await ctx.roleOf(uid)) === 'banned') return fail('forbidden', 'This account is banned')
      const valid = validateDevice(input)
      if (!valid.ok) return fail('invalid', valid.message)
      if (devices.some((x) => x.user_id === uid && x.device_id === input.deviceId)) return fail('conflict', 'This device is already linked')
      if (devices.filter((x) => x.user_id === uid && x.revoked_at === null).length >= MAX_DEVICES) return fail('conflict', 'device limit reached; revoke one first')
      const row: PairedDeviceRow = {
        id: ctx.newId(),
        user_id: uid,
        device_id: input.deviceId,
        name: input.name,
        platform: input.platform,
        sign_pub: input.signPub,
        linked_at: ctx.now().toISOString(),
        revoked_at: null,
      }
      devices.push(row)
      await emitDevice(row, 'added')
      return ok(toDevice(row))
    },

    async revokePairedDevice(id) {
      const uid = await ctx.currentUser()
      if (!uid) return fail('not_signed_in', 'Sign in first')
      const row = devices.find((x) => x.id === id && x.user_id === uid)
      if (!row) return fail('not_found', 'Device not found')
      if (row.revoked_at !== null) return fail('conflict', 'the device is already revoked')
      row.revoked_at = ctx.now().toISOString()
      await emitDevice(row, 'revoked')
      return ok(undefined)
    },

    onPairedDeviceChange(cb) {
      deviceListeners.add(cb)
      return () => {
        deviceListeners.delete(cb)
      }
    },

    async exportMyData() {
      const uid = await ctx.currentUser()
      if (!uid) return fail('not_signed_in', 'Sign in first')
      const d = await ctx.db()
      const mine = <T extends Record<string, unknown>>(rows: readonly T[], col: string) => rows.filter((r) => r[col] === uid)
      const collections = mine(d.collections, 'owner_id')
      const creatorPage = mine(d.creators, 'owner_id')
      const listings = d.listings.filter((l) => creatorPage.some((c) => c.id === l.creator_id))
      const user = d.users.find((u) => u.id === uid)
      const doc: AccountExport = {
        format: 'slicerx-account-export',
        version: 1,
        exported_at: ctx.now().toISOString(),
        account: user ? { id: user.id, email: user.email } : null,
        profile: d.profiles.find((p) => p.id === uid) ?? null,
        api_tokens: tokens.filter((t) => t.userId === uid).map((t) => t.token),
        account_deletion: deletions.get(uid) ?? null,
        paired_devices: mine(devices, 'user_id'),
        likes: mine(d.likes, 'user_id'),
        downloads: mine(d.downloads, 'user_id'),
        follows: mine(d.follows, 'user_id'),
        comments: mine(d.comments, 'user_id'),
        makes: mine(d.makes, 'user_id'),
        collections,
        creator_page: creatorPage,
        collection_items: d.collection_items.filter((i) => collections.some((c) => c.id === i.collection_id)),
        listings,
        listing_versions: d.listing_versions.filter((v) => listings.some((l) => l.id === v.listing_id)),
        creator_links: d.creator_links.filter((k) => creatorPage.some((c) => c.id === k.creator_id)),
      }
      return ok(doc)
    },

    accountDeletionPolicy: async () => ACCOUNT_DELETION_POLICY,

    async requestAccountDeletion() {
      const uid = await ctx.currentUser()
      if (!uid) return fail('not_signed_in', 'Sign in first')
      if ((await ctx.roleOf(uid)) === 'owner') return fail('conflict', 'The owner account cannot be deleted; transfer the owner role first')
      const now = ctx.now()
      const purgeAfter = new Date(now.getTime() + ACCOUNT_DELETION_POLICY.graceDays * 86_400_000).toISOString()
      deletions.set(uid, { requestedAt: now.toISOString(), purgeAfter })
      revokeAll(uid)
      return ok({ ...ACCOUNT_DELETION_POLICY, purgeAfter })
    },

    async cancelAccountDeletion() {
      const uid = await ctx.currentUser()
      if (!uid) return fail('not_signed_in', 'Sign in first')
      return deletions.delete(uid) ? ok(undefined) : fail('not_found', 'No deletion is scheduled')
    },

    async pendingAccountDeletion() {
      const uid = await ctx.currentUser()
      return uid ? (deletions.get(uid) ?? null) : null
    },
  }
}
