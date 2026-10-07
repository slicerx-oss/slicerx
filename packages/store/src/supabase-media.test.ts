// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Creator images against a stand-in for the Supabase client: banners, logos and covers only from this project's
// creator-media bucket, bios up to 500 characters, and an unused upload removed from the member's own folder only.
import { describe, expect, it } from 'vitest'
import type { Db } from './auth/supabase'
import { supabaseStore } from './supabase'

const ME = '00000000-0000-4000-8000-0000000000aa'
const URL_BASE = 'http://127.0.0.1:55471'
const MEDIA = `${URL_BASE}/storage/v1/object/public/creator-media/`
const at = '2026-10-01T00:00:00Z'
const creator = { id: '00000000-0000-4000-8000-0000000000c1', owner_id: ME, handle: 'me', display_name: 'Me', tagline: null, bio: null, location: null, logo_url: `${MEDIA}${ME}/logo-1.png`, status: 'active', trusted: false, created_at: at }

function fake() {
  const writes: unknown[] = []
  const removed: string[][] = []
  const query = (table: string) => {
    let out: Record<string, unknown>[] = table === 'creators' ? [creator] : []
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => ((out = out.filter((r) => r[k] === v)), q),
      in: () => q,
      update: (row: unknown) => (writes.push(row), q),
      insert: (row: unknown) => (writes.push(row), q),
      single: () => Promise.resolve({ data: out[0] ?? null, error: null }),
      then: (res: (r: { data: unknown; error: null }) => unknown) => Promise.resolve({ data: out, error: null }).then(res),
    }
    return q
  }
  const db = {
    auth: { getSession: async () => ({ data: { session: { user: { id: ME } } } }) },
    from: query,
    rpc: async () => ({ data: [], error: null }),
    storage: { from: () => ({ remove: async (paths: string[]) => (removed.push(paths), { error: null }), list: async () => ({ data: [], error: null }) }) },
  } as unknown as Db
  return { store: supabaseStore(db, { url: URL_BASE, anonKey: 'anon' }), writes, removed }
}

describe('creator images', () => {
  it('takes a banner or logo only from the creator-media bucket', async () => {
    const { store, writes } = fake()
    for (const bannerUrl of ['https://cdn.example.com/b.png', 'http://evil.example.com/storage/v1/object/public/creator-media/x.png', 'javascript:alert(1)']) {
      expect(await store.saveCreator({ handle: 'mine', displayName: 'Me', bannerUrl })).toMatchObject({ ok: false, message: 'Upload the banner to your creator page first' })
    }
    expect(await store.saveCreator({ handle: 'mine', displayName: 'Me', logoUrl: 'https://cdn.example.com/l.png' })).toMatchObject({ ok: false, message: 'Upload the logo to your creator page first' })
    expect(writes).toEqual([])
    await store.saveCreator({ handle: 'mine', displayName: 'Me', bannerUrl: `${MEDIA}${ME}/banner-1.webp` })
    expect(writes).toHaveLength(1)
  })

  it('takes a cover only from the creator-media bucket', async () => {
    const { store } = fake()
    expect(await store.updateListing('00000000-0000-4000-8000-0000000000b1', { coverUrl: 'https://cdn.example.com/c.png' })).toMatchObject({ ok: false, message: 'Upload the cover to your creator page first' })
  })

  it('takes a bio of up to 500 characters', async () => {
    const { store, writes } = fake()
    expect(await store.saveCreator({ handle: 'mine', displayName: 'Me', bio: 'b'.repeat(501) })).toMatchObject({ ok: false, message: 'Bios can be at most 500 characters' })
    expect(writes).toEqual([])
  })

  it("removes an unused upload from the member's own folder, and nothing else", async () => {
    const { store, removed } = fake()
    expect(await store.removeCreatorImage(`${MEDIA}${ME}/banner-2.webp`)).toMatchObject({ ok: true })
    expect(removed).toEqual([[`${ME}/banner-2.webp`]])
    // The logo the page shows stays.
    expect(await store.removeCreatorImage(`${MEDIA}${ME}/logo-1.png`)).toMatchObject({ ok: true })
    for (const url of [`${MEDIA}00000000-0000-4000-8000-0000000000bb/x.png`, `${MEDIA}${ME}/../x.png`, 'https://cdn.example.com/x.png']) {
      expect(await store.removeCreatorImage(url)).toMatchObject({ ok: false })
    }
    expect(removed).toHaveLength(1)
  })
})
