// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Vault's grid and rows read approved listings from library_listings, which leaves out QA accounts' uploads, against
// a stand-in for the Supabase client. A project without the view still lists from the listings table.
import { describe, expect, it } from 'vitest'
import type { Db } from './auth/supabase'
import { supabaseStore } from './supabase'

const CREATOR = '00000000-0000-4000-8000-0000000000c1'
const QA_CREATOR = '00000000-0000-4000-8000-0000000000c2'
const REAL = '00000000-0000-4000-8000-0000000000b1'
const QA = '00000000-0000-4000-8000-0000000000b2'
const at = '2026-10-01T00:00:00Z'

const listing = (id: string, creator: string, status = 'approved') => ({ id, creator_id: creator, slug: id.slice(-4), title: 'Cube', description: null, license: 'cc-by', status, tags: [], cover_url: null, review_note: null, reviewed_by: null, reviewed_at: null, published_at: at, created_at: at })
const creator = (id: string, handle: string) => ({ id, owner_id: id, handle, display_name: handle, tagline: null, bio: null, location: null, logo_url: null, status: 'active', trusted: false, created_at: at })

/** Answers each relation with its rows, filtered by eq and in; records which relations were read. */
function fake(opts: { noView?: boolean } = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    listings: [listing(REAL, CREATOR), listing(QA, QA_CREATOR), listing('00000000-0000-4000-8000-0000000000b3', CREATOR, 'pending')],
    library_listings: [listing(REAL, CREATOR), listing('00000000-0000-4000-8000-0000000000b3', CREATOR, 'pending')],
    creators: [creator(CREATOR, 'real'), creator(QA_CREATOR, 'qa')],
    listing_versions: [],
    print_profiles: [],
  }
  const asked: string[] = []
  const query = (table: string) => {
    asked.push(table)
    let out = tables[table] ?? []
    const error = opts.noView && table === 'library_listings' ? { code: 'PGRST205', message: "Could not find the table 'public.library_listings' in the schema cache" } : null
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => ((out = out.filter((r) => r[k] === v)), q),
      in: (k: string, v: unknown[]) => ((out = out.filter((r) => v.includes(r[k]))), q),
      contains: () => q,
      or: () => q,
      order: () => q,
      range: (a: number, b: number) => ((out = out.slice(a, b + 1)), q),
      then: (res: (r: { data: unknown; error: unknown }) => unknown) => Promise.resolve(error ? { data: null, error } : { data: out, error: null }).then(res),
    }
    return q
  }
  const db = {
    auth: { getSession: async () => ({ data: { session: null } }) },
    from: query,
    rpc: async () => ({ data: [], error: null }),
  } as unknown as Db
  return { db, asked }
}

const ids = (items: { listing: { id: string } }[]) => items.map((c) => c.listing.id)

describe('the Feed', () => {
  it('lists approved designs without QA accounts\' uploads, newest and most popular', async () => {
    const f = fake()
    const store = supabaseStore(f.db)
    expect(ids((await store.listListings()).items)).toEqual([REAL])
    expect(ids((await store.listListings({ sort: 'popular' })).items)).toEqual([REAL])
    expect(ids((await store.feed()).items)).toEqual([REAL])
    expect(f.asked).not.toContain('listings')
  })

  it('reads other statuses from the listings table', async () => {
    const f = fake()
    await supabaseStore(f.db).listListings({ status: 'pending' })
    expect(f.asked).toContain('listings')
    expect(f.asked).not.toContain('library_listings')
  })

  it('still lists on a project without the view, and stops asking for it', async () => {
    const f = fake({ noView: true })
    const store = supabaseStore(f.db)
    expect(ids((await store.listListings()).items)).toEqual([REAL, QA])
    expect(f.asked.filter((t) => t === 'library_listings')).toHaveLength(1)
    await store.listListings()
    expect(f.asked.filter((t) => t === 'library_listings')).toHaveLength(1)
  })
})
