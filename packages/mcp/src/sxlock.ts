// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Locked projects (.sxlock, packages/sx3mf/SPEC-sxlock.md): open one to an .sx3mf, lock an .sx3mf for the
// account, read a header. Opening and locking act for the one account whose sxk_ token the server holds, and
// only within the token's scopes (sxlock_open, sxlock_seal). Off until an account service is configured.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { SxlockError, openSxlock, readSxlockHeader, sealSxlock, tokenKeys, type SxlockKeys } from '@slicerx/embed/sxlock'
import { z } from 'zod'
import { checkReadable, ToolInputError, type PathPolicy } from './models'

export interface SxlockOptions {
  /** The edition's Supabase project URL (backend.supabase.url). */
  supabaseUrl: string
  /** Its public anon key (backend.supabase.anonKey). */
  anonKey: string
  /** An sxk_ token with sxlock_open, sxlock_seal or both. Without it, the keychain item `keyRef` is read at call time. */
  token?: string | undefined
  /** Keychain item (account `slicerx`) holding the token; default `slicerx-sxlock`. */
  keyRef?: string | undefined
  fetch?: typeof globalThis.fetch
}

export const SXLOCK_NOT_CONFIGURED =
  'Locked projects are not configured on this server, so nothing was sent. They need the edition\'s account service: start this server with SLICERX_CONFIG naming the resolved edition config (backend.supabase), or set SLICERX_MCP_SUPABASE_URL and SLICERX_MCP_SUPABASE_ANON_KEY. The server then reads an API token with the sxlock_open scope (to open) or sxlock_seal (to lock) from the keychain item slicerx-sxlock, or from SLICERX_MCP_SXLOCK_TOKEN.'

/** The account service from SLICERX_MCP_SUPABASE_URL and _ANON_KEY, else a resolved edition config (SLICERX_CONFIG). */
export function sxlockFromEnv(env: NodeJS.ProcessEnv): SxlockOptions | undefined {
  let url = env['SLICERX_MCP_SUPABASE_URL']
  let anonKey = env['SLICERX_MCP_SUPABASE_ANON_KEY']
  const configPath = env['SLICERX_CONFIG']
  if (!(url && anonKey) && configPath && existsSync(configPath)) {
    const c = JSON.parse(readFileSync(configPath, 'utf8')) as { backend?: { supabase?: { url?: unknown; anonKey?: unknown } } }
    const sb = c.backend?.supabase
    if (typeof sb?.url === 'string' && typeof sb.anonKey === 'string') {
      url = sb.url
      anonKey = sb.anonKey
    }
  }
  if (!url || !anonKey) return undefined
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`account service: "${url}" is not a URL`)
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new Error('account service: use https (http only for localhost)')
  return { supabaseUrl: u.toString().replace(/\/+$/, ''), anonKey, token: env['SLICERX_MCP_SXLOCK_TOKEN'] || undefined, keyRef: env['SLICERX_MCP_SXLOCK_KEY_REF'] || undefined }
}

function readSxlockKey(ref: string): string {
  if (!/^slicerx-sxlock(-[a-z0-9-]+)?$/.test(ref)) throw new ToolInputError(`${ref} is not a SlicerX locked-project credential name`, 'invalid_input')
  let out = ''
  try {
    const opts = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] }
    if (process.platform === 'darwin') out = execFileSync('security', ['find-generic-password', '-s', ref, '-a', 'slicerx', '-w'], opts)
    else if (process.platform === 'linux') out = execFileSync('secret-tool', ['lookup', 'service', ref, 'username', 'slicerx'], opts)
  } catch {
    out = ''
  }
  const key = out.trim()
  if (!key) throw new ToolInputError(`No API token in the keychain under ${ref} (account slicerx). Create a token with the sxlock_open or sxlock_seal scope in your SlicerX account and store it there, or set SLICERX_MCP_SXLOCK_TOKEN.`, 'auth_failed')
  return key
}

export interface SxlockToolDeps {
  sxlock: SxlockOptions | undefined
  policy: PathPolicy
}

const file = z.string().min(1)

function readFile(policy: PathPolicy, path: string, ext: readonly string[]): Buffer {
  const abs = checkReadable(policy, path)
  if (!ext.includes(extname(abs).toLowerCase())) throw new ToolInputError(`Expected a ${ext.join(' or ')} file, not ${basename(abs)}`, 'unsupported_format')
  return readFileSync(abs)
}

function writeOut(policy: PathPolicy, name: string, bytes: Uint8Array): string {
  mkdirSync(policy.outDir, { recursive: true })
  const out = join(policy.outDir, name)
  writeFileSync(out, bytes, { mode: 0o600 })
  return out
}

/** A refusal from the account service or the format, as the tool error a person reads. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof SxlockError) throw new ToolInputError(`${e.message} (${e.code})`, `sxlock_${e.code}`)
    throw e
  }
}

export function sxlockTools(deps: SxlockToolDeps): PilotTool<never>[] {
  const keys = (): SxlockKeys => {
    const c = deps.sxlock
    if (!c) throw new ToolInputError(SXLOCK_NOT_CONFIGURED, 'not_configured')
    return tokenKeys({ supabaseUrl: c.supabaseUrl, anonKey: c.anonKey, token: c.token ?? readSxlockKey(c.keyRef ?? 'slicerx-sxlock'), ...(c.fetch ? { fetch: c.fetch } : {}) })
  }

  const inspect = defineTool({
    name: 'sxlock.inspect',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      'Read the header of a locked SlicerX project (.sxlock) without the network: format version, the owner account id and the key id. Nothing about the project inside is readable without opening it. Use it to tell locked files apart and to see whose they are before opening.',
    input: z.object({ file: file.describe('Absolute path to a .sxlock file') }),
    async run(i) {
      const bytes = readFile(deps.policy, i.file, ['.sxlock'])
      const h = await guarded(async () => readSxlockHeader(new Uint8Array(bytes)))
      return { summary: `Locked project for account ${h.owner}`, output: { version: h.version, format: h.format, cipher: h.cipher, owner: h.owner, keyId: h.keyId, bytes: bytes.length } }
    },
  })

  const open = defineTool({
    name: 'sxlock.open',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      "Open a locked SlicerX project (.sxlock) for the account whose API token this server holds (scope sxlock_open) and write the project as an .sx3mf to the server's output folder, readable only by this user. Needs the network: the account service unlocks each file, and only for its owner. Answers that locked projects are not configured when this server has no account service.",
    input: z.object({ file: file.describe('Absolute path to a .sxlock file') }),
    async run(i) {
      const k = keys()
      const bytes = readFile(deps.policy, i.file, ['.sxlock'])
      const plain = await guarded(() => openSxlock(new Uint8Array(bytes), k))
      const out = writeOut(deps.policy, `${basename(i.file, extname(i.file))}.sx3mf`, plain)
      return { summary: `Opened ${basename(i.file)} to ${out}`, output: { path: out, bytes: plain.length } }
    },
  })

  const lock = defineTool({
    name: 'sxlock.export',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description:
      "Lock an .sx3mf project for the account whose API token this server holds (scope sxlock_seal): writes a .sxlock to the server's output folder that only that account can open, online. The .sx3mf itself is left as it is. Answers that locked projects are not configured when this server has no account service.",
    input: z.object({ file: file.describe('Absolute path to an .sx3mf (or .3mf) project') }),
    async run(i) {
      const k = keys()
      const bytes = readFile(deps.policy, i.file, ['.sx3mf', '.3mf'])
      if (bytes.subarray(0, 4).toString('latin1') !== 'PK\x03\x04') throw new ToolInputError(`${basename(i.file)} is not a 3MF package`, 'invalid_model')
      const locked = await guarded(() => sealSxlock(new Uint8Array(bytes), k))
      const h = readSxlockHeader(locked)
      const out = writeOut(deps.policy, `${basename(i.file, extname(i.file))}.sxlock`, locked)
      return { summary: `Locked ${basename(i.file)} to ${out}`, output: { path: out, owner: h.owner, keyId: h.keyId, bytes: locked.length } }
    },
  })

  return [inspect, open, lock] as PilotTool<never>[]
}
