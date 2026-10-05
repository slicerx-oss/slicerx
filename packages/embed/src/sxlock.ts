// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Locked projects (.sxlock): an .sx3mf encrypted with AES-256-GCM under a per-file content key that only the
// owning SlicerX account can get from the server. Format: packages/sx3mf/SPEC-sxlock.md. The app and integrators
// use this module (@slicerx/embed/sxlock); it needs WebCrypto (browsers, Node 20 and later, Electron).
import type { SxlockFailure, SxlockKeys, SxlockResult } from '@slicerx/contracts'

export type { SxlockFailure, SxlockKeyRef, SxlockKeys, SxlockResult, SxlockSealed } from '@slicerx/contracts'

/** `\x89SXLOCK\n`: not text, and not a zip, so no 3MF reader takes it for a project. */
export const SXLOCK_MAGIC = Uint8Array.of(0x89, 0x53, 0x58, 0x4c, 0x4f, 0x43, 0x4b, 0x0a)
export const SXLOCK_VERSION = 1
/** The header is authenticated as associated data, so every byte of it is covered by the tag. */
export const SXLOCK_HEADER_BYTES = 88
const FORMAT_SX3MF = 1
const CIPHER_AES_256_GCM = 1
const TAG_BYTES = 16

export type SxlockErrorCode = SxlockFailure | 'not_sxlock' | 'unsupported' | 'damaged'

export class SxlockError extends Error {
  constructor(
    readonly code: SxlockErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SxlockError'
  }
}

/** Plain words for each refusal, for an app to show as is. */
export const SXLOCK_MESSAGES: Readonly<Record<SxlockErrorCode, string>> = {
  offline: 'Locked projects open only online, since your SlicerX account unlocks them. Connect to the internet and try again.',
  unavailable: 'Locked projects need a SlicerX account service, and this build has none.',
  signed_out: 'Sign in to the SlicerX account that locked this project to open it.',
  wrong_account: 'This locked project belongs to another SlicerX account.',
  revoked: 'The key this project was locked with was revoked, so it can no longer be opened.',
  unknown_key: 'The key this project was locked with no longer exists, so it can no longer be opened.',
  missing_scope: 'The API token is not allowed to do this. Opening locked projects needs the sxlock_open scope, exporting them sxlock_seal.',
  rate_limited: 'Too many requests to open locked projects. Wait a minute and try again.',
  banned: 'This SlicerX account is banned.',
  invalid: 'The locked project header is not valid.',
  not_sxlock: 'This is not a locked SlicerX project.',
  unsupported: 'This locked project was made by a newer SlicerX. Update SlicerX to open it.',
  damaged: 'The locked project is damaged or was changed after it was exported.',
}

const fail = (code: SxlockErrorCode, message = SXLOCK_MESSAGES[code]): SxlockError => new SxlockError(code, message)

/** What the header says. Nothing about the project inside is readable without the key. */
export interface SxlockHeader {
  version: number
  format: 'sx3mf'
  cipher: 'aes-256-gcm'
  owner: string
  keyId: string
  salt: string
  nonce: Uint8Array
}

/** Whether the bytes start like a locked project. */
export function isSxlock(bytes: Uint8Array): boolean {
  return bytes.length >= SXLOCK_MAGIC.length && SXLOCK_MAGIC.every((b, i) => bytes[i] === b)
}

/** Reads and checks the header. Throws SxlockError for anything that is not a version 1 locked .sx3mf. */
export function readSxlockHeader(bytes: Uint8Array): SxlockHeader {
  if (!isSxlock(bytes)) throw fail('not_sxlock')
  if (bytes.length < SXLOCK_HEADER_BYTES + TAG_BYTES) throw fail('damaged')
  if (bytes[8] !== SXLOCK_VERSION) throw fail('unsupported')
  if (bytes[9] !== FORMAT_SX3MF || bytes[10] !== CIPHER_AES_256_GCM || bytes[11] !== 0) throw fail('unsupported')
  return {
    version: SXLOCK_VERSION,
    format: 'sx3mf',
    cipher: 'aes-256-gcm',
    owner: uuidOf(bytes.subarray(12, 28)),
    keyId: uuidOf(bytes.subarray(28, 44)),
    salt: hexOf(bytes.subarray(44, 76)),
    nonce: bytes.slice(76, 88),
  }
}

/**
 * One locked file's key, for writing new copies of the same file: its header fields and the content key as a
 * non-extractable CryptoKey. Keep it in memory only; it cannot be exported or stored.
 */
export interface SxlockFileKey {
  readonly owner: string
  readonly keyId: string
  readonly salt: string
  readonly key: CryptoKey
}

/** Locks .sx3mf bytes for the signed-in account. */
export async function sealSxlock(sx3mf: Uint8Array, keys: SxlockKeys): Promise<Uint8Array> {
  return (await lockSxlock(sx3mf, keys)).bytes
}

/** Locks .sx3mf bytes and returns the file key too, so later copies can be written with resealSxlock. */
export async function lockSxlock(sx3mf: Uint8Array, keys: SxlockKeys): Promise<{ bytes: Uint8Array; fileKey: SxlockFileKey }> {
  if (!keys.seal) throw fail('signed_out', 'This connection can open locked projects but not make them.')
  const salt = hexOf(random(32))
  const sealed = unwrap(await keys.seal(salt))
  const fileKey: SxlockFileKey = { owner: sealed.owner, keyId: sealed.keyId, salt, key: await importKey(sealed.contentKey) }
  return { bytes: await resealSxlock(sx3mf, fileKey), fileKey }
}

/**
 * Writes .sx3mf bytes as another copy of a locked file: same owner, key id, salt and content key, with a fresh
 * random nonce for every write. No network. Opening the copy needs the account, as for the original.
 */
export async function resealSxlock(sx3mf: Uint8Array, fileKey: SxlockFileKey): Promise<Uint8Array> {
  const header = new Uint8Array(SXLOCK_HEADER_BYTES)
  header.set(SXLOCK_MAGIC, 0)
  header.set([SXLOCK_VERSION, FORMAT_SX3MF, CIPHER_AES_256_GCM, 0], 8)
  header.set(uuidBytes(fileKey.owner), 12)
  header.set(uuidBytes(fileKey.keyId), 28)
  header.set(bytesOf(fileKey.salt), 44)
  header.set(random(12), 76)
  const body = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: header.slice(76, 88), additionalData: header, tagLength: 128 }, fileKey.key, sx3mf as BufferSource))
  const out = new Uint8Array(header.length + body.length)
  out.set(header, 0)
  out.set(body, header.length)
  return out
}

/**
 * Unlocks a locked project and returns its .sx3mf bytes. Asks the account side for the content key, so it needs
 * to be online and signed in as the owner (or hold the owner's token with the sxlock_open scope).
 */
export async function openSxlock(bytes: Uint8Array, keys: SxlockKeys): Promise<Uint8Array> {
  return (await unlockSxlock(bytes, keys)).sx3mf
}

/** Unlocks a locked project and returns the file key with it, for writing later copies (resealSxlock). */
export async function unlockSxlock(bytes: Uint8Array, keys: SxlockKeys): Promise<{ sx3mf: Uint8Array; fileKey: SxlockFileKey }> {
  const h = readSxlockHeader(bytes)
  const key = await importKey(unwrap(await keys.open({ owner: h.owner, keyId: h.keyId, salt: h.salt })))
  try {
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: h.nonce as BufferSource, additionalData: bytes.subarray(0, SXLOCK_HEADER_BYTES) as BufferSource, tagLength: 128 }, key, bytes.subarray(SXLOCK_HEADER_BYTES) as BufferSource)
    return { sx3mf: new Uint8Array(plain), fileKey: { owner: h.owner, keyId: h.keyId, salt: h.salt, key } }
  } catch {
    throw fail('damaged')
  }
}

export interface TokenKeysOptions {
  /** The edition's Supabase project URL, as in its edition config (backend.supabase.url). */
  supabaseUrl: string
  /** The project's public anon key (backend.supabase.anonKey). */
  anonKey: string
  /**
   * The account's sxk_ API token: the sxlock_open scope to open, sxlock_seal to make locked files. Keep it in the
   * system keychain, never in a file.
   */
  token: string
  fetch?: typeof fetch
}

const HEX64 = /^[0-9a-f]{64}$/

/**
 * Locked projects for an integrator acting for one account, with that account's token. What it may do is the
 * token's scopes; a call outside them is refused with missing_scope.
 */
export function tokenKeys(opts: TokenKeysOptions): SxlockKeys {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis)
  const base = `${opts.supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/`
  const rpc = async (fn: string, args: Record<string, string>): Promise<{ ok: true; body: unknown } | { ok: false; reason: SxlockFailure; message: string }> => {
    let res: Response
    try {
      res = await f(base + fn, {
        method: 'POST',
        // The account token travels in the body (p_token). A publishable key (sb_publishable_) is not a JWT and goes
        // in apikey only; a legacy anon JWT also goes as the bearer, as the bug report outbox sends it.
        headers: { apikey: opts.anonKey, ...(opts.anonKey.startsWith('sb_') ? {} : { authorization: `Bearer ${opts.anonKey}` }), 'content-type': 'application/json' },
        body: JSON.stringify({ p_token: opts.token, ...args }),
      })
    } catch {
      return { ok: false, reason: 'offline', message: SXLOCK_MESSAGES.offline }
    }
    const body: unknown = await res.json().catch(() => null)
    return res.ok ? { ok: true, body } : refusal(body, res.status)
  }
  const bad = { ok: false as const, reason: 'invalid' as const, message: SXLOCK_MESSAGES.invalid }
  return {
    async seal(salt) {
      const r = await rpc('sxlock_seal_with_token', { p_salt: salt })
      if (!r.ok) return r
      const row = (Array.isArray(r.body) ? r.body[0] : null) as { owner?: unknown; key_id?: unknown; content_key?: unknown } | null
      if (!row || typeof row.owner !== 'string' || typeof row.key_id !== 'string' || typeof row.content_key !== 'string' || !HEX64.test(row.content_key)) return bad
      return { ok: true, value: { owner: row.owner, keyId: row.key_id, contentKey: row.content_key } }
    },
    async open(ref) {
      const r = await rpc('sxlock_open_with_token', { p_owner: ref.owner, p_key_id: ref.keyId, p_salt: ref.salt })
      if (!r.ok) return r
      return typeof r.body === 'string' && HEX64.test(r.body) ? { ok: true, value: r.body } : bad
    },
  }
}

/** Maps a PostgREST error body from the sxlock functions to a refusal. */
export function refusal(body: unknown, status: number): { ok: false; reason: SxlockFailure; message: string } {
  const e = (body && typeof body === 'object' ? body : {}) as { hint?: unknown; message?: unknown }
  const hint = typeof e.hint === 'string' ? e.hint : ''
  const reason: SxlockFailure = hint in REASONS ? (hint as SxlockFailure) : status >= 500 || status === 0 ? 'offline' : 'invalid'
  return { ok: false, reason, message: SXLOCK_MESSAGES[reason] }
}

const REASONS: Readonly<Record<SxlockFailure, true>> = { offline: true, unavailable: true, signed_out: true, wrong_account: true, revoked: true, unknown_key: true, missing_scope: true, rate_limited: true, banned: true, invalid: true }

function unwrap<T>(r: SxlockResult<T>): T {
  if (r.ok) return r.value
  // The account side's own wording varies; people see the same sentence for each reason.
  throw fail(r.reason)
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle
  if (!s) throw fail('invalid', 'This app has no WebCrypto, which locked projects need.')
  return s
}

function random(n: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(n))
}

async function importKey(hex: string): Promise<CryptoKey> {
  if (!HEX64.test(hex)) throw fail('invalid', 'The account service sent a key that is not valid.')
  return subtle().importKey('raw', bytesOf(hex), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

function hexOf(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

function bytesOf(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function uuidBytes(id: string): Uint8Array {
  const s = id.toLowerCase()
  if (!UUID.test(s)) throw fail('invalid', 'The account service sent an id that is not valid.')
  return bytesOf(s.replace(/-/g, ''))
}

function uuidOf(b: Uint8Array): string {
  const h = hexOf(b)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
