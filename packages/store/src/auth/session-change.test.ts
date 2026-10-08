// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Session changes over Supabase: each event reads the profile before it is reported, and those reads can finish
// out of order. The newest event must win.
import type { Session as SbSession } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { supabaseAuth, type Db } from './supabase'

type Listener = (event: string, s: SbSession | null) => void

const U1 = '00000000-0000-4000-8000-000000000001'
const U2 = '00000000-0000-4000-8000-000000000002'
const sbSession = (id: string) => ({ access_token: `a-${id}`, refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id, email: 'qa@example.com' } }) as unknown as SbSession
const profile = (id: string) => ({ id, handle: 'qa', display_name: 'QA', avatar_url: null, role: 'member', banned_at: null, ban_reason: null })

/** A client whose auth events the test sends, and whose profile reads wait until the test lets each one through. */
function fake() {
  let listener: Listener | null = null
  const waiting = new Map<string, () => void>()
  const query = (table: string) => {
    let id = ''
    const q = {
      select: () => q,
      eq: (_k: string, v: string) => ((id = v), q),
      then: (res: (r: { data: unknown; error: unknown }) => unknown) => {
        if (table !== 'profiles') return Promise.resolve({ data: [], error: null }).then(res)
        return new Promise<void>((r) => waiting.set(id, r)).then(() => res({ data: [profile(id)], error: null }))
      },
    }
    return q
  }
  const db = {
    auth: {
      onAuthStateChange: (cb: Listener) => {
        listener = cb
        return { data: { subscription: { unsubscribe: () => (listener = null) } } }
      },
    },
    from: query,
  } as unknown as Db
  return { db, emit: (event: string, s: SbSession | null) => listener?.(event, s), finish: (id: string) => waiting.get(id)?.() }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('session changes', () => {
  it('drops a signed-in event whose profile read finishes after a later sign-out', async () => {
    const f = fake()
    const seen: (string | null)[] = []
    const off = supabaseAuth(f.db, { url: 'http://x', anonKey: 'k' }).onSessionChange((s) => seen.push(s?.userId ?? null))
    f.emit('SIGNED_IN', sbSession(U1))
    await tick()
    f.emit('SIGNED_OUT', null)
    await tick()
    expect(seen).toEqual([null])
    // The first event's read lands last.
    f.finish(U1)
    await tick()
    expect(seen).toEqual([null])
    off()
  })

  it('reports the later account when two sign-ins finish out of order', async () => {
    const f = fake()
    const seen: (string | null)[] = []
    supabaseAuth(f.db, { url: 'http://x', anonKey: 'k' }).onSessionChange((s) => seen.push(s?.userId ?? null))
    f.emit('SIGNED_IN', sbSession(U1))
    f.emit('SIGNED_IN', sbSession(U2))
    await tick()
    f.finish(U2)
    await tick()
    f.finish(U1)
    await tick()
    expect(seen).toEqual([U2])
  })
})
