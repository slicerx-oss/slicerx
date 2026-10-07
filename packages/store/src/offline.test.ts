// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { StoreClient, StoreResult } from '@slicerx/contracts'
import { isAuthCallback } from './auth/callbacks'
import { createAuth, createStore } from './index'
import { generateSeed, seedId } from './seed/generate'

const fixed = () => new Date('2026-09-30T20:00:00Z')
let counter = 0
const newId = () => seedId(`test:${counter++}`)
const store = (signedInAs: string | null = 'rv') => createStore({ offline: true, signedInAs, now: fixed, newId, seed: generateSeed() })

const zip = (n = 64) => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array<number>(n).fill(7)])
const listing = (slug: string) => seedId(`listing:${slug}`)
const user = (handle: string) => seedId(`user:${handle}`)
const value = <T>(r: StoreResult<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`)
  return r.value
}
const fails = (r: StoreResult<unknown>, code: string, message?: string) => {
  expect(r).toMatchObject({ ok: false, code, ...(message ? { message } : {}) })
}

/** Switches the demo sign-in to another seeded user. */
async function as(s: StoreClient, handle: string) {
  value(await s.signInWithEmail(`${handle}@example.com`))
}

/** A new listing with one clean version, waiting for review. */
async function submit(s: StoreClient, title: string) {
  const l = value(await s.createListing({ title, tags: ['test'] }))
  const v = value(await s.uploadVersion(l.id, { name: 'model.3mf', version: '1.0.0', bytes: zip(), format: '3mf' }))
  return { l, v }
}

describe('offline store: reading', () => {
  it('starts signed in as the demo member', async () => {
    const s = await store().session()
    expect(s).toMatchObject({ handle: 'rv', displayName: 'RV', role: 'member' })
    expect(s?.creatorId).toBeUndefined()
  })

  it('signs in as each kind of demo user', async () => {
    expect((await store('owner').session())?.role).toBe('owner')
    expect((await store('moderator').session())?.role).toBe('moderator')
    const creator = await store('marrow').session()
    expect(creator?.role).toBe('creator')
    expect(creator?.creatorId).toBe(seedId('creator:marrow-works'))
  })

  it('pages the feed of approved listings, newest first', async () => {
    const s = store()
    const first = await s.feed({ limit: 12 })
    expect(first.items).toHaveLength(12)
    expect(first.next).toBe('12')
    const rest = await s.feed({ limit: 20, cursor: first.next ?? '' })
    expect(rest.items).toHaveLength(8)
    expect(rest.next).toBeUndefined()
    const all = [...first.items, ...rest.items]
    expect(all.every((i) => i.listing.status === 'approved')).toBe(true)
    const times = all.map((i) => i.listing.publishedAt ?? '')
    expect([...times].sort().reverse()).toEqual(times)
    expect(all.some((i) => i.reason === 'following')).toBe(true)
  })

  it('lists approved listings only, for everyone', async () => {
    for (const who of [null, 'rv', 'kestrel']) {
      const { items } = await store(who).listListings({ limit: 100 })
      expect(items, String(who)).toHaveLength(20)
      expect(items.every((i) => i.listing.status === 'approved')).toBe(true)
    }
  })

  it('filters by tag, query and creator, and sorts by popularity', async () => {
    const s = store()
    const tag = await s.listListings({ tag: 'tabletop' })
    expect(tag.items.length).toBeGreaterThan(0)
    expect(tag.items.every((i) => i.listing.tags.includes('tabletop'))).toBe(true)
    expect((await s.listListings({ query: 'gearbox' })).items.map((i) => i.listing.slug)).toEqual(['planetary-gearbox-demo'])
    const ferro = await s.listListings({ creatorId: seedId('creator:ferro-labs') })
    expect(ferro.items).toHaveLength(4)
    const popular = await s.listListings({ sort: 'popular', limit: 100 })
    const score = (i: (typeof popular.items)[number]) => (i.listing.stats?.likes ?? 0) + (i.listing.stats?.downloads ?? 0)
    const scores = popular.items.map(score)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
  })

  it('shows unapproved listings only to their creator and to staff', async () => {
    const pending = listing('trilobite-coaster-set')
    expect(await store('rv').getListing(pending)).toBeNull()
    expect(await store(null).getListing('trilobite-coaster-set')).toBeNull()
    expect(await store('kestrel').getListing(pending)).toBeNull()
    expect((await store('marrow').getListing(pending))?.listing.status).toBe('pending')
    expect((await store('moderator').getListing('trilobite-coaster-set'))?.listing.status).toBe('pending')
    for (const slug of ['wizard-tower-terrain', 'logo-keychain', 'gear-tooth-test-strip']) {
      expect(await store('rv').getListing(slug), slug).toBeNull()
    }
    const rejected = await store('oddfellow').getListing('wizard-tower-terrain')
    expect(rejected?.listing.reviewNote).toContain('commercial game')
    expect((await store('oddfellow').getListing('logo-keychain'))?.listing.status).toBe('removed')
  })

  it('returns a listing by id or slug with its versions, newest first', async () => {
    const s = store()
    const bySlug = await s.getListing('spine-cable-organizer')
    const byId = await s.getListing(listing('spine-cable-organizer'))
    expect(byId?.listing.id).toBe(bySlug?.listing.id)
    expect(bySlug?.versions.map((v) => v.version)).toEqual(['1.2.0', '1.0.0'])
    expect(bySlug?.listing.currentVersion).toMatchObject({ version: '1.2.0', scanStatus: 'clean', reviewStatus: 'approved' })
    expect(bySlug?.listing.license).toBe('cc-by')
    expect(bySlug?.creator.handle).toBe('marrow-works')
  })

  it('serves a creator page with links, featured models in order and approved listings', async () => {
    const page = await store().getCreatorByHandle('ferro-labs')
    expect(page?.creator).toMatchObject({ handle: 'ferro-labs', displayName: 'Ferro Labs', trusted: false, listingCount: 4 })
    expect(page?.creator.followers).toBeGreaterThan(0)
    expect(page?.links.map((l) => l.kind)).toEqual(['website', 'github', 'makerworld'])
    expect(page?.featured.map((l) => l.slug)).toEqual(['planetary-gearbox-demo', 'parametric-enclosure', 'compliant-gripper'])
    expect(page?.listings).toHaveLength(4)
    expect(page?.listings.every((l) => l.status === 'approved')).toBe(true)
    expect(await store().getCreatorByHandle('nobody')).toBeNull()
  })

  it('lists the creator directory, largest following first', async () => {
    const dir = await store().listCreators()
    expect(dir).toHaveLength(5)
    const f = dir.map((c) => c.followers)
    expect([...f].sort((a, b) => b - a)).toEqual(f)
    expect(dir.every((c) => c.listingCount === 4)).toBe(true)
    expect((await store().listCreators({ query: 'kestrel' })).map((c) => c.handle)).toEqual(['kestrel-parts'])
  })

  it('lists only creators with an approved listing, unless staff or the creator', async () => {
    const s = store('cam')
    value(await s.saveCreator({ handle: 'cam-makes', displayName: 'Cam Makes', location: 'Lisbon, Portugal' }))
    expect((await s.listCreators()).map((c) => c.handle)).toContain('cam-makes')
    await as(s, 'rv')
    expect((await s.listCreators()).map((c) => c.handle)).not.toContain('cam-makes')
    await as(s, 'moderator')
    const staffView = (await s.listCreators()).find((c) => c.handle === 'cam-makes')
    expect(staffView).toMatchObject({ location: 'Lisbon, Portugal', listingCount: 0 })
    expect((await s.getCreatorByHandle('marrow-works'))?.creator.location).toBe('Rotterdam, Netherlands')
  })

  it('lists a creator their own listings in every status', async () => {
    const mine = await store('oddfellow').myListings()
    expect(mine).toHaveLength(6)
    expect(mine.map((l) => l.status).sort()).toEqual(['approved', 'approved', 'approved', 'approved', 'rejected', 'removed'])
    expect(await store('rv').myListings()).toEqual([])
    expect(await store(null).myListings()).toEqual([])
  })

  it('counts likes, makes, comments and downloads', async () => {
    const s = store()
    const id = listing('wave-dish')
    const stats = (await s.listingStats([id, listing('trilobite-coaster-set')]))[id]
    expect(stats?.downloads).toBeGreaterThan(0)
    expect(Object.keys(await s.listingStats([listing('trilobite-coaster-set')]))).toEqual([])
    expect(Object.keys(await store('marrow').listingStats([listing('trilobite-coaster-set')]))).toHaveLength(1)
  })

  it('reads the library settings, with the defaults', async () => {
    expect(await store(null).getLibrarySettings()).toEqual({ moderationMode: 'owner-approves-all', maxFileMb: 100, allowedFormats: ['3mf', 'sx3mf', 'stl'] })
  })

  it('does not share state between clients', async () => {
    const a = store()
    const b = store()
    const id = listing('wave-dish')
    await a.addComment(id, 'Only in client a')
    expect((await b.comments(id)).some((c) => c.body === 'Only in client a')).toBe(false)
  })
})

describe('offline store: member actions', () => {
  it('likes and unlikes, and likes twice without harm', async () => {
    const s = store()
    const { items } = await s.feed({ limit: 30 })
    const l = items.find((i) => !i.listing.likedByMe)?.listing
    if (!l) throw new Error('nothing to like')
    expect(await s.like(l.id)).toEqual({ ok: true, value: undefined })
    expect(await s.like(l.id)).toEqual({ ok: true, value: undefined })
    expect((await s.getListing(l.id))?.listing.likedByMe).toBe(true)
    expect((await s.getListing(l.id))?.listing.stats?.likes).toBe((l.stats?.likes ?? 0) + 1)
    await s.unlike(l.id)
    expect((await s.getListing(l.id))?.listing.likedByMe).toBe(false)
  })

  it('refuses writes when signed out', async () => {
    fails(await store(null).like(listing('wave-dish')), 'not_signed_in')
    fails(await store(null).addComment(listing('wave-dish'), 'hi'), 'not_signed_in')
    fails(await store(null).follow(seedId('creator:ferro-labs')), 'not_signed_in')
  })

  it('downloads approved files signed out, never private ones', async () => {
    const r = await store(null).download(listing('wave-dish'))
    expect(r.ok && r.value.fileName).toBe('wave-dish-1.0.0.3mf')
    fails(await store(null).download(listing('trilobite-coaster-set')), 'not_found')
    fails(await store(null).download(listing('wizard-tower-terrain')), 'not_found')
  })

  it('cannot like a listing it cannot see', async () => {
    fails(await store().like(listing('trilobite-coaster-set')), 'not_found')
  })

  it('adds, edits and deletes comments', async () => {
    const s = store()
    const id = listing('wave-dish')
    const c = value(await s.addComment(id, 'Printed it in PETG.'))
    const reply = value(await s.addComment(id, 'Same here.', c.id))
    expect(reply.parentId).toBe(c.id)
    fails(await s.addComment(id, '   '), 'invalid')
    fails(await s.addComment(id, 'x', seedId('nope')), 'invalid')
    const edited = value(await s.editComment(c.id, 'Printed it in PETG at 0.16 mm.'))
    expect(edited.editedAt).toBe('2026-09-30T20:00:00.000Z')
    fails(await store('ash').editComment(c.id, 'not mine'), 'not_found')
    expect(await s.deleteComment(c.id)).toEqual({ ok: true, value: undefined })
    expect((await s.comments(id)).some((x) => x.id === c.id)).toBe(false)
    fails(await s.editComment(c.id, 'after delete'), 'not_found')
  })

  it('lets staff delete any comment, and others not', async () => {
    const s = store()
    const id = listing('wave-dish')
    const c = value(await s.addComment(id, 'Off topic'))
    await as(s, 'ash')
    fails(await s.deleteComment(c.id), 'not_found')
    await as(s, 'moderator')
    expect((await s.deleteComment(c.id)).ok).toBe(true)
    expect((await s.comments(id)).some((x) => x.id === c.id)).toBe(false)
    expect(value(await s.auditLog({ limit: 1 }))[0]).toMatchObject({ action: 'delete_comment', targetKind: 'comment', targetId: c.id })
  })

  it('adds makes and checks the photo address', async () => {
    const s = store()
    const id = listing('wave-dish')
    const m = value(await s.addMake(id, { caption: 'Matte white', printerModel: 'Prusa MK4S' }))
    expect(m.author.handle).toBe('rv')
    fails(await s.addMake(id, { photoUrl: 'http://example.com/a.jpg' }), 'invalid')
    expect((await s.makes(id)).some((x) => x.id === m.id)).toBe(true)
  })

  it('manages collections', async () => {
    const s = store()
    const before = await s.collections()
    expect(before.map((c) => c.name).sort()).toEqual(['Desk upgrades', 'Tabletop night'])
    const c = value(await s.createCollection('Favorites', true))
    expect((await s.setInCollection(c.id, listing('wave-dish'), true)).ok).toBe(true)
    expect((await s.collections()).find((x) => x.id === c.id)?.listingIds).toEqual([listing('wave-dish')])
    await s.setInCollection(c.id, listing('wave-dish'), false)
    expect((await s.collections()).find((x) => x.id === c.id)?.listingIds).toEqual([])
    fails(await s.setInCollection(c.id, listing('trilobite-coaster-set'), true), 'not_found')
    fails(await s.createCollection(''), 'invalid')
  })

  it('follows and unfollows a creator', async () => {
    const s = store('kit')
    const id = seedId('creator:ferro-labs')
    const before = (await s.getCreatorByHandle('ferro-labs'))?.creator
    expect((await s.follow(id)).ok).toBe(true)
    expect((await s.follow(id)).ok).toBe(true)
    const after = (await s.getCreatorByHandle('ferro-labs'))?.creator
    expect(after?.followedByMe).toBe(true)
    expect(after?.followers).toBe((before?.followers ?? 0) + (before?.followedByMe ? 0 : 1))
    await s.unfollow(id)
    expect((await s.getCreatorByHandle('ferro-labs'))?.creator.followedByMe).toBe(false)
  })

  it('counts a download and returns a link to the newest approved version', async () => {
    const s = store('kit')
    const id = listing('spine-cable-organizer')
    const before = (await s.getListing(id))?.listing.stats?.downloads ?? 0
    const link = value(await s.download(id))
    expect(link).toMatchObject({ version: '1.2.0' })
    expect(link.url.startsWith('seed://listing-files/')).toBe(true)
    expect(link.fileName).toBe('spine-cable-organizer-1.2.0.3mf')
    expect((await s.getListing(id))?.listing.stats?.downloads).toBe(before + 1)
    fails(await s.download(listing('trilobite-coaster-set')), 'not_found')
    fails(await s.download(listing('logo-keychain')), 'not_found')
  })
})

describe('offline store: creator page', () => {
  it('lets a member make a creator page and become a creator', async () => {
    const s = store('cam')
    expect(await s.getMyCreator()).toBeNull()
    fails(await s.createListing({ title: 'Too soon' }), 'forbidden')
    const c = value(await s.saveCreator({ handle: 'cam-makes', displayName: 'Cam Makes', tagline: 'Desk things', logoUrl: 'https://example.com/cam.png' }))
    expect(c).toMatchObject({ handle: 'cam-makes', trusted: false, ownerId: user('cam'), status: 'active' })
    expect(await s.myRole()).toBe('creator')
    expect((await s.session())?.creatorId).toBe(c.id)
    const updated = value(await s.saveCreator({ handle: 'cam-makes', displayName: 'Cam Makes', bio: 'I print desk things.', tagline: null }))
    expect(updated.id).toBe(c.id)
    expect(updated.bio).toBe('I print desk things.')
    expect(updated.tagline).toBeUndefined()
    expect(await s.getMyCreator()).toMatchObject({ id: c.id })
  })

  it('checks handles', async () => {
    const s = store('cam')
    fails(await s.saveCreator({ handle: 'Cam', displayName: 'x' }), 'invalid')
    fails(await s.saveCreator({ handle: 'admin', displayName: 'x' }), 'invalid')
    fails(await s.saveCreator({ handle: 'ferro-labs', displayName: 'x' }), 'conflict')
    fails(await s.saveCreator({ handle: 'ok-handle', displayName: 'x', logoUrl: 'http://example.com/a.png' }), 'invalid')
  })

  it('replaces links after checking them like the database', async () => {
    const s = store('ferro')
    const links = value(
      await s.setCreatorLinks([
        { kind: 'github', url: 'https://github.com/ferrolabs', label: ' Code ' },
        { kind: 'website', url: 'https://ferro.example.com/about' },
      ]),
    )
    expect(links.map((l) => [l.kind, l.label, l.position])).toEqual([
      ['github', 'Code', 0],
      ['website', undefined, 1],
    ])
    expect((await s.getCreatorByHandle('ferro-labs'))?.links).toHaveLength(2)
    fails(await s.setCreatorLinks([{ kind: 'website', url: 'http://plain.example.com' }]), 'invalid')
    fails(await s.setCreatorLinks([{ kind: 'patreon', url: 'https://example.com/me' }]), 'invalid')
    fails(await s.setCreatorLinks(Array.from({ length: 13 }, (_, i) => ({ kind: 'website' as const, url: `https://site${i}.example.com` }))), 'invalid')
    expect((await s.getCreatorByHandle('ferro-labs'))?.links).toHaveLength(2)
    expect(value(await s.setCreatorLinks([]))).toEqual([])
    fails(await store('rv').setCreatorLinks([]), 'forbidden')
  })

  it('features up to six of the creators own approved models', async () => {
    const s = store('ferro')
    const ids = ['compliant-gripper', 'planetary-gearbox-demo'].map(listing)
    expect((await s.setFeatured(ids)).ok).toBe(true)
    expect((await s.getCreatorByHandle('ferro-labs'))?.featured.map((l) => l.slug)).toEqual(['compliant-gripper', 'planetary-gearbox-demo'])
    fails(await s.setFeatured([listing('wave-dish')]), 'invalid')
    fails(await s.setFeatured([listing('gear-tooth-test-strip')]), 'invalid')
    fails(await s.setFeatured([ids[0] ?? '', ids[0] ?? '']), 'invalid')
    fails(await s.setFeatured(Array.from({ length: 7 }, (_, i) => seedId(`x${i}`))), 'invalid')
    expect((await s.setFeatured([])).ok).toBe(true)
  })

  it('shows the creator dashboard', async () => {
    const rows = value(await store('oddfellow').creatorDashboard())
    expect(rows).toHaveLength(6)
    expect(rows.find((r) => r.status === 'removed')).toBeDefined()
    expect(value(await store('rv').creatorDashboard())).toEqual([])
    fails(await store(null).creatorDashboard(), 'not_signed_in')
  })

  it('hides a paused page from visitors', async () => {
    const s = store('kestrel')
    expect(value(await s.saveCreator({ handle: 'kestrel-parts', displayName: 'Kestrel Parts', status: 'paused' })).status).toBe('paused')
    expect((await s.listListings({ creatorId: seedId('creator:kestrel-parts') })).items).toHaveLength(4)
  })
})

describe('offline store: listings and review', () => {
  it('starts a new listing pending and hides it until it is approved', async () => {
    const s = store('kestrel')
    const { l } = await submit(s, 'Bench light bracket')
    expect(l).toMatchObject({ status: 'pending', slug: 'bench-light-bracket', license: 'cc-by' })
    expect((await s.myListings())[0]?.id).toBe(l.id)
    const second = value(await s.createListing({ title: 'Bench light bracket' }))
    expect(second.slug).toBe('bench-light-bracket-2')
    fails(await s.createListing({ title: 'x', slug: 'bench-light-bracket' }), 'conflict')
    fails(await s.createListing({ title: '' }), 'invalid')
    fails(await s.createListing({ title: 'x', coverUrl: 'http://example.com/a.png' }), 'invalid')
    fails(await s.createListing({ title: 'x', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }), 'invalid')
    await as(s, 'rv')
    expect(await s.getListing(l.id)).toBeNull()
  })

  it('limits a creator to 20 listings waiting for review', async () => {
    const s = store('ferro')
    for (let i = 0; i < 20; i++) value(await s.createListing({ title: `Waiting ${i}` }))
    fails(await s.createListing({ title: 'One too many' }), 'conflict')
  })

  it('lets only the owner approve in owner mode, and shows the queue to staff', async () => {
    const s = store('kestrel')
    const { l } = await submit(s, 'Bracket two')
    await as(s, 'owner')
    const queue = value(await s.moderationQueue())
    expect(queue.find((q) => q.title === 'Bracket two')).toMatchObject({ status: 'pending', ready: true, waitingVersions: 1, creatorHandle: 'kestrel-parts', uploaderBanned: false })
    expect(queue.some((q) => q.status === 'approved')).toBe(false)
    await as(s, 'moderator')
    fails(await s.approveListing(l.id), 'forbidden', 'you cannot approve uploads in the current moderation mode')
    await as(s, 'rv')
    fails(await s.approveListing(l.id), 'forbidden')
    expect(value(await s.moderationQueue())).toEqual([])
    await as(s, 'owner')
    expect((await s.approveListing(l.id, 'Looks good')).ok).toBe(true)
    const done = (await s.getListing(l.id))?.listing
    expect(done).toMatchObject({ status: 'approved', publishedAt: '2026-09-30T20:00:00.000Z' })
    expect(done?.currentVersion?.reviewStatus).toBe('approved')
    const log = value(await s.auditLog({ limit: 1 }))
    expect(log[0]).toMatchObject({ action: 'approve', targetId: l.id, reason: 'Looks good', detail: { title: 'Bracket two' } })
    await as(s, 'rv')
    expect((await s.getListing(l.id))?.listing.status).toBe('approved')
  })

  it('needs something waiting before approving', async () => {
    const s = store('owner')
    fails(await s.approveListing(listing('wave-dish')), 'conflict', 'nothing is waiting for review')
    fails(await s.approveListing(listing('logo-keychain')), 'conflict')
    fails(await s.approveListing(seedId('nope')), 'not_found')
    await as(s, 'kestrel')
    const empty = value(await s.createListing({ title: 'No file yet' }))
    await as(s, 'owner')
    fails(await s.approveListing(empty.id), 'conflict', 'nothing is waiting for review')
  })

  it('rejects an upload that fails the scan, and rejects a listing with nothing left', async () => {
    const s = store('kestrel')
    const l = value(await s.createListing({ title: 'Broken file' }))
    const v = value(await s.uploadVersion(l.id, { name: 'broken.3mf', version: '1.0.0', bytes: new Uint8Array([1, 2, 3, 4]), format: '3mf' }))
    expect(v).toMatchObject({ scanStatus: 'rejected', reviewStatus: 'rejected' })
    expect(value(await s.getScanStatus(v.id))).toEqual({ scanStatus: 'rejected', reviewStatus: 'rejected' })
    expect(value(await s.getScanReport(v.id))).toMatchObject({ ok: false })
    const after = (await s.getListing(l.id))?.listing
    expect(after?.status).toBe('rejected')
    expect(after?.reviewNote).toContain('failed the upload checks')
    await as(s, 'rv')
    expect(value(await s.getScanReport(v.id))).toBeNull()
    await as(s, 'owner')
    expect(value(await s.getScanReport(v.id))).toMatchObject({ ok: false })
    const log = value(await s.auditLog({ limit: 1 }))
    expect(log[0]).toMatchObject({ action: 'scan_reject', targetKind: 'version' })
    expect(log[0]?.actorId).toBeUndefined()
  })

  it('checks uploads before doing anything', async () => {
    const s = store('kestrel')
    const l = value(await s.createListing({ title: 'Checks' }))
    const up = (input: Partial<Parameters<StoreClient['uploadVersion']>[1]>) => s.uploadVersion(l.id, { name: 'a.3mf', version: '1.0.0', bytes: zip(), format: '3mf', ...input })
    fails(await up({ name: 'A.3MF' }), 'invalid')
    fails(await up({ name: 'a.obj' }), 'invalid')
    fails(await up({ name: 'a.stl' }), 'invalid')
    fails(await up({ version: '1.0' }), 'invalid')
    fails(await up({ bytes: new Uint8Array(0) }), 'invalid')
    fails(await up({ bytes: new Uint8Array(104_857_601) }), 'invalid')
    expect((await up({})).ok).toBe(true)
    fails(await up({}), 'conflict')
    await as(s, 'rv')
    fails(await s.uploadVersion(l.id, { name: 'a.3mf', version: '2.0.0', bytes: zip(), format: '3mf' }), 'not_found')
    await s.signOut()
    fails(await s.uploadVersion(l.id, { name: 'a.3mf', version: '2.0.0', bytes: zip(), format: '3mf' }), 'not_signed_in')
  })

  it('accepts an STL by its signature', async () => {
    const s = store('kestrel')
    const l = value(await s.createListing({ title: 'Plain STL' }))
    const ascii = new TextEncoder().encode('solid cube\nendsolid cube\n')
    expect(value(await s.uploadVersion(l.id, { name: 'cube.stl', version: '1.0.0', bytes: ascii, format: 'stl' })).scanStatus).toBe('clean')
    const binary = new Uint8Array(84 + 50)
    new DataView(binary.buffer).setUint32(80, 1, true)
    expect(value(await s.uploadVersion(l.id, { name: 'tri.stl', version: '1.0.1', bytes: binary, format: 'stl' })).scanStatus).toBe('clean')
    expect(value(await s.uploadVersion(l.id, { name: 'bad.stl', version: '1.0.2', bytes: new Uint8Array(100), format: 'stl' })).scanStatus).toBe('rejected')
  })

  it('needs a reason to reject, and shows it to the creator', async () => {
    const s = store('owner')
    const id = listing('trilobite-coaster-set')
    fails(await s.rejectListing(id, ''), 'invalid', 'give the creator a reason')
    fails(await s.rejectListing(id, ' ab '), 'invalid')
    await as(s, 'moderator')
    fails(await s.rejectListing(id, 'Not good enough'), 'forbidden')
    await as(s, 'owner')
    expect((await s.rejectListing(id, 'The cover shows a trademark.')).ok).toBe(true)
    fails(await s.rejectListing(id, 'Again'), 'conflict')
    await as(s, 'marrow')
    expect((await s.getListing(id))?.listing).toMatchObject({ status: 'rejected', reviewNote: 'The cover shows a trademark.' })
    expect((await s.resubmitListing(id)).ok).toBe(true)
    expect((await s.getListing(id))?.listing.status).toBe('pending')
    fails(await s.resubmitListing(id), 'forbidden')
    await as(s, 'owner')
    expect(value(await s.auditLog({ limit: 1 }))[0]).toMatchObject({ action: 'reject', reason: 'The cover shows a trademark.', detail: { was: 'pending' } })
  })

  it('sends edits to a public listing back through review, and drops it from featured', async () => {
    const s = store('ferro')
    const id = listing('compliant-gripper')
    const edited = value(await s.updateListing(id, { title: 'Compliant gripper v2', tags: ['mechanism'] }))
    expect(edited.status).toBe('pending')
    expect((await s.getCreatorByHandle('ferro-labs'))?.featured.map((l) => l.slug)).toEqual(['planetary-gearbox-demo', 'parametric-enclosure'])
    const unchanged = value(await s.updateListing(listing('parametric-enclosure'), { title: 'Parametric enclosure' }))
    expect(unchanged.status).toBe('approved')
    fails(await s.updateListing(seedId('nope'), { title: 'x' }), 'not_found')
    fails(await s.updateListing(listing('parametric-enclosure'), { slug: 'wave-dish' }), 'conflict')
    await as(s, 'rv')
    expect(await s.getListing(id)).toBeNull()
    await as(s, 'kestrel')
    fails(await s.updateListing(listing('parametric-enclosure'), { title: 'mine now' }), 'not_found')
  })

  it('archives, restores and deletes', async () => {
    const s = store('ferro')
    const id = listing('parametric-enclosure')
    expect((await s.archiveListing(id)).ok).toBe(true)
    fails(await s.archiveListing(id), 'forbidden', 'a archived listing cannot become archived')
    await as(s, 'rv')
    expect(await s.getListing(id)).toBeNull()
    await as(s, 'ferro')
    expect((await s.unarchiveListing(id)).ok).toBe(true)
    await as(s, 'rv')
    expect((await s.getListing(id))?.listing.status).toBe('approved')
    fails(await s.deleteListing(listing('wave-dish')), 'not_found')
    await as(s, 'ferro')
    fails(await s.deleteListing(id), 'forbidden')
    fails(await s.unarchiveListing(listing('wave-dish')), 'not_found')
    expect((await s.archiveListing(id)).ok).toBe(true)
    expect((await s.deleteListing(id)).ok).toBe(true)
    expect(await s.getListing(id)).toBeNull()
    await as(s, 'oddfellow')
    expect((await s.deleteListing(listing('wizard-tower-terrain'))).ok).toBe(true)
  })

  it('queues a new version of an approved listing while the listing stays public', async () => {
    const s = store('marrow')
    const id = listing('desk-skull-planter')
    const v = value(await s.uploadVersion(id, { name: 'planter-2.3mf', version: '1.1.0', changelog: 'Wider drain hole', bytes: zip(), format: '3mf' }))
    expect(v).toMatchObject({ scanStatus: 'clean', reviewStatus: 'pending' })
    expect((await s.getListing(id))?.versions.map((x) => x.version)).toEqual(['1.1.0', '1.0.0'])
    await as(s, 'rv')
    expect((await s.getListing(id))?.versions.map((x) => x.version)).toEqual(['1.0.0'])
    await as(s, 'owner')
    expect(value(await s.moderationQueue()).find((q) => q.listingId === id)).toMatchObject({ status: 'approved', waitingVersions: 1, ready: true })
    expect((await s.approveListing(id)).ok).toBe(true)
    await as(s, 'rv')
    expect((await s.getListing(id))?.versions.map((x) => x.version)).toEqual(['1.1.0', '1.0.0'])
    expect(value(await s.download(id))).toMatchObject({ version: '1.1.0' })
  })

  it('removes an approved listing with a reason the creator sees', async () => {
    const s = store('owner')
    const id = listing('planetary-gearbox-demo')
    fails(await s.removeListing(id, 'no'), 'invalid')
    expect((await s.removeListing(id, 'Copied from another site')).ok).toBe(true)
    expect((await s.removeListing(id, 'Copied from another site')).ok).toBe(true)
    await as(s, 'ferro')
    expect((await s.getListing(id))?.listing).toMatchObject({ status: 'removed', reviewNote: 'Copied from another site' })
    expect((await s.getCreatorByHandle('ferro-labs'))?.featured.map((l) => l.slug)).not.toContain('planetary-gearbox-demo')
    fails(await s.removeListing(id, 'self remove'), 'forbidden')
    await as(s, 'rv')
    expect(await s.getListing(id)).toBeNull()
    fails(await s.download(id), 'not_found')
  })

  it('follows the moderation mode', async () => {
    const s = store('kestrel')
    const { l } = await submit(s, 'Mode test')
    expect(await s.getModerationMode()).toBe('owner-approves-all')
    await as(s, 'moderator')
    fails(await s.setModerationMode('moderators'), 'forbidden', 'only the owner can change the moderation mode')
    await as(s, 'owner')
    fails(await s.setModerationMode('anyone' as never), 'invalid', 'unknown moderation mode')
    expect((await s.setModerationMode('moderators')).ok).toBe(true)
    expect(await s.getModerationMode()).toBe('moderators')
    expect((await s.getLibrarySettings()).moderationMode).toBe('moderators')
    await as(s, 'moderator')
    expect((await s.approveListing(l.id)).ok).toBe(true)
    const log = value(await s.auditLog({ limit: 2 }))
    expect(log.map((a) => a.action)).toEqual(['approve', 'set_moderation_mode'])
    expect(log[1]?.detail).toEqual({ from: 'owner-approves-all', to: 'moderators' })
  })

  it('approves clean uploads from trusted creators at once in trusted-creators mode', async () => {
    const s = store('owner')
    expect((await s.setModerationMode('trusted-creators')).ok).toBe(true)
    await as(s, 'marrow')
    const trusted = await submit(s, 'Trusted upload')
    expect((await s.getListing(trusted.l.id))?.listing.status).toBe('approved')
    await as(s, 'kestrel')
    const other = await submit(s, 'Untrusted upload')
    expect((await s.getListing(other.l.id))?.listing.status).toBe('pending')
    await as(s, 'moderator')
    fails(await s.setCreatorTrusted(seedId('creator:kestrel-parts'), true), 'forbidden')
    await as(s, 'owner')
    expect((await s.setCreatorTrusted(seedId('creator:kestrel-parts'), true)).ok).toBe(true)
    await as(s, 'kestrel')
    const later = await submit(s, 'Now trusted')
    expect((await s.getListing(later.l.id))?.listing.status).toBe('approved')
    await as(s, 'owner')
    const log = value(await s.auditLog({ limit: 10 }))
    expect(log.filter((a) => a.action === 'auto_approve')).toHaveLength(2)
    expect(log.find((a) => a.action === 'auto_approve')?.actorId).toBeUndefined()
    expect(log.some((a) => a.action === 'trust')).toBe(true)
  })

  it('approves every clean upload at once in auto-after-scan mode, and staff can still remove it', async () => {
    const s = store('owner')
    expect((await s.setModerationMode('auto-after-scan')).ok).toBe(true)
    await as(s, 'kestrel')
    const { l } = await submit(s, 'Auto approved')
    expect((await s.getListing(l.id))?.listing.status).toBe('approved')
    const bad = value(await s.createListing({ title: 'Auto broken' }))
    await s.uploadVersion(bad.id, { name: 'x.3mf', version: '1.0.0', bytes: new Uint8Array([1, 2, 3]), format: '3mf' })
    expect((await s.getListing(bad.id))?.listing.status).toBe('rejected')
    await as(s, 'moderator')
    expect((await s.removeListing(l.id, 'Not a model')).ok).toBe(true)
    fails(await s.setModerationMode('owner-approves-all'), 'forbidden')
  })

  it('lets moderators approve in moderators mode and trusted-creators mode', async () => {
    for (const mode of ['moderators', 'trusted-creators'] as const) {
      const s = store('kestrel')
      const { l } = await submit(s, `Mode ${mode}`)
      await as(s, 'owner')
      await s.setModerationMode(mode)
      await as(s, 'moderator')
      expect((await s.approveListing(l.id)).ok, mode).toBe(true)
    }
  })

  it('pages the audit log for staff only', async () => {
    const owner = store('owner')
    const first = value(await owner.auditLog({ limit: 10 }))
    expect(first).toHaveLength(10)
    const ids = first.map((a) => a.id)
    expect([...ids].sort((a, b) => b - a)).toEqual(ids)
    const next = value(await owner.auditLog({ limit: 10, before: ids.at(-1) ?? 0 }))
    expect(next.every((a) => a.id < (ids.at(-1) ?? 0))).toBe(true)
    await as(owner, 'moderator')
    expect(value(await owner.auditLog({ limit: 200 }))).toHaveLength(generateSeed().audit_log.length)
    await as(owner, 'rv')
    expect(value(await owner.auditLog())).toEqual([])
    await owner.signOut()
    fails(await owner.auditLog(), 'not_signed_in')
  })
})

describe('offline store: bans and roles', () => {
  it('needs a reason to ban, and protects the owner, moderators and yourself', async () => {
    const s = store('moderator')
    fails(await s.banUser(user('ash'), ''), 'invalid', 'give a reason for the ban')
    fails(await s.banUser(user('owner'), 'Coup'), 'forbidden', 'this account cannot be banned by you')
    fails(await s.banUser(user('moderator'), 'Self'), 'forbidden')
    fails(await s.banUser(seedId('nobody'), 'Spam links'), 'not_found')
    await as(s, 'rv')
    fails(await s.banUser(user('ash'), 'Spam links'), 'forbidden', 'only staff can ban accounts')
    await as(s, 'owner')
    fails(await s.banUser(user('owner'), 'Self'), 'forbidden')
    await as(s, 'moderator')
    expect((await s.banUser(user('ash'), 'Spam links')).ok).toBe(true)
    expect(await store('ash').myRole()).toBe('member')
    await as(s, 'owner')
    expect((await s.unbanUser(user('ash'), 'Appeal accepted')).ok).toBe(true)
    const log = value(await s.auditLog({ limit: 2 }))
    expect(log.map((a) => a.action)).toEqual(['unban', 'ban'])
    expect(log[1]).toMatchObject({ reason: 'Spam links', targetId: user('ash') })
  })

  it('reports a banned member as banned, and refuses their sign-in', async () => {
    const s = store('moderator')
    expect((await s.banUser(user('ash'), 'Spam links')).ok).toBe(true)
    fails(await s.signInWithEmail('ash@example.com'), 'forbidden', 'This account is banned')
    expect(await s.myRole()).toBe('moderator')
  })

  it('lets the owner ban a moderator', async () => {
    expect((await store('owner').banUser(user('moderator'), 'Left the team')).ok).toBe(true)
  })

  it('stops a banned member from acting', async () => {
    const zed = store('zed')
    expect(await zed.myRole()).toBe('banned')
    expect((await zed.session())?.role).toBe('banned')
    fails(await zed.like(listing('wave-dish')), 'forbidden')
    fails(await zed.addComment(listing('wave-dish'), 'hello'), 'forbidden')
    fails(await zed.follow(seedId('creator:ferro-labs')), 'forbidden')
    fails(await zed.download(listing('wave-dish')), 'forbidden')
    fails(await zed.createCollection('Mine'), 'forbidden')
    fails(await zed.saveCreator({ handle: 'zed-makes', displayName: 'Zed' }), 'forbidden')
    fails(await zed.addPairedDevice({ deviceId: 'device-zed-1', name: 'Phone', platform: 'ios', signPub: 'A'.repeat(43) }), 'forbidden')
    fails(await zed.approveListing(listing('trilobite-coaster-set')), 'forbidden')
    fails(await zed.banUser(user('ash'), 'Revenge'), 'forbidden')
    expect(value(await zed.moderationQueue())).toEqual([])
    expect(value(await zed.auditLog())).toEqual([])
  })

  it('hides a banned creators page and listings, and stops them editing', async () => {
    const s = store('moderator')
    expect((await s.banUser(user('kestrel'), 'Stolen models')).ok).toBe(true)
    expect((await s.getCreatorByHandle('kestrel-parts'))?.creator.handle).toBe('kestrel-parts')
    await as(s, 'rv')
    expect(await s.getCreatorByHandle('kestrel-parts')).toBeNull()
    expect(await s.getListing('filament-spool-holder')).toBeNull()
    expect((await s.listListings({ limit: 100 })).items).toHaveLength(16)
    expect((await s.listCreators()).map((c) => c.handle)).not.toContain('kestrel-parts')
    await as(s, 'owner')
    expect(value(await s.moderationQueue()).find((q) => q.creatorHandle === 'kestrel-parts')?.uploaderBanned).toBe(true)
  })

  it('revokes API tokens when a member is banned', async () => {
    const s = store('ash')
    value(await s.createApiToken({ name: 'CLI', scopes: ['cli'] }))
    await as(s, 'moderator')
    expect((await s.banUser(user('ash'), 'Spam links')).ok).toBe(true)
    await as(s, 'owner')
    expect((await s.unbanUser(user('ash'))).ok).toBe(true)
    await as(s, 'ash')
    expect((await s.apiTokens()).every((t) => t.revokedAt !== undefined)).toBe(true)
  })

  it('lets only the owner change roles', async () => {
    const s = store('moderator')
    fails(await s.setUserRole(user('ash'), 'moderator'), 'forbidden', 'only the owner can change roles')
    await as(s, 'owner')
    fails(await s.setUserRole(user('ash'), 'owner' as never), 'invalid')
    fails(await s.setUserRole(user('owner'), 'member'), 'forbidden')
    fails(await s.setUserRole(seedId('nobody'), 'member'), 'not_found')
    expect((await s.setUserRole(user('ash'), 'moderator', 'Trusted helper')).ok).toBe(true)
    expect(value(await s.auditLog({ limit: 1 }))[0]).toMatchObject({ action: 'role_change', reason: 'Trusted helper', detail: { from: 'member', to: 'moderator' } })
    await as(s, 'ash')
    expect(await s.myRole()).toBe('moderator')
    expect(value(await s.moderationQueue()).length).toBeGreaterThan(0)
    await s.signOut()
    expect(await s.myRole()).toBeNull()
  })
})

describe('sign-in and session', () => {
  it('signs in and out of seeded accounts and reports session changes', async () => {
    const s = store(null)
    const seen: (string | undefined)[] = []
    const off = s.onSessionChange((x) => seen.push(x?.handle))
    expect(await s.signInWithEmail('ash@example.com')).toEqual({ ok: true, value: undefined })
    expect(await s.signInWithEmail('nobody@example.org')).toMatchObject({ ok: false, code: 'not_found' })
    await s.signOut()
    off()
    expect(seen).toEqual(['ash', undefined])
  })
})

describe('API tokens', () => {
  it('creates, lists and revokes a token, showing the secret once', async () => {
    const s = store()
    const created = await s.createApiToken({ name: 'Laptop CLI', scopes: ['cli', 'mcp'] })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value.secret).toMatch(/^sxk_[0-9a-f]{64}$/)
    expect(created.value.token.prefix).toBe(created.value.secret.slice(0, 12))
    expect(created.value.token.expiresAt).toBe('2026-12-29T20:00:00.000Z')
    const listed = await s.apiTokens()
    expect(listed).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain(created.value.secret)
    expect(await s.revokeApiToken(created.value.token.id)).toEqual({ ok: true, value: undefined })
    expect((await s.apiTokens())[0]?.revokedAt).toBeDefined()
    expect(await s.revokeApiToken(created.value.token.id)).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('rejects bad input and signed-out callers', async () => {
    const s = store()
    expect(await s.createApiToken({ name: '', scopes: ['cli'] })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await s.createApiToken({ name: 'x', scopes: [] })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await s.createApiToken({ name: 'x', scopes: ['read'], expiresInDays: 400 })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await store(null).createApiToken({ name: 'x', scopes: ['read'] })).toMatchObject({ ok: false, code: 'not_signed_in' })
  })

  it('works through the auth-only client, without the store module', async () => {
    const auth = createAuth({ offline: true, now: fixed, newId, seed: generateSeed() })
    expect((await auth.session())?.handle).toBe('rv')
    expect('listListings' in auth).toBe(false)
    expect((await auth.createApiToken({ name: 'MCP', scopes: ['mcp'], expiresInDays: null })).ok).toBe(true)
  })
})

describe('auth callbacks', () => {
  it('recognizes web and desktop callbacks that carry a code or an error', () => {
    expect(isAuthCallback('http://127.0.0.1:5173/auth/callback?code=abc')).toBe(true)
    expect(isAuthCallback('slicerx://auth/callback?code=abc', 'slicerx')).toBe(true)
    expect(isAuthCallback('slicerx://auth/callback?code=abc')).toBe(false)
    expect(isAuthCallback('harborslice://auth/callback?code=abc', 'slicerx')).toBe(false)
    expect(isAuthCallback('slicerx://auth/callback?error=access_denied', 'slicerx')).toBe(true)
    expect(isAuthCallback('slicerx://auth/callback', 'slicerx')).toBe(false)
    expect(isAuthCallback('https://example.com/other?code=abc')).toBe(false)
    expect(isAuthCallback('not a url')).toBe(false)
  })
})

describe('contract fixtures', () => {
  it('writes store- fixtures from the offline client', async () => {
    const s = store()
    const here = dirname(fileURLToPath(import.meta.url))
    const dir = join(here, '..', '..', 'contracts', 'fixtures')
    mkdirSync(dir, { recursive: true })
    const feed = await s.feed({ limit: 1 })
    const page = await s.getCreatorByHandle('ferro-labs')
    const queue = value(await store('owner').moderationQueue())
    const write = (name: string, v: unknown) => writeFileSync(join(dir, name), `${JSON.stringify(v, null, 2)}\n`)
    write('store-feed-item.json', feed.items[0])
    write('store-creator-page.json', page)
    write('store-moderation-item.json', queue[0])
    expect(feed.items[0]?.listing.id).toBeTruthy()
    expect(queue[0]?.listingId).toBeTruthy()
  })
})

describe('offline store: library rows and creator pages', () => {
  it('ranks trending against the catalog own latest activity', async () => {
    const s = store()
    const rows = await s.trending({ limit: 10 })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.listing.status === 'approved')).toBe(true)
  })

  it('moves a freshly liked design up the trending row', async () => {
    const s = store()
    const before = await s.trending({ limit: 100 })
    const last = before.at(-1)
    expect(last).toBeDefined()
    for (const h of ['ash', 'bo', 'rv']) {
      await as(s, h)
      await s.like(last?.listing.id ?? '')
    }
    const after = await s.trending({ limit: 100 })
    expect(after.findIndex((r) => r.listing.id === last?.listing.id)).toBeLessThan(before.length - 1)
  })

  it('lists a creator whose first design was just approved as new', async () => {
    const s = store('rv')
    value(await s.saveCreator({ handle: 'rv-prints', displayName: 'RV Prints' }))
    const { l } = await submit(s, 'First print')
    await as(s, 'owner')
    value(await s.approveListing(l.id))
    const fresh = await s.newCreators({ days: 30 })
    expect(fresh[0]?.handle).toBe('rv-prints')
    expect(fresh.some((c) => c.handle === 'marrow-works')).toBe(false)
  })

  it('recommends from the member likes and leaves out what they liked', async () => {
    const s = store('rv')
    const picks = await s.recommended()
    expect(picks.length).toBeGreaterThan(0)
    expect(picks.some((p) => p.listing.likedByMe)).toBe(false)
    expect(await store(null).recommended()).toEqual([])
  })

  it('keeps a private Saved list', async () => {
    const s = store('rv')
    const id = listing('spine-cable-organizer')
    expect(await s.savedListings()).toEqual([])
    value(await s.setSaved(id, true))
    value(await s.setSaved(id, true))
    const saved = await s.savedListings()
    expect(saved.map((x) => x.listing.id)).toEqual([id])
    expect(saved[0]?.listing.savedByMe).toBe(true)
    expect((await s.collections()).some((c) => c.name === 'Saved')).toBe(false)
    await as(s, 'ash')
    expect(await s.savedListings()).toEqual([])
    await as(s, 'rv')
    value(await s.setSaved(id, false))
    expect(await s.savedListings()).toEqual([])
    fails(await store(null).setSaved(id, true), 'not_signed_in')
  })

  it('stores a banner and logo on the creator page', async () => {
    const s = store('marrow')
    fails(await s.uploadCreatorImage({ kind: 'banner', bytes: new Uint8Array(4), contentType: 'image/svg+xml' }), 'invalid')
    fails(await s.uploadCreatorImage({ kind: 'banner', bytes: new Uint8Array(5_242_881), contentType: 'image/png' }), 'invalid')
    const url = value(await s.uploadCreatorImage({ kind: 'banner', bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' }))
    const me = await s.getMyCreator()
    value(await s.saveCreator({ handle: me?.handle ?? '', displayName: me?.displayName ?? '', bannerUrl: url }))
    expect((await s.getCreatorByHandle('marrow-works'))?.creator.bannerUrl).toBe(url)
    fails(await s.saveCreator({ handle: 'marrow-works', displayName: 'Marrow Works', bannerUrl: 'javascript:alert(1)' }), 'invalid')
    fails(await store('ash').uploadCreatorImage({ kind: 'logo', bytes: new Uint8Array(3), contentType: 'image/png' }), 'forbidden')
  })
})
