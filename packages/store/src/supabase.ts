// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// StoreClient over a Supabase project. Holds only the project URL and anon key;
// every rule lives in the database (policies, triggers and functions in
// supabase/migrations), so these are thin wrappers over PostgREST, RPC and
// storage. The client checks only what saves a network trip.
import type {
  AuthClient,
  Comment,
  Creator,
  CreatorLink,
  CreatorPage,
  FeedItem,
  Listing,
  ListingCard,
  ListingStats,
  LibrarySettings,
  ListingVersion,
  StoreClient,
  StoreResult,
} from '@slicerx/contracts'
import { z } from 'zod'
import { createSupabaseClient, errorCode, fail, ok, read, rows, supabaseAuth, type Db, type SupabaseOptions } from './auth/supabase'
import {
  latestVersion,
  toAudit,
  toCollection,
  toComment,
  toCreator,
  toCreatorLink,
  toDashboardRow,
  toFile,
  toListing,
  toMake,
  toModerationItem,
  toPrintProfile,
  toVersion,
} from './map'
import {
  auditRow,
  collectionItemRow,
  collectionRow,
  commentRow,
  creatorFeaturedRow,
  creatorLinkRow,
  creatorRow,
  dashboardRow,
  fileRow,
  followRow,
  likeRow,
  listingRow,
  makeRow,
  librarySettingsRow,
  printProfileRow,
  profileRow,
  queueRow,
  versionRow,
  type CreatorRow,
  type ListingRow,
  type VersionRow,
} from './rows'
import { DEFAULT_MAX_FILE_MB, slugify, validateCreatorLinks, validateHandle, validateUpload } from './validate'

const LISTING_COLUMNS = 'id, creator_id, slug, title, description, license, status, tags, cover_url, review_note, reviewed_by, reviewed_at, published_at, created_at'
// The scan report is read through version_scan_report, never straight from the table.
const VERSION_COLUMNS = 'id, listing_id, version, changelog, storage_path, sha256, format, size_bytes, scan_status, scanned_at, review_status, created_at'
// Every column, so a project that has not applied 0013_creator_pages (banner_url) still reads creators.
const CREATOR_COLUMNS = '*'
const COMMENT_COLUMNS = 'id, listing_id, user_id, parent_id, body, created_at, edited_at, deleted_at'
const MAKE_COLUMNS = 'id, listing_id, user_id, caption, photo_url, printer_model, created_at'
const LINK_COLUMNS = 'id, creator_id, kind, label, url, position'
const PROFILE_COLUMNS = 'id, handle, display_name, avatar_url, role, banned_at, ban_reason'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HTTPS = /^https:\/\/[^\s<>"']{4,500}$/i
const statsRow = z.object({ listing_id: z.string(), likes: z.coerce.number(), makes: z.coerce.number(), comments: z.coerce.number(), downloads: z.coerce.number() })
const followersRow = z.object({ creator_id: z.string(), followers: z.coerce.number() })
const scoredRow = z.object({ listing_id: z.string(), score: z.coerce.number() })
const newCreatorRow = z.object({ creator_id: z.string(), first_published_at: z.string() })
const savedRow = z.object({ listing_id: z.string(), saved_at: z.string() })
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
const MAX_IMAGE_BYTES = 5_242_880

type DbError = { code?: string; message: string; hint?: string | null } | null
const failed = <T>(error: NonNullable<DbError>): StoreResult<T> => fail(errorCode(error), error.message)

/** Wraps a query or RPC that returns nothing. */
async function done(q: PromiseLike<{ error: DbError }>): Promise<StoreResult<void>> {
  const { error } = await q
  return error ? failed(error) : ok(undefined)
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest('SHA-256', bytes.slice().buffer).then((d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''))
}

const grantRow = z.object({ path: z.string(), version_id: z.string(), version: z.string(), grant: z.string().nullable() })

/** `conn` is needed only for signed-out downloads, which read storage directly. */
export function supabaseStore(sb: Db, conn?: Pick<SupabaseOptions, 'url' | 'anonKey'>): Omit<StoreClient, keyof AuthClient> {
  async function uid(): Promise<string | null> {
    const { data } = await sb.auth.getSession()
    return data.session?.user.id ?? null
  }

  async function ownCreatorRow(me: string): Promise<CreatorRow | undefined> {
    return (await read(creatorRow, sb.from('creators').select(CREATOR_COLUMNS).eq('owner_id', me)))[0]
  }

  /** The signed-in member's creator page, or the failure to return. */
  async function needCreator(): Promise<{ me: string; creator: CreatorRow } | StoreResult<never>> {
    const me = await uid()
    if (!me) return fail('not_signed_in', 'Sign in first')
    const creator = await ownCreatorRow(me)
    return creator ? { me, creator } : fail('forbidden', 'Make your creator page first')
  }
  const isFailure = (x: unknown): x is StoreResult<never> => typeof x === 'object' && x !== null && 'ok' in x

  async function profilesById(ids: (string | null)[]): Promise<Map<string, Comment['author']>> {
    const want = [...new Set(ids.filter((i): i is string => i !== null))]
    if (want.length === 0) return new Map()
    const found = await read(profileRow, sb.from('profiles').select(PROFILE_COLUMNS).in('id', want))
    return new Map(found.map((p) => [p.id, { id: p.id, handle: p.handle, displayName: p.display_name }]))
  }

  async function statsFor(ids: string[]): Promise<Map<string, ListingStats>> {
    if (ids.length === 0) return new Map()
    const { data, error } = await sb.rpc('listing_stats', { p_ids: ids })
    if (error) throw new Error(`store read failed (${error.code ?? 'unknown'}): ${error.message}`)
    return new Map(rows(statsRow, data).map((r) => [r.listing_id, { likes: r.likes, makes: r.makes, comments: r.comments, downloads: r.downloads }]))
  }

  /** Listings with their newest visible version, counts and the caller's like. */
  async function hydrate(listings: ListingRow[], me: string | null): Promise<Listing[]> {
    if (listings.length === 0) return []
    const ids = listings.map((l) => l.id)
    const [versions, stats, likes, saved] = await Promise.all([
      read(versionRow, sb.from('listing_versions').select(VERSION_COLUMNS).in('listing_id', ids)),
      statsFor(ids),
      me ? read(likeRow, sb.from('likes').select('user_id, listing_id, created_at').eq('user_id', me).in('listing_id', ids)) : Promise.resolve([]),
      me ? savedIds() : Promise.resolve(new Set<string>()),
    ])
    const newest = new Map<string, VersionRow>()
    for (const l of listings) {
      const v = latestVersion(versions.filter((x) => x.listing_id === l.id))
      if (v) newest.set(l.id, v)
    }
    const profiles = newest.size
      ? await read(printProfileRow, sb.from('print_profiles').select('*').in('version_id', [...newest.values()].map((v) => v.id)))
      : []
    const liked = new Set(likes.map((x) => x.listing_id))
    return listings.map((l) => {
      const v = newest.get(l.id)
      const s = stats.get(l.id)
      return toListing(l, {
        ...(v ? { currentVersion: toVersion(v, profiles.filter((p) => p.version_id === v.id)) } : {}),
        ...(s ? { stats: s } : {}),
        ...(me ? { likedByMe: liked.has(l.id), savedByMe: saved.has(l.id) } : {}),
      })
    })
  }

  async function savedIds(): Promise<Set<string>> {
    const { data, error } = await sb.rpc('saved_listings')
    return new Set(error ? [] : rows(savedRow, data).map((r) => r.listing_id))
  }

  /** Approved listings by id as cards, in the order given. */
  async function cardsById(ids: string[], me: string | null): Promise<ListingCard[]> {
    if (ids.length === 0) return []
    const found = await read(listingRow, sb.from('listings').select(LISTING_COLUMNS).in('id', ids))
    const byId = new Map(found.map((l) => [l.id, l]))
    return cards(ids.flatMap((id) => byId.get(id) ?? []), me)
  }

  /** Removes images in the creator's folder the page no longer uses. Best effort. */
  async function pruneCreatorImages(me: string, keep: (string | null)[]): Promise<void> {
    const listed = await sb.storage.from('creator-media').list(me, { limit: 100 })
    if (listed.error) return
    const used = new Set(keep.filter((u): u is string => Boolean(u)).map((u) => u.split('/').pop()))
    const stale = (listed.data ?? []).map((o) => o.name).filter((n) => !used.has(n))
    if (stale.length) await sb.storage.from('creator-media').remove(stale.map((n) => `${me}/${n}`))
  }

  async function creatorsById(ids: string[], me: string | null, withCount = false): Promise<Map<string, Creator>> {
    const want = [...new Set(ids)]
    if (want.length === 0) return new Map()
    const [found, followers, followed, counts] = await Promise.all([
      read(creatorRow, sb.from('creators').select(CREATOR_COLUMNS).in('id', want)),
      sb.rpc('creator_followers', { p_ids: want }).then((r) => rows(followersRow, r.data)),
      me ? read(followRow, sb.from('follows').select('user_id, creator_id, created_at').eq('user_id', me).in('creator_id', want)) : Promise.resolve([]),
      withCount ? read(z.object({ creator_id: z.string() }), sb.from('listings').select('creator_id').eq('status', 'approved').in('creator_id', want)) : Promise.resolve([]),
    ])
    const count = new Map(followers.map((f) => [f.creator_id, f.followers]))
    const following = new Set(followed.map((f) => f.creator_id))
    return new Map(
      found.map((c) => [
        c.id,
        toCreator(c, count.get(c.id) ?? 0, {
          ...(withCount ? { listingCount: counts.filter((x) => x.creator_id === c.id).length } : {}),
          ...(me ? { followedByMe: following.has(c.id) } : {}),
        }),
      ]),
    )
  }

  async function cards(listings: ListingRow[], me: string | null): Promise<ListingCard[]> {
    const [hydrated, creators] = await Promise.all([hydrate(listings, me), creatorsById(listings.map((l) => l.creator_id), me)])
    return hydrated.flatMap((listing) => {
      const creator = creators.get(listing.creatorId)
      return creator ? [{ listing, creator }] : []
    })
  }

  const cleanTerm = (q: string) => q.replace(/[,()%*\\:"]/g, ' ').trim()

  async function listPage(o: { cursor?: string | undefined; limit?: number | undefined; tag?: string | undefined; creatorId?: string | undefined; query?: string | undefined; sort?: 'new' | 'popular' | undefined; status?: string | undefined }) {
    const start = Number(o.cursor ?? 0) || 0
    const limit = Math.min(Math.max(o.limit ?? 20, 1), 100)
    let q = sb.from('listings').select(LISTING_COLUMNS).eq('status', o.status ?? 'approved')
    if (o.tag) q = q.contains('tags', [o.tag])
    if (o.creatorId) q = q.eq('creator_id', o.creatorId)
    const term = o.query ? cleanTerm(o.query) : ''
    if (term) q = q.or(`title.ilike.%${term}%,tags.cs.{${term.toLowerCase().replace(/\s+/g, '-')}}`)
    q = q.order('published_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
    if (o.sort === 'popular') {
      // No database sort by counts: rank the newest 200 matches here.
      const pool = await read(listingRow, q.range(0, 199))
      const stats = await statsFor(pool.map((l) => l.id))
      const score = (l: ListingRow) => (stats.get(l.id)?.likes ?? 0) + (stats.get(l.id)?.downloads ?? 0)
      const ranked = [...pool].sort((a, b) => score(b) - score(a))
      return { rows: ranked.slice(start, start + limit), more: start + limit < ranked.length, start, limit }
    }
    const page = await read(listingRow, q.range(start, start + limit))
    return { rows: page.slice(0, limit), more: page.length > limit, start, limit }
  }

  async function setStatus(id: string, to: ListingRow['status']): Promise<StoreResult<void>> {
    // The database trigger names an illegal move in its error.
    const { error, count } = await sb.from('listings').update({ status: to }, { count: 'exact' }).eq('id', id)
    if (error) return failed(error)
    return count === 0 ? fail('not_found', 'no such listing') : ok(undefined)
  }

  async function replaceRows<T extends Record<string, unknown>>(table: 'creator_links' | 'creator_featured', creatorId: string, next: T[]): Promise<StoreResult<void>> {
    const old = await sb.from(table).select('*').eq('creator_id', creatorId)
    if (old.error) return failed(old.error)
    const del = await sb.from(table).delete().eq('creator_id', creatorId)
    if (del.error) return failed(del.error)
    if (next.length === 0) return ok(undefined)
    const ins = await sb.from(table).insert(next as never)
    if (!ins.error) return ok(undefined)
    // Put the old rows back so a rejected list does not leave the page bare.
    if ((old.data ?? []).length > 0) await sb.from(table).insert(old.data as never)
    return failed(ins.error)
  }

  /** Readable by everyone. Falls back to the defaults when the table cannot be read. */
  async function librarySettings(): Promise<LibrarySettings> {
    const { data, error } = await sb.from('library_settings').select('id, moderation_mode, max_file_mb, allowed_formats')
    const row = error ? undefined : rows(librarySettingsRow, data)[0]
    return row
      ? { moderationMode: row.moderation_mode, maxFileMb: row.max_file_mb, allowedFormats: row.allowed_formats }
      : { moderationMode: 'owner-approves-all', maxFileMb: DEFAULT_MAX_FILE_MB, allowedFormats: ['3mf', 'sx3mf', 'stl'] }
  }

  const client: Omit<StoreClient, keyof AuthClient> = {
    // Library ------------------------------------------------------------------------
    async listListings(o = {}) {
      const me = await uid()
      const p = await listPage(o)
      const items = await cards(p.rows, me)
      return p.more ? { items, next: String(p.start + p.limit) } : { items }
    },

    async feed(o = {}) {
      const me = await uid()
      const p = await listPage({ cursor: o.cursor, limit: o.limit, tag: o.category, sort: 'new' })
      const [items, follows] = await Promise.all([
        cards(p.rows, me),
        me ? read(followRow, sb.from('follows').select('user_id, creator_id, created_at').eq('user_id', me)) : Promise.resolve([]),
      ])
      const followed = new Set(follows.map((f) => f.creator_id))
      const feed = items.map(({ listing, creator }): FeedItem => {
        const s = listing.stats
        const reason = followed.has(listing.creatorId) ? 'following' : s && s.likes + s.makes >= 8 ? 'popular' : 'new'
        return { listing, creator, reason, makes: s?.makes ?? 0 }
      })
      return p.more ? { items: feed, next: String(p.start + p.limit) } : { items: feed }
    },

    async trending(o = {}) {
      const me = await uid()
      const { data, error } = await sb.rpc('trending_listings', { p_days: o.days ?? 7, p_limit: o.limit ?? 24 })
      if (error) throw new Error(`store read failed (${error.code ?? 'unknown'}): ${error.message}`)
      return cardsById(rows(scoredRow, data).map((r) => r.listing_id), me)
    },

    async newCreators(o = {}) {
      const me = await uid()
      const { data, error } = await sb.rpc('new_creators', { p_days: o.days ?? 30, p_limit: o.limit ?? 12 })
      if (error) throw new Error(`store read failed (${error.code ?? 'unknown'}): ${error.message}`)
      const got = rows(newCreatorRow, data)
      const found = await creatorsById(got.map((r) => r.creator_id), me, true)
      return got.flatMap((r) => {
        const c = found.get(r.creator_id)
        return c ? [{ ...c, firstPublishedAt: new Date(r.first_published_at).toISOString() }] : []
      })
    },

    async recommended(o = {}) {
      const me = await uid()
      if (!me) return []
      const { data, error } = await sb.rpc('recommended_listings', { p_limit: o.limit ?? 24 })
      if (error) throw new Error(`store read failed (${error.code ?? 'unknown'}): ${error.message}`)
      return cardsById(rows(scoredRow, data).map((r) => r.listing_id), me)
    },

    async savedListings() {
      const me = await uid()
      if (!me) return []
      const { data, error } = await sb.rpc('saved_listings')
      if (error) throw new Error(`store read failed (${error.code ?? 'unknown'}): ${error.message}`)
      return cardsById(rows(savedRow, data).map((r) => r.listing_id), me)
    },

    async setSaved(listingId, saved) {
      if (!(await uid())) return fail('not_signed_in', 'Sign in first')
      const { error } = await sb.rpc('set_saved', { p_listing: listingId, p_saved: saved })
      return error ? failed(error) : ok(undefined)
    },

    async getListing(idOrSlug) {
      const found = await read(listingRow, sb.from('listings').select(LISTING_COLUMNS).eq(UUID.test(idOrSlug) ? 'id' : 'slug', idOrSlug))
      const row = found[0]
      if (!row) return null
      const me = await uid()
      const [[listing], creators, versionRows] = await Promise.all([
        hydrate([row], me),
        creatorsById([row.creator_id], me),
        read(versionRow, sb.from('listing_versions').select(VERSION_COLUMNS).eq('listing_id', row.id).order('created_at', { ascending: false })),
      ])
      const creator = creators.get(row.creator_id)
      if (!listing || !creator) return null
      const profiles = versionRows.length ? await read(printProfileRow, sb.from('print_profiles').select('*').in('version_id', versionRows.map((v) => v.id))) : []
      const versions: ListingVersion[] = versionRows.map((v) => toVersion(v, profiles.filter((p) => p.version_id === v.id)))
      return { listing, creator, versions }
    },

    async myListings() {
      const me = await uid()
      if (!me) return []
      const creator = await ownCreatorRow(me)
      if (!creator) return []
      const found = await read(listingRow, sb.from('listings').select(LISTING_COLUMNS).eq('creator_id', creator.id).order('created_at', { ascending: false }))
      return hydrate(found, me)
    },

    async createListing(input) {
      const mine = await needCreator()
      if (isFailure(mine)) return mine
      const title = input.title.trim()
      if (title.length < 1 || title.length > 120) return fail('invalid', 'Titles are 1 to 120 characters')
      if (input.coverUrl !== undefined && !HTTPS.test(input.coverUrl)) return fail('invalid', 'The cover must be an https address')
      const base = input.slug ?? slugify(title)
      // A slug made from the title gets a number when it is taken; a slug the caller chose does not.
      const attempts = input.slug === undefined ? 6 : 1
      for (let n = 1; n <= attempts; n++) {
        const slug = n === 1 ? base : `${base.slice(0, 76)}-${n}`
        const { data, error } = await sb
          .from('listings')
          .insert({
            creator_id: mine.creator.id,
            slug,
            title,
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.license === undefined ? {} : { license: input.license }),
            ...(input.tags === undefined ? {} : { tags: input.tags }),
            ...(input.coverUrl === undefined ? {} : { cover_url: input.coverUrl }),
          })
          .select(LISTING_COLUMNS)
          .single()
        if (error) {
          if (error.code === '23505' && n < attempts) continue
          return fail(errorCode(error), error.code === '23505' ? 'That address is taken' : error.message)
        }
        const [listing] = await hydrate([listingRow.parse(data)], mine.me)
        return listing ? ok(listing) : fail('unavailable', 'The listing was created but could not be read back')
      }
      return fail('conflict', 'That address is taken')
    },

    async updateListing(id, patch) {
      const me = await uid()
      if (!me) return fail('not_signed_in', 'Sign in first')
      if (patch.coverUrl != null && !HTTPS.test(patch.coverUrl)) return fail('invalid', 'The cover must be an https address')
      const payload = {
        ...(patch.slug === undefined ? {} : { slug: patch.slug }),
        ...(patch.title === undefined ? {} : { title: patch.title.trim() }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.license === undefined ? {} : { license: patch.license }),
        ...(patch.tags === undefined ? {} : { tags: patch.tags }),
        ...(patch.coverUrl === undefined ? {} : { cover_url: patch.coverUrl }),
      }
      const q = Object.keys(payload).length === 0 ? sb.from('listings').select(LISTING_COLUMNS).eq('id', id) : sb.from('listings').update(payload).eq('id', id).select(LISTING_COLUMNS)
      const { data, error } = await q
      if (error) return failed(error)
      const row = rows(listingRow, data)[0]
      if (!row) return fail('not_found', 'no such listing')
      const [listing] = await hydrate([row], me)
      return listing ? ok(listing) : fail('unavailable', 'The listing was saved but could not be read back')
    },

    archiveListing: (id) => setStatus(id, 'archived'),
    unarchiveListing: (id) => setStatus(id, 'approved'),
    resubmitListing: (id) => setStatus(id, 'pending'),

    async deleteListing(id) {
      const { error, count } = await sb.from('listings').delete({ count: 'exact' }).eq('id', id)
      if (error) return failed(error)
      return count === 0 ? fail('forbidden', 'Only your own pending, rejected or archived models can be deleted') : ok(undefined)
    },

    async like(listingId) {
      const me = await uid()
      if (!me) return fail('not_signed_in', 'Sign in first')
      return done(sb.from('likes').upsert({ user_id: me, listing_id: listingId }, { onConflict: 'user_id,listing_id', ignoreDuplicates: true }))
    },

    async unlike(listingId) {
      const me = await uid()
      if (!me) return fail('not_signed_in', 'Sign in first')
      return done(sb.from('likes').delete().eq('user_id', me).eq('listing_id', listingId))
    },

    async comments(listingId) {
      const found = await read(commentRow, sb.from('comments').select(COMMENT_COLUMNS).eq('listing_id', listingId).order('created_at', { ascending: true }))
      const authors = await profilesById(found.map((c) => c.user_id))
      return found.map((c) => toComment(c, c.user_id ? authors.get(c.user_id) : undefined))
    },

    async addComment(listingId, body, parentId) {
      const me = await uid()
      if (!me) return fail('not_signed_in', 'Sign in first')
      const text = body.trim()
      if (text.length < 1 || text.length > 4000) return fail('invalid', 'Comments are 1 to 4000 characters')
      const { data, error } = await sb
        .from('comments')
        .insert({ listing_id: listingId, user_id: me, body: text, ...(parentId === undefined ? {} : { parent_id: parentId }) })
        .select(COMMENT_COLUMNS)
        .single()
      if (error) return failed(error)
      const row = commentRow.parse(data)
      return ok(toComment(row, (await profilesById([me])).get(me)))
    },

    async editComment(id, body) {
      const me = await uid()
      if (!me) return fail('not_signed_in', 'Sign in first')
      const text = body.trim()
      if (text.length < 1 || text.length > 4000) return fail('invalid', 'Comments are 1 to 4000 characters')
      const { data, error } = await sb.from('comments').update({ body: text, edited_at: 'now' }).eq('id', id).eq('user_id', me).select(COMMENT_COLUMNS)
      if (error) return failed(error)
      const row = rows(commentRow, data)[0]
      return row ? ok(toComment(row, (await profilesById([me])).get(me))) : fail('not_found', 'no such comment')
    },

    async deleteComment(id) {
      if (!(await uid())) return fail('not_signed_in', 'Sign in first')
      // Soft delete through the function: the author or staff (staff deletions are logged).
      return done(sb.rpc('delete_comment', { p_comment: id }))
    },

    async makes(listingId) {
      const found = await read(makeRow, sb.from('makes').select(MAKE_COLUMNS).eq('listing_id', listingId).order('created_at', { ascending: true }))
      const authors = await profilesById(found.map((m) => m.user_id))
      return found.map((m) => toMake(m, authors.get(m.user_id)))
    },

    async addMake(listingId, input) {
      const me = await uid()
      if (!me) return fail('not_signed_in', 'Sign in first')
      if (input.photoUrl !== undefined && !HTTPS.test(input.photoUrl)) return fail('invalid', 'The photo must be an https address')
      const { data, error } = await sb
        .from('makes')
        .insert({
          listing_id: listingId,
          user_id: me,
          ...(input.caption === undefined ? {} : { caption: input.caption }),
          ...(input.photoUrl === undefined ? {} : { photo_url: input.photoUrl }),
          ...(input.printerModel === undefined ? {} : { printer_model: input.printerModel }),
        })
        .select(MAKE_COLUMNS)
        .single()
      if (error) return failed(error)
      return ok(toMake(makeRow.parse(data), (await profilesById([me])).get(me)))
    },

    async collections() {
      const me = await uid()
      if (!me) return []
      // The Saved list is a collection of kind 'saved' and stays out of this list.
      const mine = (await read(collectionRow, sb.from('collections').select('*').eq('owner_id', me).order('created_at'))).filter((c) => c.kind !== 'saved')
      if (mine.length === 0) return []
      const items = await read(collectionItemRow, sb.from('collection_items').select('*').in('collection_id', mine.map((c) => c.id)))
      return mine.map((c) =>
        toCollection(
          c,
          items.filter((i) => i.collection_id === c.id).map((i) => i.listing_id),
        ),
      )
    },

    async createCollection(name, isPublic = false) {
      const me = await uid()
      if (!me) return fail('not_signed_in', 'Sign in first')
      const n = name.trim()
      if (n.length < 1 || n.length > 80) return fail('invalid', 'Collection names are 1 to 80 characters')
      const { data, error } = await sb.from('collections').insert({ owner_id: me, name: n, is_public: isPublic }).select('*').single()
      return error ? failed(error) : ok(toCollection(collectionRow.parse(data), []))
    },

    async setInCollection(collectionId, listingId, present) {
      if (!(await uid())) return fail('not_signed_in', 'Sign in first')
      return present
        ? done(sb.from('collection_items').upsert({ collection_id: collectionId, listing_id: listingId }, { onConflict: 'collection_id,listing_id', ignoreDuplicates: true }))
        : done(sb.from('collection_items').delete().eq('collection_id', collectionId).eq('listing_id', listingId))
    },

    async follow(creatorId) {
      const me = await uid()
      if (!me) return fail('not_signed_in', 'Sign in first')
      return done(sb.from('follows').upsert({ user_id: me, creator_id: creatorId }, { onConflict: 'user_id,creator_id', ignoreDuplicates: true }))
    },

    async unfollow(creatorId) {
      const me = await uid()
      if (!me) return fail('not_signed_in', 'Sign in first')
      return done(sb.from('follows').delete().eq('user_id', me).eq('creator_id', creatorId))
    },

    async listingStats(listingIds) {
      return Object.fromEntries(await statsFor(listingIds))
    },

    async printProfiles(versionId) {
      return (await read(printProfileRow, sb.from('print_profiles').select('*').eq('version_id', versionId))).map(toPrintProfile)
    },

    async files(versionId) {
      return (await read(fileRow, sb.from('listing_files').select('*').eq('version_id', versionId))).map(toFile)
    },

    async download(listingId) {
      if (!(await uid())) {
        // Signed out: the server checks the listing, counts the download against the
        // per-network limit and returns a short grant for a direct storage read.
        const res = await sb.rpc('request_download', { p_listing: listingId })
        if (res.error) return failed(res.error)
        const g = grantRow.safeParse(res.data)
        if (!g.success || !g.data.grant || !conn) return fail('unavailable', 'The download could not be started')
        const path = g.data.path.split('/').map(encodeURIComponent).join('/')
        return ok({
          url: `${conn.url.replace(/\/$/, '')}/storage/v1/object/authenticated/listing-files/${path}`,
          headers: { apikey: conn.anonKey, Authorization: `Bearer ${conn.anonKey}`, 'x-sx-download-grant': g.data.grant },
          versionId: g.data.version_id,
          version: g.data.version,
          fileName: g.data.path.split('/').pop() ?? g.data.path,
        })
      }
      const clean = await read(
        versionRow,
        sb.from('listing_versions').select(VERSION_COLUMNS).eq('listing_id', listingId).eq('review_status', 'approved').eq('scan_status', 'clean'),
      )
      const v = latestVersion(clean)
      if (!v) return fail('not_found', 'This model has no approved file yet')
      const counted = await sb.rpc('record_download', { p_listing: listingId })
      if (counted.error) return failed(counted.error)
      const signed = await sb.storage.from('listing-files').createSignedUrl(v.storage_path, 300)
      if (signed.error) return fail('unavailable', signed.error.message)
      return ok({ url: signed.data.signedUrl, versionId: v.id, version: v.version, fileName: v.storage_path.split('/').pop() ?? v.storage_path })
    },

    // Upload -------------------------------------------------------------------------
    async uploadVersion(listingId, input) {
      // Everything that needs no network is checked first.
      // The limit and formats come from the library settings when they can be read.
      const rules = await librarySettings()
      const pre = validateUpload({ name: input.name, version: input.version, format: input.format, size: input.bytes.length }, { maxFileMb: rules.maxFileMb, allowedFormats: rules.allowedFormats })
      if (!pre.ok) return fail('invalid', pre.message)
      if (input.changelog !== undefined && input.changelog.length > 4000) return fail('invalid', 'Changelogs can be at most 4000 characters')
      if (!(await uid())) return fail('not_signed_in', 'Sign in first')
      const sha = await sha256Hex(input.bytes)

      // An earlier attempt that never finished uploading can be picked up again.
      const earlier = (await read(versionRow, sb.from('listing_versions').select(VERSION_COLUMNS).eq('listing_id', listingId).eq('version', input.version)))[0]
      let row: VersionRow
      if (earlier) {
        if (earlier.scan_status !== 'uploading' || earlier.sha256 !== sha) return fail('conflict', 'That version already exists; publish a new version number')
        row = earlier
      } else {
        const id = crypto.randomUUID()
        const { data, error } = await sb
          .from('listing_versions')
          .insert({
            id,
            listing_id: listingId,
            version: input.version,
            storage_path: `${listingId}/${id}/${input.name}`,
            sha256: sha,
            format: input.format,
            size_bytes: input.bytes.length,
            ...(input.changelog === undefined ? {} : { changelog: input.changelog }),
          })
          .select(VERSION_COLUMNS)
          .single()
        if (error) return failed(error)
        row = versionRow.parse(data)
      }

      const up = await sb.storage.from('uploads-quarantine').upload(row.storage_path, input.bytes, { contentType: 'application/octet-stream', upsert: false })
      // "Already exists" means an earlier attempt got the file there; go on to submit it.
      if (up.error && !/already exists|duplicate/i.test(up.error.message)) return fail('unavailable', up.error.message)
      const submitted = await sb.rpc('submit_version', { p_version: row.id })
      if (submitted.error) return failed(submitted.error)
      const after = (await read(versionRow, sb.from('listing_versions').select(VERSION_COLUMNS).eq('id', row.id)))[0]
      return ok(toVersion(after ?? { ...row, scan_status: 'queued' }))
    },

    async getScanStatus(versionId) {
      const { data, error } = await sb.from('listing_versions').select('scan_status, review_status').eq('id', versionId)
      if (error) return failed(error)
      const r = rows(z.object({ scan_status: versionRow.shape.scan_status, review_status: versionRow.shape.review_status }), data)[0]
      return r ? ok({ scanStatus: r.scan_status, reviewStatus: r.review_status }) : fail('not_found', 'no such version')
    },

    async getScanReport(versionId) {
      const { data, error } = await sb.rpc('version_scan_report', { p_version: versionId })
      if (error) return failed(error)
      const report = z.record(z.string(), z.unknown()).safeParse(data)
      return ok(report.success ? report.data : null)
    },

    // Creator ------------------------------------------------------------------------
    async getMyCreator() {
      const me = await uid()
      if (!me) return null
      const row = await ownCreatorRow(me)
      return row ? ((await creatorsById([row.id], me)).get(row.id) ?? null) : null
    },

    async saveCreator(input) {
      const me = await uid()
      if (!me) return fail('not_signed_in', 'Sign in first')
      const h = validateHandle(input.handle)
      if (!h.ok) return fail('invalid', h.message)
      if (input.logoUrl != null && !HTTPS.test(input.logoUrl)) return fail('invalid', 'The logo must be an https address')
      if (input.bannerUrl != null && !HTTPS.test(input.bannerUrl)) return fail('invalid', 'The banner must be an https address')
      const fields = {
        handle: input.handle,
        display_name: input.displayName.trim(),
        ...(input.tagline === undefined ? {} : { tagline: input.tagline }),
        ...(input.bio === undefined ? {} : { bio: input.bio }),
        ...(input.location === undefined ? {} : { location: input.location }),
        ...(input.logoUrl === undefined ? {} : { logo_url: input.logoUrl }),
        ...(input.bannerUrl === undefined ? {} : { banner_url: input.bannerUrl }),
        ...(input.status === undefined ? {} : { status: input.status }),
      }
      const existing = await ownCreatorRow(me)
      const { data, error } = existing
        ? await sb.from('creators').update(fields).eq('id', existing.id).select(CREATOR_COLUMNS).single()
        : await sb.from('creators').insert({ owner_id: me, ...fields }).select(CREATOR_COLUMNS).single()
      if (error) return fail(errorCode(error), error.code === '23505' ? 'That handle is taken' : error.message)
      const row = creatorRow.parse(data)
      if (input.logoUrl !== undefined || input.bannerUrl !== undefined) await pruneCreatorImages(me, [row.logo_url, row.banner_url ?? null])
      const creator = (await creatorsById([row.id], me)).get(row.id)
      return creator ? ok(creator) : fail('unavailable', 'The page was saved but could not be read back')
    },

    async setCreatorLinks(links) {
      const mine = await needCreator()
      if (isFailure(mine)) return mine
      const checked = validateCreatorLinks(links)
      if (!checked.ok) return fail('invalid', checked.message)
      const next = checked.value.map((l, position) => ({ creator_id: mine.creator.id, kind: l.kind, url: l.url, position, ...(l.label ? { label: l.label } : {}) }))
      const r = await replaceRows('creator_links', mine.creator.id, next)
      if (!r.ok) return r
      const saved = await read(creatorLinkRow, sb.from('creator_links').select(LINK_COLUMNS).eq('creator_id', mine.creator.id).order('position'))
      return ok(saved.map(toCreatorLink))
    },

    async uploadCreatorImage(input) {
      const mine = await needCreator()
      if (isFailure(mine)) return mine
      const ext = IMAGE_TYPES[input.contentType]
      if (!ext) return fail('invalid', 'Use a PNG, JPEG or WebP image')
      if (input.bytes.byteLength > MAX_IMAGE_BYTES) return fail('invalid', 'Images can be at most 5 MB')
      const rand = crypto.getRandomValues(new Uint8Array(6)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')
      const path = `${mine.me}/${input.kind}-${rand}.${ext}`
      const up = await sb.storage.from('creator-media').upload(path, input.bytes, { contentType: input.contentType, upsert: false, cacheControl: '31536000' })
      if (up.error) return fail('invalid', up.error.message)
      return ok(sb.storage.from('creator-media').getPublicUrl(path).data.publicUrl)
    },

    async setFeatured(listingIds) {
      const mine = await needCreator()
      if (isFailure(mine)) return mine
      if (listingIds.length > 6) return fail('invalid', 'Feature at most 6 models')
      if (new Set(listingIds).size !== listingIds.length) return fail('invalid', 'A model can be featured once')
      return replaceRows(
        'creator_featured',
        mine.creator.id,
        listingIds.map((listing_id, i) => ({ creator_id: mine.creator.id, listing_id, position: i + 1 })),
      )
    },

    async listCreatorListings(handle) {
      return (await this.getCreatorByHandle(handle))?.listings ?? []
    },

    async getCreatorByHandle(handle) {
      const row = (await read(creatorRow, sb.from('creators').select(CREATOR_COLUMNS).eq('handle', handle)))[0]
      if (!row) return null
      const me = await uid()
      const [creators, links, featuredRows, approved] = await Promise.all([
        creatorsById([row.id], me, true),
        read(creatorLinkRow, sb.from('creator_links').select(LINK_COLUMNS).eq('creator_id', row.id).order('position')),
        read(creatorFeaturedRow, sb.from('creator_featured').select('creator_id, listing_id, position').eq('creator_id', row.id).order('position')),
        read(listingRow, sb.from('listings').select(LISTING_COLUMNS).eq('creator_id', row.id).eq('status', 'approved').order('published_at', { ascending: false, nullsFirst: false })),
      ])
      const creator = creators.get(row.id)
      if (!creator) return null
      const hydrated = await hydrate(approved, me)
      const byId = new Map(hydrated.map((l) => [l.id, l]))
      const page: CreatorPage = {
        creator,
        links: links.map(toCreatorLink),
        featured: featuredRows.flatMap((f) => byId.get(f.listing_id) ?? []),
        listings: hydrated,
      }
      return page
    },

    async listCreators(o = {}) {
      const me = await uid()
      const limit = Math.min(Math.max(o.limit ?? 50, 1), 200)
      let q = sb.from('creators').select(CREATOR_COLUMNS).eq('status', 'active').order('created_at', { ascending: false }).limit(200)
      const term = o.query ? cleanTerm(o.query) : ''
      if (term) q = q.or(`handle.ilike.%${term}%,display_name.ilike.%${term}%,tagline.ilike.%${term}%`)
      const found = await read(creatorRow, q)
      const creators = await creatorsById(found.map((c) => c.id), me, true)
      // Only creators with an approved listing, unless the caller is staff or the creator.
      const staff = me ? ['owner', 'moderator'].includes(String((await sb.rpc('my_role')).data)) : false
      const shown = [...creators.values()].filter((c) => staff || c.ownerId === me || (c.listingCount ?? 0) > 0)
      return shown.sort((a, b) => b.followers - a.followers || a.displayName.localeCompare(b.displayName)).slice(0, limit)
    },

    async creatorDashboard() {
      if (!(await uid())) return fail('not_signed_in', 'Sign in first')
      const { data, error } = await sb.rpc('creator_dashboard')
      return error ? failed(error) : ok(rows(dashboardRow, data).map(toDashboardRow))
    },

    // Moderation ---------------------------------------------------------------------
    async moderationQueue() {
      if (!(await uid())) return fail('not_signed_in', 'Sign in first')
      const { data, error } = await sb.from('moderation_queue').select('*')
      return error ? failed(error) : ok(rows(queueRow, data).map(toModerationItem))
    },

    async approveListing(id, note) {
      return done(sb.rpc('approve_listing', { p_listing: id, ...(note === undefined ? {} : { p_note: note }) }))
    },

    async rejectListing(id, reason) {
      if (reason.trim().length < 3) return fail('invalid', 'give the creator a reason')
      return done(sb.rpc('reject_listing', { p_listing: id, p_reason: reason.trim() }))
    },

    async removeListing(id, reason) {
      if (reason.trim().length < 3) return fail('invalid', 'give the creator a reason')
      return done(sb.rpc('remove_listing', { p_listing: id, p_reason: reason.trim() }))
    },

    async banUser(userId, reason) {
      if (reason.trim().length < 3) return fail('invalid', 'give a reason for the ban')
      return done(sb.rpc('ban_user', { p_user: userId, p_reason: reason.trim() }))
    },

    async unbanUser(userId, reason) {
      return done(sb.rpc('unban_user', { p_user: userId, ...(reason === undefined ? {} : { p_reason: reason }) }))
    },

    async auditLog(o = {}) {
      if (!(await uid())) return fail('not_signed_in', 'Sign in first')
      const limit = Math.min(Math.max(o.limit ?? 50, 1), 200)
      let q = sb.from('audit_log').select('id, at, actor_id, action, target_kind, target_id, reason, detail').order('id', { ascending: false }).limit(limit)
      if (o.before !== undefined) q = q.lt('id', o.before)
      const { data, error } = await q
      return error ? failed(error) : ok(rows(auditRow, data).map(toAudit))
    },

    async getModerationMode() {
      return (await librarySettings()).moderationMode
    },

    getLibrarySettings: librarySettings,

    async setModerationMode(mode) {
      return done(sb.rpc('set_moderation_mode', { p_mode: mode }))
    },

    async setUserRole(userId, role, reason) {
      return done(sb.rpc('set_user_role', { p_user: userId, p_role: role, ...(reason === undefined ? {} : { p_reason: reason }) }))
    },

    async setCreatorTrusted(creatorId, trusted) {
      return done(sb.rpc('set_creator_trusted', { p_creator: creatorId, p_trusted: trusted }))
    },

    async myRole() {
      if (!(await uid())) return null
      const { data, error } = await sb.rpc('my_role')
      const r = z.enum(['owner', 'moderator', 'creator', 'member', 'banned']).safeParse(data)
      return error || !r.success ? null : r.data
    },
  }
  return client
}

/** Supabase options; kept under the old name for existing callers. */
export type SupabaseStoreOptions = SupabaseOptions

export function createSupabaseStore(opts: SupabaseOptions): StoreClient {
  const sb = createSupabaseClient(opts)
  return { ...supabaseAuth(sb, opts), ...supabaseStore(sb, opts) }
}
