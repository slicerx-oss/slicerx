// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bundledSeed } from './offline-seed'
import { SEED_TABLES, type SeedTable } from './rows'
import { generateSeed, seedId } from './seed/generate'
import { renderSeedJson } from './seed/json'
import { renderSeedSql } from './seed/sql'
import { validateCreatorLink } from './validate'

const here = dirname(fileURLToPath(import.meta.url))
const seed = generateSeed()

const count = <T>(rows: readonly T[], f: (r: T) => boolean) => rows.filter(f).length

describe('seed', () => {
  it('is deterministic', () => {
    expect(generateSeed()).toEqual(seed)
    expect(seedId('x')).toBe(seedId('x'))
    expect(seedId('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('matches the committed JSON and SQL seed files (run seed:write after changing the generator)', () => {
    for (const [name, text] of Object.entries(renderSeedJson(seed))) {
      expect(readFileSync(join(here, '..', 'seed', name), 'utf8'), name).toBe(text)
    }
    for (const [name, text] of Object.entries(renderSeedSql(seed))) {
      expect(readFileSync(join(here, '..', '..', '..', 'supabase', 'seed', name), 'utf8'), name).toBe(text)
    }
  })

  it('parses against the row schemas, bundled copy included', () => {
    const bundled = bundledSeed()
    for (const table of Object.keys(SEED_TABLES) as SeedTable[]) {
      const schema = SEED_TABLES[table]
      for (const row of bundled[table]) expect(() => schema.parse(row), table).not.toThrow()
    }
    expect(bundled).toEqual(seed)
  })

  it('has the goal counts', () => {
    expect(count(seed.profiles, (p) => p.role === 'owner')).toBe(1)
    expect(count(seed.profiles, (p) => p.role === 'moderator')).toBe(1)
    expect(count(seed.profiles, (p) => p.role === 'creator')).toBe(5)
    expect(count(seed.profiles, (p) => p.role === 'member')).toBe(13)
    expect(count(seed.profiles, (p) => p.banned_at !== null)).toBe(1)
    expect(seed.creators).toHaveLength(5)
    expect(seed.listings).toHaveLength(26)
    for (const [status, n] of [['approved', 20], ['pending', 3], ['rejected', 1], ['archived', 1], ['removed', 1]] as const) {
      expect(count(seed.listings, (l) => l.status === status), status).toBe(n)
    }
    expect(seed.library_settings).toEqual([{ id: true, moderation_mode: 'owner-approves-all', max_file_mb: 100, allowed_formats: ['3mf', 'sx3mf', 'stl'] }])
    expect(seed.creators.filter((c) => c.location !== null).length).toBeGreaterThanOrEqual(3)
    expect(seed.audit_log.length).toBeGreaterThanOrEqual(5)
  })

  it('uses unique ids, slugs and handles', () => {
    // users and profiles share ids by design (one profile per auth user).
    const ids = (Object.keys(seed) as SeedTable[])
      .filter((t) => t !== 'users' && t !== 'audit_log' && t !== 'library_settings')
      .flatMap((t) => (seed[t] as readonly object[]).flatMap((r) => ('id' in r && typeof r.id === 'string' ? [r.id] : [])))
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(seed.listings.map((l) => l.slug)).size).toBe(26)
    expect(new Set(seed.profiles.map((p) => p.handle)).size).toBe(seed.profiles.length)
    expect(new Set(seed.creators.map((c) => c.handle)).size).toBe(5)
  })

  it('follows the database rules', () => {
    const profileIds = new Set(seed.profiles.map((p) => p.id))
    const listingById = new Map(seed.listings.map((l) => [l.id, l]))
    const creatorById = new Map(seed.creators.map((c) => [c.id, c]))
    // One creator page per member, owned by a creator.
    expect(new Set(seed.creators.map((c) => c.owner_id)).size).toBe(seed.creators.length)
    for (const c of seed.creators) {
      expect(seed.profiles.find((p) => p.id === c.owner_id)?.role).toBe('creator')
      expect(c.logo_url).toMatch(/^https:\/\/example\.com\//)
      expect(c.handle).toMatch(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/)
    }
    for (const p of seed.profiles) expect((p.banned_at === null) === (p.ban_reason === null), p.handle).toBe(true)
    for (const l of seed.listings) {
      expect(l.slug).toMatch(/^[a-z0-9][a-z0-9-]{1,80}$/)
      expect(creatorById.has(l.creator_id)).toBe(true)
      if (l.status === 'approved') expect(l.published_at, l.slug).not.toBeNull()
      if (l.status === 'rejected' || l.status === 'removed') expect(l.review_note, l.slug).toBeTruthy()
      expect(l.cover_url).toBeNull()
    }
    for (const v of seed.listing_versions) {
      expect(v.storage_path).toBe(`${v.listing_id}/${v.id}/${v.storage_path.split('/')[2]}`)
      expect(v.storage_path).toMatch(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[^/\\]{1,200}\.(3mf|sx3mf|stl)$/)
      expect(v.storage_path.endsWith(`.${v.format}`)).toBe(true)
      expect(Number(v.size_bytes)).toBeGreaterThan(0)
      expect(Number(v.size_bytes)).toBeLessThanOrEqual(104_857_600)
      expect(v.scan_status).toBe('clean')
      expect(v.scanned_at).not.toBeNull()
      const status = listingById.get(v.listing_id)?.status
      expect(v.review_status).toBe(status === 'pending' ? 'pending' : status === 'rejected' ? 'rejected' : 'approved')
    }
    // Every listing has a version, and every version a model file with the same name.
    for (const l of seed.listings) expect(count(seed.listing_versions, (v) => v.listing_id === l.id), l.slug).toBeGreaterThan(0)
    for (const v of seed.listing_versions) {
      expect(seed.listing_files.find((f) => f.version_id === v.id && f.role === 'model')?.name).toBe(v.storage_path.split('/')[2])
    }
    // Featured: at most 6, own approved listings, positions 1..n.
    for (const c of seed.creators) {
      const f = seed.creator_featured.filter((x) => x.creator_id === c.id).sort((a, b) => a.position - b.position)
      expect(f.length).toBeLessThanOrEqual(6)
      expect(f.map((x) => x.position)).toEqual(f.map((_, i) => i + 1))
      for (const x of f) {
        const l = listingById.get(x.listing_id)
        expect(l?.creator_id).toBe(c.id)
        expect(l?.status).toBe('approved')
      }
      expect(seed.creator_links.filter((k) => k.creator_id === c.id).length).toBeLessThanOrEqual(12)
    }
    // Links pass the same check the client runs before saving.
    for (const k of seed.creator_links) expect(validateCreatorLink({ kind: k.kind, url: k.url, ...(k.label ? { label: k.label } : {}) }), k.url).toMatchObject({ ok: true })
    // Members only interact with listings anyone could see.
    const publicIds = new Set(seed.listings.filter((l) => l.status === 'approved').map((l) => l.id))
    for (const r of [...seed.likes, ...seed.comments, ...seed.makes, ...seed.collection_items]) expect(publicIds.has(r.listing_id)).toBe(true)
    for (const r of [...seed.likes, ...seed.follows, ...seed.downloads, ...seed.makes]) expect(profileIds.has(r.user_id)).toBe(true)
    for (const d of seed.downloads) expect(listingById.get(d.listing_id)?.published_at).not.toBeNull()
    // The banned member did nothing after the ban.
    expect(seed.likes.some((l) => seed.profiles.find((p) => p.id === l.user_id)?.banned_at)).toBe(false)
    // Audit rows are in time order with consecutive ids.
    seed.audit_log.forEach((a, i) => expect(a.id).toBe(i + 1))
    expect(seed.audit_log.map((a) => a.at)).toEqual([...seed.audit_log.map((a) => a.at)].sort())
  })

  it('orders SQL by foreign keys and sets roles before creator pages', () => {
    const sql = renderSeedSql(seed)
    expect(Object.keys(sql).sort()).toEqual(['auth.sql', 'store.sql'])
    const auth = sql['auth.sql'] ?? ''
    expect(auth.indexOf('insert into auth.users')).toBeLessThan(auth.indexOf("update public.profiles set role = 'owner'"))
    expect(auth).toContain("banned_until = 'infinity'")
    expect(auth).not.toContain('insert into public.profiles')
    const store = sql['store.sql'] ?? ''
    const order = ['creators', 'creator_links', 'follows', 'listings', 'listing_versions', 'listing_files', 'print_profiles', 'creator_featured', 'likes', 'comments', 'makes', 'collections', 'collection_items', 'downloads', 'audit_log']
    const at = order.map((t) => store.indexOf(`insert into public.${t} `))
    expect(at.every((n) => n >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // audit_log.id is an identity column and is left to the database.
    expect(store).toContain('insert into public.audit_log (at, actor_id')
    expect(store).toContain("update public.library_settings set moderation_mode = 'owner-approves-all'")
    expect(store).not.toContain('drops')
    expect(store).not.toMatch(/insert into public\.(print_events|pool_periods|print_pool_ledger|subscriptions|licenses|boosts|tiers)\b/)
  })

  it('uses only fictional example accounts', () => {
    for (const u of seed.users) expect(u.email.endsWith('@example.com')).toBe(true)
    const text = JSON.stringify(seed)
    expect(text).not.toMatch(new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']'))
    // Neutral example models only; no bundled design assets.
    expect(text).not.toMatch(/design\/assets/i)
  })
})
