// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A signed-in member's download against a stand-in for the Supabase client: the newest .sx3mf (their own listing in any
// format), counted only once the link is made, and the card shows the version the download hands out.
import { describe, expect, it } from 'vitest'
import type { Db } from './auth/supabase'
import { supabaseStore } from './supabase'

const ME = '00000000-0000-4000-8000-0000000000aa'
const MINE = '00000000-0000-4000-8000-0000000000c1'
const THEIRS = '00000000-0000-4000-8000-0000000000c2'
const LISTING = '00000000-0000-4000-8000-0000000000b1'
const at = '2026-10-01T00:00:00Z'

const listing = (creator: string) => ({ id: LISTING, creator_id: creator, slug: 'cube', title: 'Cube', description: null, license: 'cc-by', status: 'approved', tags: [], cover_url: null, review_note: null, reviewed_by: null, reviewed_at: null, published_at: at, created_at: at })
const version = (n: number, v: string, file: string) => ({
  id: `00000000-0000-4000-8000-00000000010${n}`,
  listing_id: LISTING,
  version: v,
  changelog: null,
  storage_path: `${LISTING}/v${n}/${file}`,
  sha256: 'a'.repeat(64),
  format: file.split('.').pop(),
  size_bytes: 10,
  scan_status: 'clean',
  scanned_at: at,
  review_status: 'approved',
  created_at: at,
})
const creator = { id: MINE, owner_id: ME, handle: 'me', display_name: 'Me', tagline: null, bio: null, location: null, logo_url: null, status: 'active', trusted: false, created_at: at }
const other = { ...creator, id: THEIRS, owner_id: '00000000-0000-4000-8000-0000000000bb', handle: 'them', display_name: 'Them' }

interface Fake {
  db: Db
  counted: string[]
  signed: string[]
}

/** Answers each table with its rows, filtered by eq and in. */
function fake(tables: Record<string, Record<string, unknown>[]>, opts: { signError?: string; noColors?: boolean } = {}): Fake & { refused: number } {
  const counted: string[] = []
  const signed: string[] = []
  let refused = 0
  const query = (table: string) => {
    let out = tables[table] ?? []
    let error: { code: string; message: string } | null = null
    const q = {
      select: (cols = '*') => {
        // A project without 0016_listing_colors.
        if (opts.noColors && table === 'listing_versions' && cols.includes('colors')) {
          refused++
          error = { code: '42703', message: 'column listing_versions.colors does not exist' }
        }
        return q
      },
      eq: (k: string, v: unknown) => ((out = out.filter((r) => r[k] === v)), q),
      in: (k: string, v: unknown[]) => ((out = out.filter((r) => v.includes(r[k]))), q),
      order: () => q,
      then: (res: (r: { data: unknown; error: unknown }) => unknown) => Promise.resolve(error ? { data: null, error } : { data: out, error: null }).then(res),
    }
    return q
  }
  const db = {
    auth: { getSession: async () => ({ data: { session: { user: { id: ME } } } }) },
    from: query,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'record_download') counted.push(String(args['p_listing']))
      if (fn === 'listing_stats' || fn === 'saved_listings') return { data: [], error: null }
      if (fn === 'trending_listings') return { data: [{ listing_id: LISTING, score: 9 }], error: null }
      return { data: null, error: null }
    },
    storage: {
      from: () => ({
        createSignedUrl: async (path: string) => {
          if (opts.signError) return { data: null, error: { message: opts.signError } }
          signed.push(path)
          return { data: { signedUrl: `https://files.test/${path}` }, error: null }
        },
      }),
    },
  } as unknown as Db
  return {
    db,
    counted,
    signed,
    get refused() {
      return refused
    },
  }
}

const versions = [version(1, '1.0.0', 'cube.sx3mf'), version(2, '1.1.0', 'cube.stl')]

describe('a member download', () => {
  it("hands out the newest .sx3mf of someone else's listing, and counts it", async () => {
    const f = fake({ listings: [listing(THEIRS)], listing_versions: versions, creators: [creator] })
    const r = await supabaseStore(f.db).download(LISTING)
    expect(r).toMatchObject({ ok: true, value: { version: '1.0.0', fileName: 'cube.sx3mf' } })
    expect(f.counted).toEqual([LISTING])
  })

  it('hands a creator the newest version of their own listing in any format', async () => {
    const f = fake({ listings: [listing(MINE)], listing_versions: versions, creators: [creator] })
    expect(await supabaseStore(f.db).download(LISTING)).toMatchObject({ ok: true, value: { version: '1.1.0', fileName: 'cube.stl' } })
  })

  it('counts nothing when there is no .sx3mf or the link cannot be made', async () => {
    const none = fake({ listings: [listing(THEIRS)], listing_versions: [version(2, '1.1.0', 'cube.stl')], creators: [creator] })
    expect(await supabaseStore(none.db).download(LISTING)).toMatchObject({ ok: false, code: 'not_found' })
    expect(none.signed).toEqual([])
    expect(none.counted).toEqual([])
    const broken = fake({ listings: [listing(THEIRS)], listing_versions: versions, creators: [creator] }, { signError: 'Object not found' })
    expect(await supabaseStore(broken.db).download(LISTING)).toMatchObject({ ok: false, code: 'unavailable', message: expect.stringMatching(/Object not found/) })
    expect(broken.counted).toEqual([])
  })

  it('shows on the card the version a download hands out', async () => {
    const theirs = fake({ listings: [listing(THEIRS)], listing_versions: versions, creators: [creator, other], print_profiles: [], likes: [] })
    expect((await supabaseStore(theirs.db).getListing(LISTING))?.listing.currentVersion).toMatchObject({ version: '1.0.0', format: 'sx3mf' })
    const mine = fake({ listings: [listing(MINE)], listing_versions: versions, creators: [creator, other], print_profiles: [], likes: [] })
    expect((await supabaseStore(mine.db).getListing(LISTING))?.listing.currentVersion).toMatchObject({ version: '1.1.0', format: 'stl' })
  })

  it('keeps the print time and filament on a featured card when a newer non-.sx3mf version has none', async () => {
    const profile = { id: '00000000-0000-4000-8000-000000000201', version_id: version(1, '1.0.0', 'cube.sx3mf').id, printer_model: 'Bambu Lab P1S', process: '0.20 mm Standard', filament: 'Generic PLA', layer_height_mm: 0.2, nozzle_mm: 0.4, time_s: 7320, grams: 94, plates: 1, notes: null }
    const f = fake({ listings: [listing(THEIRS)], listing_versions: [version(1, '1.0.0', 'cube.sx3mf'), version(9, '99.0.0', 'cube.stl')], creators: [creator, other], print_profiles: [profile], likes: [] })
    const [card] = await supabaseStore(f.db).trending({ days: 7, limit: 1 })
    expect(card?.listing.currentVersion?.version).toBe('1.0.0')
    expect(card?.listing.currentVersion?.printProfiles?.['Bambu Lab P1S']).toMatchObject({ timeS: 7320, grams: 94 })
  })
})

describe('listing colors', () => {
  const colors = { colors: [{ hex: '#d4af37', name: 'Silk gold' }, { hex: '#1c1c1e' }], parts: [{ name: 'Body', colors: [0, 1], ams: true }] }
  const tables = (c: unknown) => ({ listings: [listing(THEIRS)], listing_versions: [{ ...version(1, '1.0.0', 'cube.sx3mf'), colors: c }], creators: [creator, other], print_profiles: [], likes: [] })

  it('reads them with the version, and drops a stored shape that does not check out', async () => {
    expect((await supabaseStore(fake(tables(colors)).db).getListing(LISTING))?.listing.currentVersion?.colors).toEqual(colors)
    expect((await supabaseStore(fake(tables({ colors: [{ hex: 'gold' }], parts: [] })).db).getListing(LISTING))?.listing.currentVersion?.colors).toBeUndefined()
  })

  it('still reads listings on a project without the column, and stops asking for it', async () => {
    const f = fake(tables(undefined), { noColors: true })
    const store = supabaseStore(f.db)
    expect((await store.getListing(LISTING))?.listing.currentVersion).toMatchObject({ version: '1.0.0' })
    const asked = f.refused
    expect((await store.getListing(LISTING))?.listing.currentVersion?.colors).toBeUndefined()
    expect(f.refused).toBe(asked)
  })

  it('checks colors before writing them', async () => {
    const r = await supabaseStore(fake(tables(colors)).db).setVersionColors(version(1, '1.0.0', 'cube.sx3mf').id, { colors: [{ hex: '#000000' }], parts: [{ name: 'Body', colors: [3], ams: false }] })
    expect(r).toMatchObject({ ok: false, code: 'invalid' })
  })
})
