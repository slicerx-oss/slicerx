// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Profile sync against the sync_pull and sync_push functions on a local or LAN
// stack. Skipped unless SLICERX_SUPABASE_URL (loopback or private), SLICERX_SUPABASE_ANON_KEY and
// SERVICE_ROLE_KEY are set; the service key only creates and removes the two
// throwaway users.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { memoryStore } from '../src/kv'
import { createProfileSync, type RpcClient, supabaseSyncTransport } from '../src/sync/index'

const url = process.env.SLICERX_SUPABASE_URL ?? process.env.API_URL ?? ''
const anonKey = process.env.SLICERX_SUPABASE_ANON_KEY ?? process.env.ANON_KEY ?? ''
const serviceKey = process.env.SERVICE_ROLE_KEY ?? ''
const local = /^http:\/\/(127\.0\.0\.1|localhost|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+):\d+$/.test(url)

interface TestUser {
  id: string
  jwt: string
}
const users: TestUser[] = []

async function makeUser(tag: string): Promise<TestUser> {
  const email = `sync-${tag}-${process.pid}@example.com`
  const password = `pw-${crypto.randomUUID()}`
  const admin = { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' }
  const created = (await (
    await fetch(`${url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ email, password, email_confirm: true }),
    })
  ).json()) as { id: string }
  const session = (await (
    await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
  ).json()) as { access_token: string }
  const u = { id: created.id, jwt: session.access_token }
  users.push(u)
  return u
}

/** A minimal RpcClient over PostgREST, standing in for a signed-in supabase-js client. */
function rpcAs(u: TestUser): RpcClient {
  return {
    async rpc(fn, args) {
      const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: anonKey, authorization: `Bearer ${u.jwt}`, 'content-type': 'application/json' },
        body: JSON.stringify(args),
      })
      const body: unknown = await res.json()
      if (!res.ok) {
        const e = body as { message?: string; code?: string }
        return { data: null, error: { message: e.message ?? 'error', code: e.code ?? 'unknown' } }
      }
      return { data: body, error: null }
    },
  }
}

describe.skipIf(!local || !anonKey || !serviceKey)('profile sync on the stack', () => {
  let rv: TestUser
  let ash: TestUser

  beforeAll(async () => {
    rv = await makeUser('rv')
    ash = await makeUser('ash')
  })

  afterAll(async () => {
    for (const u of users) {
      await fetch(`${url}/auth/v1/admin/users/${u.id}`, {
        method: 'DELETE',
        headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
      })
    }
  })

  it('syncs, merges and isolates accounts through the database functions', async () => {
    const make = (u: TestUser) =>
      createProfileSync({ transport: supabaseSyncTransport(rpcAs(u)), store: memoryStore(), userId: u.id })
    const phone = make(rv)
    const desk = make(rv)
    const saved = await phone.save('profile', {
      kind: 'process',
      name: '0.20 mm Standard',
      settings: { layer_height: 0.2, wall_loops: 2 },
    })
    if (!saved.ok) throw new Error(saved.message)
    const first = await phone.sync()
    expect(first.ok && first.value.pushed).toBe(1)

    const pulled = await desk.sync()
    expect(pulled.ok).toBe(true)
    expect(desk.get('profile', saved.value.id)?.settings).toEqual({ layer_height: 0.2, wall_loops: 2 })

    await phone.save('profile', { id: saved.value.id, kind: 'process', name: '0.20 mm Standard', settings: { layer_height: 0.16, wall_loops: 2 } })
    await desk.save('profile', { id: saved.value.id, kind: 'process', name: '0.20 mm Standard', settings: { layer_height: 0.2, wall_loops: 3 } })
    expect((await phone.sync()).ok).toBe(true)
    const merged = await desk.sync()
    expect(merged.ok && merged.value.merged).toBe(1)
    await phone.sync()
    expect(phone.get('profile', saved.value.id)?.settings).toEqual({ layer_height: 0.16, wall_loops: 3 })

    const printer = await phone.save('printer', { name: 'Bay 3', settings: { host: '192.168.1.20' } })
    expect(printer.ok).toBe(false)

    const other = make(ash)
    expect((await other.sync()).ok).toBe(true)
    expect(other.list('profile')).toEqual([])
  })
})
