// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// AuthClient over a Supabase project: PKCE sign-in, sessions and personal API
// tokens. Needs only the auth module's tables (supabase/migrations/0001_auth.sql).
import type { AccountExport, ApiToken, AuthClient, AuthProvider, PairedDeviceEvent, Session, SignInMethod, StoreErrorCode, StoreResult } from '@slicerx/contracts'
import { createClient, type RealtimeChannel, type SupabaseClient, type Session as SbSession } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from '../generated/database'
import { isoTime, toDevice } from '../map'
import { pairedDeviceRow, profileRow } from '../rows'
import { validateDevice } from '../validate'
import { ACCOUNT_DELETION_POLICY } from './account'
import type { AuthStorage } from './callbacks'
import { supabaseSxlock } from './sxlock'

export interface SupabaseOptions {
  url: string
  anonKey: string
  auth?: {
    /** Where magic links and OAuth return: a web /auth/callback URL or slicerx://auth/callback. */
    redirectUrl: () => string
    /** Desktop: open the provider page in the system browser. Web omits it and navigates. */
    openExternal?: (url: string) => Promise<void>
    /** Session persistence. Desktop passes a keychain-backed store; web defaults to localStorage. */
    storage?: AuthStorage
  }
  fetch?: typeof fetch
  /** Sign-in methods to offer. Defaults to email only. */
  signIn?: SignInMethod[]
}

export type Db = SupabaseClient<Database>

export const ok = <T>(value: T): StoreResult<T> => ({ ok: true, value })
export const fail = <T>(code: StoreErrorCode, message: string): StoreResult<T> => ({ ok: false, code, message })

/** Maps a PostgREST or Postgres error to a store error code. */
export function errorCode(e: { code?: string; message?: string; hint?: string | null } | null | undefined): StoreErrorCode {
  if (e?.hint === 'rate_limited') return 'rate_limited'
  switch (e?.code) {
    case '42501':
      return 'forbidden'
    case 'PGRST116':
    case 'P0002':
      return 'not_found'
    case '23505':
    case 'P0001':
      return 'conflict'
    case '23514':
    case '23502':
    case '23503':
    case '22P02':
    case '22001':
      return 'invalid'
    default:
      return e?.message?.toLowerCase().includes('fetch') ? 'unavailable' : 'invalid'
  }
}

export function rows<T extends z.ZodType>(schema: T, data: unknown): z.infer<T>[] {
  return z.array(schema).parse(data ?? [])
}

type Res = { data: unknown; error: { code?: string; message: string } | null }

export async function read<T extends z.ZodType>(schema: T, q: PromiseLike<Res>): Promise<z.infer<T>[]> {
  const { data, error } = await q
  if (error) throw new Error(`store read failed (${error.code ?? 'unknown'}): ${error.message}`)
  return rows(schema, data)
}

export async function write<T>(q: PromiseLike<Res>, map: (data: unknown) => T): Promise<StoreResult<T>> {
  const { data, error } = await q
  if (error) return fail(errorCode(error), error.message)
  return ok(map(data))
}

/** Key the session is stored under in the AuthStorage. */
export const AUTH_STORAGE_KEY = 'sx-auth'

/** Refresh the access token when fewer than this many seconds remain. */
const REFRESH_MARGIN_S = 60

export function createSupabaseClient(opts: SupabaseOptions): Db {
  return createClient<Database>(opts.url, opts.anonKey, {
    auth: {
      flowType: 'pkce',
      // Callbacks are completed explicitly through completeSignIn, on both hosts.
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: true,
      // One fixed key, so web and native storage adapters hold the session under the same name.
      storageKey: AUTH_STORAGE_KEY,
      ...(opts.auth?.storage ? { storage: opts.auth.storage } : {}),
    },
    ...(opts.fetch ? { global: { fetch: opts.fetch } } : {}),
  })
}

const apiTokenRow = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.enum(['read', 'mcp', 'cli', 'cloud_slice', 'link', 'sxlock_open', 'sxlock_seal'])),
  rate_limit_per_minute: z.number().int(),
  created_at: z.string(),
  expires_at: z.string().nullable(),
  last_used_at: z.string().nullable(),
  last_used_ip: z.string().nullable(),
  revoked_at: z.string().nullable(),
})

const toApiToken = (r: z.infer<typeof apiTokenRow>): ApiToken => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes,
  rateLimitPerMinute: r.rate_limit_per_minute,
  createdAt: isoTime(r.created_at),
  ...(r.expires_at ? { expiresAt: isoTime(r.expires_at) } : {}),
  ...(r.last_used_at ? { lastUsedAt: isoTime(r.last_used_at) } : {}),
  ...(r.last_used_ip ? { lastUsedIp: r.last_used_ip } : {}),
  ...(r.revoked_at ? { revokedAt: isoTime(r.revoked_at) } : {}),
})

const exportDoc = z.object({ format: z.literal('slicerx-account-export'), version: z.number(), exported_at: z.string() }).passthrough()
const policyRow = z.object({ grace_days: z.number().int(), removed: z.array(z.string()), kept: z.array(z.string()) })

const PROFILE_COLUMNS = 'id, handle, display_name, avatar_url, role, banned_at, ban_reason'
const DEVICE_COLUMNS = 'id, user_id, device_id, name, platform, sign_pub, linked_at, revoked_at'
const TOKEN_COLUMNS = 'id, name, prefix, scopes, rate_limit_per_minute, created_at, expires_at, last_used_at, last_used_ip, revoked_at'

/** What a failed code exchange means for the person holding the link. */
export function signInError(error: { code?: string | undefined; message: string; name?: string | undefined }): string {
  const code = error.code ?? ''
  if (code === 'bad_code_verifier' || code === 'pkce_verifier_missing' || error.name === 'AuthPKCECodeVerifierMissingError' || /code (verifier|challenge)/i.test(error.message)) {
    return 'This link answers an earlier request. Open the newest sign-in email, or send a new link.'
  }
  if (code === 'flow_state_not_found' || code === 'flow_state_expired' || /flow state|expired|already used/i.test(error.message)) {
    return 'This link has expired or was already used. Send a new link.'
  }
  return error.message
}

export function supabaseAuth(sb: Db, opts: SupabaseOptions): AuthClient {
  const exchanges = new Map<string, Promise<StoreResult<Session>>>()
  async function toSession(s: SbSession | null): Promise<Session | null> {
    if (!s) return null
    const [profile, creators] = await Promise.all([
      read(profileRow, sb.from('profiles').select(PROFILE_COLUMNS).eq('id', s.user.id)),
      // The store module may be absent; a missing creators table means no creator page.
      sb.from('creators').select('id').eq('owner_id', s.user.id).then((r) => (r.error ? [] : rows(z.object({ id: z.string() }), r.data))),
    ])
    const p = profile[0]
    const creator = creators[0]
    return {
      userId: s.user.id,
      ...(creator ? { creatorId: creator.id } : {}),
      ...(s.user.email ? { email: s.user.email } : {}),
      ...(p ? { handle: p.handle, displayName: p.display_name, role: p.banned_at === null ? p.role : ('banned' as const) } : {}),
    }
  }

  async function uid(): Promise<string | null> {
    const { data } = await sb.auth.getSession()
    return data.session?.user.id ?? null
  }

  async function currentAccessToken(): Promise<string | null> {
    const { data } = await sb.auth.getSession()
    const s = data.session
    if (!s) return null
    if ((s.expires_at ?? 0) - Date.now() / 1000 > REFRESH_MARGIN_S) return s.access_token
    const refreshed = await sb.auth.refreshSession()
    return refreshed.data.session?.access_token ?? null
  }

  return {
    mode: 'supabase',
    ...supabaseSxlock(sb, async () => (await uid()) !== null),

    signInMethods: () => ['email', 'github', 'google', 'apple', 'discord'],

    async session() {
      const { data } = await sb.auth.getSession()
      return toSession(data.session)
    },

    async signInWithEmail(email) {
      const redirect = opts.auth?.redirectUrl()
      const { error } = await sb.auth.signInWithOtp({ email: email.trim(), options: redirect ? { emailRedirectTo: redirect } : {} })
      return error ? fail(error.status === 429 ? 'conflict' : 'invalid', error.message) : ok(undefined)
    },

    async signInWithOAuth(provider: AuthProvider) {
      const redirect = opts.auth?.redirectUrl()
      const external = opts.auth?.openExternal
      const { data, error } = await sb.auth.signInWithOAuth({
        provider,
        options: { skipBrowserRedirect: external !== undefined, ...(redirect ? { redirectTo: redirect } : {}) },
      })
      if (error) return fail('unavailable', error.message)
      if (external && data.url) await external(data.url)
      return ok(undefined)
    },

    async completeSignIn(callbackUrl) {
      let url: URL
      try {
        url = new URL(callbackUrl)
      } catch {
        return fail('invalid', 'The sign-in link is not a valid URL')
      }
      const err = url.searchParams.get('error_description') ?? url.searchParams.get('error')
      if (err) return fail('forbidden', err)
      const code = url.searchParams.get('code')
      if (!code) return fail('invalid', 'The sign-in link has no code')
      // A code works once: the same link handed over twice (a second launch, a second click) shares the first exchange.
      const running = exchanges.get(code)
      if (running) return running
      const exchange = (async (): Promise<StoreResult<Session>> => {
        // The flow id names which pending request this link answers, when the link carries it.
        const flowId = url.searchParams.get('sb_flow_id')
        const { data, error } = await sb.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined)
        if (error) return fail('forbidden', signInError(error))
        const s = await toSession(data.session)
        return s ? ok(s) : fail('not_signed_in', 'No session after sign-in')
      })()
      exchanges.set(code, exchange)
      return exchange
    },

    async signOut() {
      await sb.auth.signOut()
    },

    onSessionChange(cb) {
      const { data } = sb.auth.onAuthStateChange((_event, s) => {
        // Deferred: the auth callback must not await other Supabase calls.
        setTimeout(() => {
          void toSession(s).then(cb)
        }, 0)
      })
      return () => data.subscription.unsubscribe()
    },

    getAccessToken: currentAccessToken,

    accessToken: currentAccessToken,

    onTokenChange(cb) {
      let last: string | null | undefined
      const { data } = sb.auth.onAuthStateChange((_event, s) => {
        const token = s?.access_token ?? null
        if (token === last) return
        last = token
        // Deferred: the auth callback must not await other Supabase calls.
        setTimeout(() => cb(token), 0)
      })
      return () => data.subscription.unsubscribe()
    },

    async apiTokens() {
      const me = await uid()
      if (!me) return []
      return (await read(apiTokenRow, sb.from('api_tokens').select(TOKEN_COLUMNS).eq('user_id', me).order('created_at', { ascending: false }))).map(toApiToken)
    },

    async createApiToken(input) {
      if (!(await uid())) return fail('not_signed_in', 'Sign in first')
      const { data, error } = await sb.rpc('create_api_token', {
        p_name: input.name.trim(),
        p_scopes: input.scopes,
        ...(input.expiresInDays === undefined ? {} : { p_expires_in_days: input.expiresInDays as number }),
        ...(input.rateLimitPerMinute === undefined ? {} : { p_rate_limit_per_minute: input.rateLimitPerMinute }),
      })
      if (error) return fail(errorCode(error), error.message)
      const created = rows(z.object({ id: z.string(), token: z.string() }), data)[0]
      if (!created) return fail('unavailable', 'No token returned')
      const saved = (await read(apiTokenRow, sb.from('api_tokens').select(TOKEN_COLUMNS).eq('id', created.id)))[0]
      return saved ? ok({ token: toApiToken(saved), secret: created.token }) : fail('not_found', 'Token not readable after create')
    },

    async revokeApiToken(id) {
      if (!(await uid())) return fail('not_signed_in', 'Sign in first')
      const { data, error } = await sb.rpc('revoke_api_token', { p_id: id })
      if (error) return fail(errorCode(error), error.message)
      return data === true ? ok(undefined) : fail('not_found', 'Token not found')
    },

    async revokeAllApiTokens() {
      if (!(await uid())) return fail('not_signed_in', 'Sign in first')
      const { data, error } = await sb.rpc('revoke_all_api_tokens')
      return error ? fail(errorCode(error), error.message) : ok({ revoked: Number(data) })
    },

    async listPairedDevices() {
      const me = await uid()
      if (!me) return []
      return (await read(pairedDeviceRow, sb.from('paired_devices').select(DEVICE_COLUMNS).eq('user_id', me).order('linked_at', { ascending: false }))).map(toDevice)
    },

    async addPairedDevice(input) {
      const me = await uid()
      if (!me) return fail('not_signed_in', 'Sign in first')
      const valid = validateDevice(input)
      if (!valid.ok) return fail('invalid', valid.message)
      const { data, error } = await sb
        .from('paired_devices')
        .insert({ user_id: me, device_id: input.deviceId, name: input.name, platform: input.platform, sign_pub: input.signPub })
        .select(DEVICE_COLUMNS)
        .single()
      if (error) return fail(errorCode(error), error.message)
      return ok(toDevice(pairedDeviceRow.parse(data)))
    },

    async revokePairedDevice(id) {
      const me = await uid()
      if (!me) return fail('not_signed_in', 'Sign in first')
      // 'now' is read by the database, so the time never disagrees with linked_at.
      const { error, count } = await sb.from('paired_devices').update({ revoked_at: 'now' }, { count: 'exact' }).eq('id', id).eq('user_id', me)
      if (error) return fail(errorCode(error), error.message)
      return count === 0 ? fail('not_found', 'Device not found') : ok(undefined)
    },

    onPairedDeviceChange(cb) {
      let channel: RealtimeChannel | null = null
      let stopped = false
      let seq = 0
      let openedFor: string | null = null
      const close = () => {
        if (channel) void sb.removeChannel(channel)
        channel = null
        openedFor = null
      }
      const open = async () => {
        const me = await uid()
        // supabase-js repeats SIGNED_IN on tab focus; keep the channel while the member is the same.
        if (stopped || me === openedFor) return
        close()
        if (!me) return
        openedFor = me
        const emit = (type: PairedDeviceEvent['type'], row: unknown) => {
          const parsed = pairedDeviceRow.safeParse(row)
          if (parsed.success) cb({ type, device: toDevice(parsed.data) })
        }
        seq += 1
        channel = sb
          .channel(`paired_devices:${me}:${seq}`)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'paired_devices', filter: `user_id=eq.${me}` }, (p) => emit('added', p.new))
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'paired_devices', filter: `user_id=eq.${me}` }, (p) => {
            // Only revoked_at can change, so an update with it set is a revocation.
            if ((p.new as { revoked_at?: unknown }).revoked_at) emit('revoked', p.new)
          })
          .subscribe()
      }
      void open()
      // Follow the session: a new sign-in listens for its own devices, sign-out stops.
      const { data } = sb.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') setTimeout(() => void open(), 0)
      })
      return () => {
        stopped = true
        data.subscription.unsubscribe()
        close()
      }
    },

    async exportMyData() {
      if (!(await uid())) return fail('not_signed_in', 'Sign in first')
      const { data, error } = await sb.rpc('export_my_data')
      if (error) return fail(errorCode(error), error.message)
      const parsed = exportDoc.safeParse(data)
      return parsed.success ? ok(parsed.data as AccountExport) : fail('unavailable', 'The export came back in an unknown format')
    },

    async accountDeletionPolicy() {
      const { data, error } = await sb.rpc('account_deletion_policy')
      if (error) return ACCOUNT_DELETION_POLICY
      const p = policyRow.safeParse(data)
      return p.success ? { graceDays: p.data.grace_days, removed: p.data.removed, kept: p.data.kept } : ACCOUNT_DELETION_POLICY
    },

    async requestAccountDeletion() {
      if (!(await uid())) return fail('not_signed_in', 'Sign in first')
      const { data, error } = await sb.rpc('request_account_deletion')
      if (error) return fail(errorCode(error), error.message)
      const p = policyRow.extend({ purge_after: z.string() }).safeParse(data)
      if (!p.success) return fail('unavailable', 'Unexpected answer to the deletion request')
      return ok({ graceDays: p.data.grace_days, removed: p.data.removed, kept: p.data.kept, purgeAfter: isoTime(p.data.purge_after) })
    },

    async cancelAccountDeletion() {
      if (!(await uid())) return fail('not_signed_in', 'Sign in first')
      const { data, error } = await sb.rpc('cancel_account_deletion')
      if (error) return fail(errorCode(error), error.message)
      return data === true ? ok(undefined) : fail('not_found', 'No deletion is scheduled')
    },

    async pendingAccountDeletion() {
      const me = await uid()
      if (!me) return null
      const found = await read(
        z.object({ requested_at: z.string(), purge_after: z.string() }),
        sb.from('account_deletions').select('requested_at, purge_after').eq('user_id', me).is('canceled_at', null).is('completed_at', null),
      )
      const d = found[0]
      return d ? { requestedAt: isoTime(d.requested_at), purgeAfter: isoTime(d.purge_after) } : null
    },
  }
}
