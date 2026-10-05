// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sxlockFromEnv, type SxlockOptions } from '../src/sxlock'
import { connect, data as raw, text } from './helpers'

const data = <T>(r: Parameters<typeof raw>[0]): T => raw<{ output: T }>(r).output

afterEach(() => vi.restoreAllMocks())

// The sxlock_*_with_token functions of supabase/migrations/0010_sxlock.sql, in memory, for one account's tokens.
function accountService(tokens: Record<string, { user: string; scopes: string[] }>) {
  const secrets = new Map<string, { user: string; secret: Buffer }>()
  const derive = (secret: Buffer, owner: string, keyId: string, salt: string) =>
    createHmac('sha256', secret).update(Buffer.concat([Buffer.from('sxlock/v1'), Buffer.from(owner.replace(/-/g, ''), 'hex'), Buffer.from(keyId.replace(/-/g, ''), 'hex'), Buffer.from(salt, 'hex')])).digest('hex')
  const deny = (hint: string) => new Response(JSON.stringify({ code: '42501', hint, message: hint }), { status: 403 })
  const calls: string[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    const fn = url.split('/rpc/')[1] ?? ''
    calls.push(fn)
    const a = JSON.parse(String(init.body)) as { p_token: string; p_salt: string; p_owner?: string; p_key_id?: string }
    const t = tokens[a.p_token]
    if (!t) return deny('signed_out')
    if (fn === 'sxlock_seal_with_token') {
      if (!t.scopes.includes('sxlock_seal')) return deny('missing_scope')
      let id = [...secrets].find(([, s]) => s.user === t.user)?.[0]
      if (!id) secrets.set((id = randomUUID()), { user: t.user, secret: randomBytes(32) })
      return Response.json([{ owner: t.user, key_id: id, content_key: derive(secrets.get(id)!.secret, t.user, id, a.p_salt) }])
    }
    if (!t.scopes.includes('sxlock_open')) return deny('missing_scope')
    if (a.p_owner !== t.user) return deny('wrong_account')
    const k = secrets.get(a.p_key_id ?? '')
    if (!k || k.user !== t.user) return deny('unknown_key')
    return Response.json(derive(k.secret, a.p_owner, a.p_key_id!, a.p_salt))
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const RV = randomUUID()
const ASH = randomUUID()
const conf = (token: string, fetch: typeof globalThis.fetch): SxlockOptions => ({ supabaseUrl: 'https://db.example', anonKey: 'anon', token, fetch })
const project = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from(' 3D/3dmodel.model bracket-v2')])

function projectFile(dir: string): string {
  const f = join(dir, 'bracket.sx3mf')
  writeFileSync(f, project)
  return f
}

describe('locked projects when no account service is configured', () => {
  it('opening and exporting say how to enable them, without any network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const h = await connect()
    const o = await h.call('slicerx_sxlock_open', { file: join(h.dir, 'x.sxlock') })
    expect(o.isError).toBe(true)
    expect(text(o)).toMatch(/Locked projects are not configured/)
    const e = await h.call('slicerx_sxlock_export', { file: projectFile(h.dir) })
    expect(text(e)).toMatch(/sxlock_seal/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reads the account service from the environment or a resolved edition config', () => {
    expect(sxlockFromEnv({})).toBeUndefined()
    expect(sxlockFromEnv({ SLICERX_MCP_SUPABASE_URL: 'https://db.example/', SLICERX_MCP_SUPABASE_ANON_KEY: 'a', SLICERX_MCP_SXLOCK_TOKEN: 'sxk_1' })).toMatchObject({ supabaseUrl: 'https://db.example', anonKey: 'a', token: 'sxk_1' })
    expect(() => sxlockFromEnv({ SLICERX_MCP_SUPABASE_URL: 'http://db.example', SLICERX_MCP_SUPABASE_ANON_KEY: 'a' })).toThrow(/https/)
    const file = join(mkdtempSync(join(tmpdir(), 'slicerx-sxlock-')), 'config.json')
    writeFileSync(file, JSON.stringify({ backend: { supabase: { url: 'https://db.example', anonKey: 'anon' } } }))
    expect(sxlockFromEnv({ SLICERX_CONFIG: file })?.supabaseUrl).toBe('https://db.example')
  })
})

describe('locked projects through MCP', () => {
  it('exports with sxlock_seal, inspects offline and opens with sxlock_open', async () => {
    const svc = accountService({ sxk_both: { user: RV, scopes: ['sxlock_open', 'sxlock_seal'] } })
    const h = await connect({ sxlock: conf('sxk_both', svc.fetch) })
    const locked = data<{ path: string; owner: string }>(await h.call('slicerx_sxlock_export', { file: projectFile(h.dir) }))
    expect(locked.owner).toBe(RV)
    expect(readFileSync(locked.path).includes('bracket-v2')).toBe(false)
    const head = data<{ owner: string; format: string }>(await h.call('slicerx_sxlock_inspect', { file: locked.path }))
    expect(head).toMatchObject({ owner: RV, format: 'sx3mf' })
    expect(svc.calls).toEqual(['sxlock_seal_with_token'])
    const opened = data<{ path: string }>(await h.call('slicerx_sxlock_open', { file: locked.path }))
    expect(opened.path).toMatch(/bracket\.sx3mf$/)
    expect(readFileSync(opened.path).equals(project)).toBe(true)
  })

  it('a token only does what its scopes allow, and only for its own account', async () => {
    const svc = accountService({ sxk_rv: { user: RV, scopes: ['sxlock_seal'] }, sxk_rv_open: { user: RV, scopes: ['sxlock_open'] }, sxk_ash: { user: ASH, scopes: ['sxlock_open', 'sxlock_seal'] } })
    const exporter = await connect({ sxlock: conf('sxk_rv', svc.fetch) })
    const locked = data<{ path: string }>(await exporter.call('slicerx_sxlock_export', { file: projectFile(exporter.dir) }))
    const noOpen = await exporter.call('slicerx_sxlock_open', { file: locked.path })
    expect(noOpen.isError).toBe(true)
    expect(text(noOpen)).toMatch(/missing_scope/)

    const opener = await connect({ sxlock: conf('sxk_rv_open', svc.fetch), allowDirs: [exporter.dir] })
    const noExport = await opener.call('slicerx_sxlock_export', { file: projectFile(exporter.dir) })
    expect(text(noExport)).toMatch(/missing_scope/)
    expect(data<{ path: string }>(await opener.call('slicerx_sxlock_open', { file: locked.path })).path).toMatch(/\.sx3mf$/)

    const other = await connect({ sxlock: conf('sxk_ash', svc.fetch), allowDirs: [exporter.dir] })
    const r = await other.call('slicerx_sxlock_open', { file: locked.path })
    expect(text(r)).toMatch(/another SlicerX account/)
  })

  it('offline or tampered, nothing is written and the reason is plain', async () => {
    const svc = accountService({ sxk_both: { user: RV, scopes: ['sxlock_open', 'sxlock_seal'] } })
    const h = await connect({ sxlock: conf('sxk_both', svc.fetch) })
    const locked = data<{ path: string }>(await h.call('slicerx_sxlock_export', { file: projectFile(h.dir) }))
    const bytes = readFileSync(locked.path)
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1
    const bad = join(h.dir, 'bad.sxlock')
    writeFileSync(bad, bytes)
    expect(text(await h.call('slicerx_sxlock_open', { file: bad }))).toMatch(/damaged/)

    const down = await connect({ sxlock: conf('sxk_both', (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch), allowDirs: [h.dir] })
    const r = await down.call('slicerx_sxlock_open', { file: locked.path })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/only online/)
    expect(text(await h.call('slicerx_sxlock_export', { file: join(h.dir, 'cube.stl') }))).toMatch(/Expected a \.sx3mf/)
  })
})
