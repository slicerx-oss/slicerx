// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Offline StoreClient over the bundled seed, for the browser demo and tests.
// It applies the same rules as the database (policies, triggers and the
// moderation functions), in memory: listings start pending, only staff who may
// moderate in the current mode approve, a rejection needs a reason, every
// decision is audited, and banned members cannot act.
import type {
  AuthClient,
  Collection,
  Comment,
  Creator,
  CreatorLink,
  CreatorPage,
  DashboardRow,
  EffectiveRole,
  FeedItem,
  FileFormat,
  Listing,
  ListingCard,
  ListingStats,
  ListingVersion,
  Make,
  LibrarySettings,
  ModerationMode,
  StoreClient,
  StoreErrorCode,
  StoreResult,
} from '@slicerx/contracts'
import { createOfflineContext, offlineAuth, type OfflineContext, type OfflineOptions } from './auth/offline'
import { latestVersion, toAudit, toCollection, toComment, toCreator, toCreatorLink, toFile, toListing, toMake, toModerationItem, toPrintProfile, toVersion } from './map'
import { LICENSES, MODERATION_MODES, type CommentRow, type CreatorRow, type ListingRow, type SeedData, type VersionRow } from './rows'
import { newCreatorIds, recommendedScores, trendingScores } from './ranking'
import { DEFAULT_MAX_FILE_MB, MAX_FEATURED, slugify, validateCreatorLinks, validateHandle, validateUpload } from './validate'

export type { OfflineOptions } from './auth/offline'

/** A failure inside an offline operation, turned into a StoreResult at the edge. */
class Fail extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
  ) {
    super(message)
  }
}
function bad(code: StoreErrorCode, message: string): never {
  throw new Fail(code, message)
}

/** What one call knows about who is asking. */
interface Cx {
  d: SeedData
  uid: string | null
  role: EffectiveRole | null
}

const HTTPS = /^https:\/\/[^\s<>"']{4,500}$/i
/** Offline only: uploaded creator images stay in memory as data URLs. */
const IMAGE = /^(https:\/\/[^\s<>"']{4,500}|data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+)$/i
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const MAX_IMAGE_BYTES = 5_242_880
const SLUG = /^[a-z0-9][a-z0-9-]{1,80}$/
const MAX_PENDING = 20

const isStaff = (role: EffectiveRole | null) => role === 'owner' || role === 'moderator'

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The upload scan, reduced to what can be checked in memory: the file signature. */
function scanBytes(bytes: Uint8Array, format: string): string | null {
  if (format === '3mf' || format === 'sx3mf') {
    return bytes[0] === 0x50 && bytes[1] === 0x4b ? null : 'The file is not a zip archive'
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 5))
  if (head === 'solid') return null
  if (bytes.length >= 84) {
    const triangles = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true)
    if (bytes.length === 84 + 50 * triangles) return null
  }
  return 'The file is not a valid STL'
}

/** The store part of an offline client, sharing a context with offlineAuth. */
export function offlineStore(ctx: OfflineContext): Omit<StoreClient, keyof AuthClient> {
  const now = () => ctx.now().toISOString()
  const newId = () => ctx.newId()

  async function cx(): Promise<Cx> {
    const [d, uid] = await Promise.all([ctx.db(), ctx.currentUser()])
    return { d, uid, role: await ctx.roleOf(uid) }
  }

  /** Runs an operation and turns a Fail into a failed StoreResult. */
  async function run<T>(fn: (c: Cx) => T | Promise<T>): Promise<StoreResult<T>> {
    try {
      return { ok: true, value: await fn(await cx()) }
    } catch (e) {
      if (e instanceof Fail) return { ok: false, code: e.code, message: e.message }
      throw e
    }
  }

  const signedIn = (c: Cx): string => c.uid ?? bad('not_signed_in', 'Sign in first')
  /** Signed in and not banned. */
  const active = (c: Cx): string => {
    const uid = signedIn(c)
    if (c.role === 'banned') bad('forbidden', 'This account is banned')
    return uid
  }
  const ownCreator = (c: Cx): CreatorRow | undefined => (c.uid ? c.d.creators.find((x) => x.owner_id === c.uid) : undefined)
  const requireCreator = (c: Cx): CreatorRow => {
    active(c)
    return ownCreator(c) ?? bad('forbidden', 'Make your creator page first')
  }
  const ownerBanned = (c: Cx, creator: CreatorRow) => c.d.profiles.find((p) => p.id === creator.owner_id)?.banned_at != null
  const settings = (d: SeedData) => d.library_settings[0] ?? { id: true, moderation_mode: 'owner-approves-all' as ModerationMode, max_file_mb: DEFAULT_MAX_FILE_MB, allowed_formats: ['3mf', 'sx3mf', 'stl'] as FileFormat[] }
  const canModerate = (c: Cx) => (settings(c.d).moderation_mode === 'owner-approves-all' ? c.role === 'owner' : isStaff(c.role))

  const creatorVisible = (c: Cx, cr: CreatorRow) => (cr.status === 'active' && !ownerBanned(c, cr)) || cr.owner_id === c.uid || isStaff(c.role)
  const isOwnListing = (c: Cx, l: ListingRow) => c.uid !== null && c.d.creators.some((x) => x.id === l.creator_id && x.owner_id === c.uid)
  const canEdit = (c: Cx, l: ListingRow) => isOwnListing(c, l) && c.role !== 'banned'
  const listingVisible = (c: Cx, l: ListingRow) => {
    if (isStaff(c.role) || isOwnListing(c, l)) return true
    const cr = c.d.creators.find((x) => x.id === l.creator_id)
    return l.status === 'approved' && cr !== undefined && cr.status === 'active' && !ownerBanned(c, cr)
  }
  const versionVisible = (c: Cx, v: VersionRow) => {
    const l = c.d.listings.find((x) => x.id === v.listing_id)
    return l !== undefined && listingVisible(c, l) && (v.review_status === 'approved' || canEdit(c, l) || isStaff(c.role))
  }
  const findListing = (c: Cx, id: string): ListingRow => c.d.listings.find((x) => x.id === id) ?? bad('not_found', 'no such listing')
  const visibleListing = (c: Cx, id: string): ListingRow => {
    const l = c.d.listings.find((x) => x.id === id)
    return l && listingVisible(c, l) ? l : bad('not_found', 'no such listing')
  }

  function audit(c: Cx, action: string, kind: 'user' | 'listing' | 'version' | 'creator' | 'comment' | 'setting', target: string | null, reason: string | null, detail: Record<string, unknown> = {}, actor: string | null = c.uid) {
    const id = c.d.audit_log.reduce((m, r) => Math.max(m, r.id), 0) + 1
    c.d.audit_log.push({ id, at: now(), actor_id: actor, action, target_kind: kind, target_id: target, reason, detail })
  }

  function statsOf(d: SeedData, listingId: string): ListingStats {
    return {
      likes: d.likes.filter((r) => r.listing_id === listingId).length,
      makes: d.makes.filter((r) => r.listing_id === listingId).length,
      comments: d.comments.filter((r) => r.listing_id === listingId && r.deleted_at === null).length,
      downloads: d.downloads.filter((r) => r.listing_id === listingId).reduce((n, r) => n + r.count, 0),
    }
  }

  const followersOf = (d: SeedData, creatorId: string) => d.follows.filter((f) => f.creator_id === creatorId).length
  const creatorOut = (c: Cx, cr: CreatorRow, withCount = false): Creator =>
    toCreator(cr, followersOf(c.d, cr.id), {
      ...(withCount ? { listingCount: c.d.listings.filter((l) => l.creator_id === cr.id && l.status === 'approved').length } : {}),
      ...(c.uid ? { followedByMe: c.d.follows.some((f) => f.user_id === c.uid && f.creator_id === cr.id) } : {}),
    })

  const versionsOf = (c: Cx, listingId: string): ListingVersion[] => {
    const rows = c.d.listing_versions.filter((v) => v.listing_id === listingId && versionVisible(c, v))
    return [...rows]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((v) => toVersion(v, c.d.print_profiles.filter((p) => p.version_id === v.id)))
  }

  function listingOut(c: Cx, l: ListingRow): Listing {
    const versions = c.d.listing_versions.filter((v) => v.listing_id === l.id && versionVisible(c, v))
    const latest = latestVersion(versions)
    return toListing(l, {
      stats: statsOf(c.d, l.id),
      ...(latest ? { currentVersion: toVersion(latest, c.d.print_profiles.filter((p) => p.version_id === latest.id)) } : {}),
      ...(c.uid ? { likedByMe: c.d.likes.some((x) => x.user_id === c.uid && x.listing_id === l.id) } : {}),
      ...(c.uid ? { savedByMe: savedIds(c).has(l.id) } : {}),
    })
  }

  const savedList = (c: Cx) => (c.uid ? c.d.collections.find((x) => x.owner_id === c.uid && x.kind === 'saved') : undefined)
  function savedIds(c: Cx): Set<string> {
    const list = savedList(c)
    return new Set(list ? c.d.collection_items.filter((i) => i.collection_id === list.id).map((i) => i.listing_id) : [])
  }

  /**
   * The ranking clock. The bundled catalog is dated, so its rows rank against
   * its own latest activity rather than an empty week; activity made in this
   * session moves the clock up to the real time.
   */
  function rankNow(c: Cx): Date {
    const real = ctx.now().getTime()
    let latest = 0
    for (const t of [...c.d.likes.map((x) => x.created_at), ...c.d.makes.map((x) => x.created_at), ...c.d.downloads.map((x) => x.last_at), ...c.d.listings.map((x) => x.published_at ?? '')]) {
      const ms = t ? Date.parse(t) : 0
      if (ms > latest) latest = ms
    }
    return new Date(latest > 0 ? Math.min(real, latest) : real)
  }
  const visibleApproved = (c: Cx) => c.d.listings.filter((l) => l.status === 'approved' && listingVisible(c, l))
  const cardsFor = (c: Cx, ids: string[]) => ids.flatMap((id) => {
    const l = c.d.listings.find((x) => x.id === id)
    return l ? (cardOf(c, l) ?? []) : []
  })

  const cardOf = (c: Cx, l: ListingRow): ListingCard | null => {
    const cr = c.d.creators.find((x) => x.id === l.creator_id)
    return cr ? { listing: listingOut(c, l), creator: creatorOut(c, cr) } : null
  }

  const author = (d: SeedData, id: string | null) => {
    const p = id ? d.profiles.find((x) => x.id === id) : undefined
    return p ? { id: p.id, handle: p.handle, displayName: p.display_name } : undefined
  }

  /** Leaves the approved state: the listing stops being featured. */
  function setStatus(c: Cx, l: ListingRow, status: ListingRow['status']) {
    if (l.status === 'approved' && status !== 'approved') c.d.creator_featured = c.d.creator_featured.filter((f) => f.listing_id !== l.id)
    l.status = status
  }

  function dropListing(c: Cx, id: string) {
    const d = c.d
    const versionIds = new Set(d.listing_versions.filter((v) => v.listing_id === id).map((v) => v.id))
    d.listings = d.listings.filter((l) => l.id !== id)
    d.listing_versions = d.listing_versions.filter((v) => v.listing_id !== id)
    d.listing_files = d.listing_files.filter((f) => !versionIds.has(f.version_id))
    d.print_profiles = d.print_profiles.filter((p) => !versionIds.has(p.version_id))
    d.creator_featured = d.creator_featured.filter((f) => f.listing_id !== id)
    d.likes = d.likes.filter((r) => r.listing_id !== id)
    d.comments = d.comments.filter((r) => r.listing_id !== id)
    d.makes = d.makes.filter((r) => r.listing_id !== id)
    d.collection_items = d.collection_items.filter((r) => r.listing_id !== id)
    d.downloads = d.downloads.filter((r) => r.listing_id !== id)
  }

  function checkListingFields(input: { slug?: string; title?: string; description?: string | null; license?: string; tags?: string[]; coverUrl?: string | null }) {
    if (input.title !== undefined && (input.title.trim().length < 1 || input.title.length > 120)) bad('invalid', 'Titles are 1 to 120 characters')
    if (input.slug !== undefined && !SLUG.test(input.slug)) bad('invalid', 'Use lowercase letters, digits and hyphens for the address')
    if (input.description != null && input.description.length > 8000) bad('invalid', 'Descriptions can be at most 8000 characters')
    if (input.license !== undefined && !(LICENSES as readonly string[]).includes(input.license)) bad('invalid', 'Unknown license')
    if (input.tags !== undefined && input.tags.length > 20) bad('invalid', 'A listing has at most 20 tags')
    if (input.coverUrl != null && !HTTPS.test(input.coverUrl)) bad('invalid', 'The cover must be an https address')
  }

  function page<T>(rows: readonly T[], cursor: string | undefined, limit: number | undefined) {
    const start = Number(cursor ?? 0) || 0
    const size = Math.min(Math.max(limit ?? 20, 1), 100)
    const items = rows.slice(start, start + size)
    return { items, next: start + size < rows.length ? String(start + size) : undefined }
  }

  const withNext = <I>(p: { items: I[]; next: string | undefined }): { items: I[]; next?: string } => (p.next === undefined ? { items: p.items } : { items: p.items, next: p.next })

  function listRows(c: Cx, o: { tag?: string | undefined; creatorId?: string | undefined; query?: string | undefined; sort?: 'new' | 'popular' | undefined; status?: string | undefined }): ListingRow[] {
    const q = o.query?.trim().toLowerCase()
    const rows = c.d.listings.filter(
      (l) =>
        l.status === (o.status ?? 'approved') &&
        listingVisible(c, l) &&
        (!o.tag || l.tags.includes(o.tag)) &&
        (!o.creatorId || l.creator_id === o.creatorId) &&
        (!q || l.title.toLowerCase().includes(q) || l.tags.some((t) => t.includes(q))),
    )
    const when = (l: ListingRow) => l.published_at ?? l.created_at
    if (o.sort === 'popular') {
      const score = (l: ListingRow) => {
        const s = statsOf(c.d, l.id)
        return s.likes + s.downloads
      }
      return rows.sort((a, b) => score(b) - score(a) || when(b).localeCompare(when(a)))
    }
    return rows.sort((a, b) => when(b).localeCompare(when(a)))
  }

  /** The scan finishing, as the service would report it. Offline this happens at once. */
  function finishScan(c: Cx, v: VersionRow, l: ListingRow, cr: CreatorRow, sizeBytes: number, failure: string | null) {
    v.scanned_at = now()
    if (failure === null) {
      v.scan_status = 'clean'
      v.scan_report = { ok: true, checks: ['extension', 'signature', 'size'], size_bytes: sizeBytes }
      c.d.listing_files.push({ id: newId(), version_id: v.id, name: v.storage_path.split('/').pop() ?? v.storage_path, role: 'model', format: v.format, size_bytes: sizeBytes, sha256: v.sha256 })
      const mode = settings(c.d).moderation_mode
      const trusted = (mode === 'auto-after-scan' || (mode === 'trusted-creators' && cr.trusted)) && !ownerBanned(c, cr)
      const waitingUnclean = c.d.listing_versions.some((x) => x.listing_id === l.id && x.review_status === 'pending' && x.scan_status !== 'clean')
      if (trusted && !waitingUnclean && (l.status === 'pending' || l.status === 'approved')) {
        for (const x of c.d.listing_versions) if (x.listing_id === l.id && x.review_status === 'pending') x.review_status = 'approved'
        l.status = 'approved'
        l.review_note = null
        l.reviewed_at = now()
        l.published_at ??= now()
        audit(c, 'auto_approve', 'listing', l.id, null, { title: l.title, creator: cr.handle }, null)
      }
    } else {
      v.scan_status = 'rejected'
      v.review_status = 'rejected'
      v.scan_report = { ok: false, reason: failure }
      if (l.status === 'pending' && !c.d.listing_versions.some((x) => x.listing_id === l.id && x.review_status !== 'rejected')) {
        l.status = 'rejected'
        l.review_note = 'A file failed the upload checks. See the scan report on the version.'
        l.reviewed_at = now()
      }
      audit(c, 'scan_reject', 'version', v.id, failure, { listing: l.id }, null)
    }
  }

  const client: Omit<StoreClient, keyof AuthClient> = {
    // Library ------------------------------------------------------------------------
    async listListings(o = {}) {
      const c = await cx()
      const p = page(listRows(c, o), o.cursor, o.limit)
      return withNext({ items: p.items.flatMap((l) => cardOf(c, l) ?? []), next: p.next })
    },

    async feed(o = {}) {
      const c = await cx()
      const followed = new Set(c.uid ? c.d.follows.filter((f) => f.user_id === c.uid).map((f) => f.creator_id) : [])
      const p = page(listRows(c, { tag: o.category, sort: 'new' }), o.cursor, o.limit)
      const items = p.items.flatMap((l): FeedItem[] => {
        const card = cardOf(c, l)
        if (!card) return []
        const s = card.listing.stats
        const reason = followed.has(l.creator_id) ? 'following' : s && s.likes + s.makes >= 8 ? 'popular' : 'new'
        return [{ ...card, reason, makes: s?.makes ?? 0 }]
      })
      return withNext({ items, next: p.next })
    },

    async trending(o = {}) {
      const c = await cx()
      const scored = trendingScores({ listings: visibleApproved(c), likes: c.d.likes, makes: c.d.makes, downloads: c.d.downloads }, rankNow(c), o)
      return cardsFor(c, scored.map((x) => x.listingId))
    },

    async newCreators(o = {}) {
      const c = await cx()
      const visible = c.d.creators.filter((cr) => cr.status === 'active' && !ownerBanned(c, cr))
      const found = newCreatorIds({ creatorIds: visible.map((cr) => cr.id), listings: c.d.listings }, rankNow(c), o)
      return found.flatMap(({ creatorId }) => {
        const cr = c.d.creators.find((x) => x.id === creatorId)
        return cr ? [creatorOut(c, cr, true)] : []
      })
    },

    async recommended(o = {}) {
      const c = await cx()
      if (!c.uid) return []
      const likedIds = new Set(c.d.likes.filter((k) => k.user_id === c.uid).map((k) => k.listing_id))
      const scored = recommendedScores(
        {
          candidates: visibleApproved(c),
          liked: c.d.listings.filter((l) => likedIds.has(l.id)),
          ownCreatorIds: c.d.creators.filter((cr) => cr.owner_id === c.uid).map((cr) => cr.id),
        },
        o,
      )
      return cardsFor(c, scored.map((x) => x.listingId))
    },

    async savedListings() {
      const c = await cx()
      const list = savedList(c)
      if (!list) return []
      const items = c.d.collection_items.filter((i) => i.collection_id === list.id).sort((a, b) => b.added_at.localeCompare(a.added_at))
      return cardsFor(
        c,
        items.map((i) => i.listing_id).filter((id) => c.d.listings.some((l) => l.id === id && listingVisible(c, l))),
      )
    },

    setSaved: (listingId, saved) =>
      run((c) => {
        const uid = active(c)
        let list = savedList(c)
        if (saved) {
          visibleListing(c, listingId)
          if (!list) {
            list = { id: newId(), owner_id: uid, name: 'Saved', is_public: false, kind: 'saved', created_at: now() }
            c.d.collections.push(list)
          }
          const id = list.id
          if (!c.d.collection_items.some((i) => i.collection_id === id && i.listing_id === listingId)) c.d.collection_items.push({ collection_id: id, listing_id: listingId, added_at: now() })
        } else if (list) {
          const id = list.id
          c.d.collection_items = c.d.collection_items.filter((i) => !(i.collection_id === id && i.listing_id === listingId))
        }
      }),

    async getListing(idOrSlug) {
      const c = await cx()
      const l = c.d.listings.find((x) => x.id === idOrSlug || x.slug === idOrSlug)
      const cr = l && c.d.creators.find((x) => x.id === l.creator_id)
      if (!l || !cr || !listingVisible(c, l)) return null
      return { listing: listingOut(c, l), creator: creatorOut(c, cr), versions: versionsOf(c, l.id) }
    },

    async myListings() {
      const c = await cx()
      const cr = ownCreator(c)
      if (!cr) return []
      return c.d.listings
        .filter((l) => l.creator_id === cr.id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((l) => listingOut(c, l))
    },

    createListing: (input) =>
      run((c) => {
        const cr = requireCreator(c)
        checkListingFields(input)
        if (c.d.listings.filter((l) => l.creator_id === cr.id && l.status === 'pending').length >= MAX_PENDING) {
          bad('conflict', 'you have 20 models waiting for review; wait for a decision first')
        }
        let slug = input.slug ?? slugify(input.title)
        if (input.slug === undefined) {
          const base = slug
          for (let n = 2; c.d.listings.some((l) => l.slug === slug); n++) slug = `${base.slice(0, 76)}-${n}`
        } else if (c.d.listings.some((l) => l.slug === slug)) {
          bad('conflict', 'That address is taken')
        }
        if (!SLUG.test(slug)) bad('invalid', 'Use lowercase letters, digits and hyphens for the address')
        const row: ListingRow = {
          id: newId(),
          creator_id: cr.id,
          slug,
          title: input.title.trim(),
          description: input.description ?? null,
          license: input.license ?? 'cc-by',
          status: 'pending',
          tags: input.tags ?? [],
          cover_url: input.coverUrl ?? null,
          review_note: null,
          reviewed_by: null,
          reviewed_at: null,
          published_at: null,
          created_at: now(),
        }
        c.d.listings.push(row)
        return listingOut(c, row)
      }),

    updateListing: (id, patch) =>
      run((c) => {
        active(c)
        const l = c.d.listings.find((x) => x.id === id)
        if (!l || !isOwnListing(c, l)) bad('not_found', 'no such listing')
        const row = l as ListingRow
        checkListingFields(patch)
        if (patch.slug !== undefined && patch.slug !== row.slug && c.d.listings.some((x) => x.slug === patch.slug)) bad('conflict', 'That address is taken')
        const before = JSON.stringify([row.slug, row.title, row.description, row.license, row.tags, row.cover_url])
        if (patch.slug !== undefined) row.slug = patch.slug
        if (patch.title !== undefined) row.title = patch.title.trim()
        if (patch.description !== undefined) row.description = patch.description
        if (patch.license !== undefined) row.license = patch.license
        if (patch.tags !== undefined) row.tags = patch.tags
        if (patch.coverUrl !== undefined) row.cover_url = patch.coverUrl
        const changed = before !== JSON.stringify([row.slug, row.title, row.description, row.license, row.tags, row.cover_url])
        // Edits to a public or archived listing go back through review.
        if (changed && (row.status === 'approved' || row.status === 'archived')) setStatus(c, row, 'pending')
        return listingOut(c, row)
      }),

    archiveListing: (id) => run((c) => transition(c, id, 'approved', 'archived')),
    unarchiveListing: (id) => run((c) => transition(c, id, 'archived', 'approved')),
    resubmitListing: (id) => run((c) => transition(c, id, 'rejected', 'pending')),

    deleteListing: (id) =>
      run((c) => {
        signedIn(c)
        const l = c.d.listings.find((x) => x.id === id)
        if (!l || !isOwnListing(c, l)) bad('not_found', 'no such listing')
        if (!['pending', 'rejected', 'archived'].includes(l.status)) bad('forbidden', 'Only your own pending, rejected or archived models can be deleted')
        dropListing(c, id)
      }),

    like: (listingId) =>
      run((c) => {
        const uid = active(c)
        visibleListing(c, listingId)
        if (!c.d.likes.some((x) => x.user_id === uid && x.listing_id === listingId)) c.d.likes.push({ user_id: uid, listing_id: listingId, created_at: now() })
      }),

    unlike: (listingId) =>
      run((c) => {
        const uid = signedIn(c)
        c.d.likes = c.d.likes.filter((x) => !(x.user_id === uid && x.listing_id === listingId))
      }),

    async comments(listingId) {
      const c = await cx()
      const l = c.d.listings.find((x) => x.id === listingId)
      if (!l || !listingVisible(c, l)) return []
      return c.d.comments
        .filter((r) => r.listing_id === listingId && r.deleted_at === null)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((r) => toComment(r, author(c.d, r.user_id)))
    },

    addComment: (listingId, body, parentId) =>
      run((c) => {
        const uid = active(c)
        visibleListing(c, listingId)
        const text = body.trim()
        if (text.length < 1 || text.length > 4000) bad('invalid', 'Comments are 1 to 4000 characters')
        if (parentId !== undefined && !c.d.comments.some((r) => r.id === parentId && r.listing_id === listingId)) bad('invalid', 'The comment you are replying to is not on this model')
        const row: CommentRow = { id: newId(), listing_id: listingId, user_id: uid, parent_id: parentId ?? null, body: text, created_at: now(), edited_at: null, deleted_at: null }
        c.d.comments.push(row)
        return toComment(row, author(c.d, uid))
      }),

    editComment: (id, body) =>
      run((c) => {
        const uid = active(c)
        const row = c.d.comments.find((r) => r.id === id && r.user_id === uid && r.deleted_at === null) ?? bad('not_found', 'no such comment')
        const text = body.trim()
        if (text.length < 1 || text.length > 4000) bad('invalid', 'Comments are 1 to 4000 characters')
        row.body = text
        row.edited_at = now()
        return toComment(row, author(c.d, uid))
      }),

    deleteComment: (id) =>
      run((c) => {
        const uid = signedIn(c)
        const row = c.d.comments.find((r) => r.id === id && r.deleted_at === null)
        const own = row !== undefined && row.user_id === uid && c.role !== 'banned'
        if (!row || !(isStaff(c.role) || own)) bad('not_found', 'no such comment')
        ;(row as CommentRow).deleted_at = now()
        ;(row as CommentRow).body = '[deleted]'
        // Only a staff deletion is logged, as the database function does.
        if (!own) audit(c, 'delete_comment', 'comment', row.id, null, { listing: row.listing_id, author: row.user_id })
      }),

    async makes(listingId) {
      const c = await cx()
      const l = c.d.listings.find((x) => x.id === listingId)
      if (!l || !listingVisible(c, l)) return []
      return c.d.makes
        .filter((r) => r.listing_id === listingId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((r) => toMake(r, author(c.d, r.user_id)))
    },

    addMake: (listingId, input) =>
      run((c): Make => {
        const uid = active(c)
        visibleListing(c, listingId)
        if (input.caption !== undefined && input.caption.length > 1000) bad('invalid', 'Captions can be at most 1000 characters')
        if (input.photoUrl !== undefined && !HTTPS.test(input.photoUrl)) bad('invalid', 'The photo must be an https address')
        if (input.printerModel !== undefined && input.printerModel.length > 80) bad('invalid', 'Printer names can be at most 80 characters')
        const row = { id: newId(), listing_id: listingId, user_id: uid, caption: input.caption ?? null, photo_url: input.photoUrl ?? null, printer_model: input.printerModel ?? null, created_at: now() }
        c.d.makes.push(row)
        return toMake(row, author(c.d, uid))
      }),

    async collections() {
      const c = await cx()
      if (!c.uid) return []
      return c.d.collections
        .filter((x) => x.owner_id === c.uid && x.kind !== 'saved')
        .map((x): Collection =>
          toCollection(
            x,
            c.d.collection_items
              .filter((i) => i.collection_id === x.id && c.d.listings.some((l) => l.id === i.listing_id && listingVisible(c, l)))
              .map((i) => i.listing_id),
          ),
        )
    },

    createCollection: (name, isPublic = false) =>
      run((c) => {
        const uid = active(c)
        const n = name.trim()
        if (n.length < 1 || n.length > 80) bad('invalid', 'Collection names are 1 to 80 characters')
        const row = { id: newId(), owner_id: uid, name: n, is_public: isPublic, created_at: now() }
        c.d.collections.push(row)
        return toCollection(row, [])
      }),

    setInCollection: (collectionId, listingId, present) =>
      run((c) => {
        const uid = signedIn(c)
        if (!c.d.collections.some((x) => x.id === collectionId && x.owner_id === uid)) bad('not_found', 'no such collection')
        const has = c.d.collection_items.some((i) => i.collection_id === collectionId && i.listing_id === listingId)
        if (present && !has) {
          active(c)
          visibleListing(c, listingId)
          c.d.collection_items.push({ collection_id: collectionId, listing_id: listingId, added_at: now() })
        }
        if (!present) c.d.collection_items = c.d.collection_items.filter((i) => !(i.collection_id === collectionId && i.listing_id === listingId))
      }),

    follow: (creatorId) =>
      run((c) => {
        const uid = active(c)
        const cr = c.d.creators.find((x) => x.id === creatorId)
        if (!cr || !creatorVisible(c, cr)) bad('not_found', 'no such creator')
        if (!c.d.follows.some((f) => f.user_id === uid && f.creator_id === creatorId)) c.d.follows.push({ user_id: uid, creator_id: creatorId, created_at: now() })
      }),

    unfollow: (creatorId) =>
      run((c) => {
        const uid = signedIn(c)
        c.d.follows = c.d.follows.filter((f) => !(f.user_id === uid && f.creator_id === creatorId))
      }),

    async listingStats(listingIds) {
      const c = await cx()
      const out: Record<string, ListingStats> = {}
      for (const id of listingIds) {
        const l = c.d.listings.find((x) => x.id === id)
        if (l && listingVisible(c, l)) out[id] = statsOf(c.d, id)
      }
      return out
    },

    async printProfiles(versionId) {
      const c = await cx()
      const v = c.d.listing_versions.find((x) => x.id === versionId)
      return v && versionVisible(c, v) ? c.d.print_profiles.filter((p) => p.version_id === versionId).map(toPrintProfile) : []
    },

    async files(versionId) {
      const c = await cx()
      const v = c.d.listing_versions.find((x) => x.id === versionId)
      return v && versionVisible(c, v) ? c.d.listing_files.filter((f) => f.version_id === versionId).map(toFile) : []
    },

    download: (listingId) =>
      run((c) => {
        // Signed out works too; only member downloads are counted here.
        const uid = c.uid ? active(c) : null
        const l = c.d.listings.find((x) => x.id === listingId)
        if (!l || l.status !== 'approved' || !listingVisible(c, l)) bad('not_found', 'no such listing')
        const v = latestVersion(c.d.listing_versions.filter((x) => x.listing_id === listingId && x.review_status === 'approved' && x.scan_status === 'clean'))
        if (!v) bad('not_found', 'This model has no approved file yet')
        const at = now()
        const row = uid ? c.d.downloads.find((x) => x.user_id === uid && x.listing_id === listingId) : undefined
        if (row) {
          row.count += 1
          row.last_at = at
        } else if (uid) {
          c.d.downloads.push({ user_id: uid, listing_id: listingId, count: 1, first_at: at, last_at: at })
        }
        const ver = v as VersionRow
        return { url: `seed://listing-files/${ver.storage_path}`, versionId: ver.id, version: ver.version, fileName: ver.storage_path.split('/').pop() ?? ver.storage_path }
      }),

    // Upload -------------------------------------------------------------------------
    async uploadVersion(listingId, input) {
      // Checks that need no state run first, before anything is read.
      const rules = settings((await cx()).d)
      const pre = validateUpload(
        { name: input.name, version: input.version, format: input.format, size: input.bytes.length },
        { maxFileMb: rules.max_file_mb, allowedFormats: rules.allowed_formats },
      )
      if (!pre.ok) return { ok: false, code: 'invalid', message: pre.message }
      if (input.changelog !== undefined && input.changelog.length > 4000) return { ok: false, code: 'invalid', message: 'Changelogs can be at most 4000 characters' }
      const sha = await sha256Hex(input.bytes)
      return run((c) => {
        active(c)
        const l = c.d.listings.find((x) => x.id === listingId)
        if (!l || !canEdit(c, l)) bad('not_found', 'no such listing')
        const listing = l as ListingRow
        if (c.d.listing_versions.some((v) => v.listing_id === listingId && v.version === input.version)) bad('conflict', 'That version already exists; publish a new version number')
        const cr = c.d.creators.find((x) => x.id === listing.creator_id) as CreatorRow
        const id = newId()
        const row: VersionRow = {
          id,
          listing_id: listingId,
          version: input.version,
          changelog: input.changelog ?? null,
          storage_path: `${listingId}/${id}/${input.name}`,
          sha256: sha,
          format: input.format,
          size_bytes: input.bytes.length,
          scan_status: 'queued',
          scan_report: null,
          scanned_at: null,
          review_status: 'pending',
          created_at: now(),
        }
        c.d.listing_versions.push(row)
        finishScan(c, row, listing, cr, input.bytes.length, scanBytes(input.bytes, input.format))
        return toVersion(row)
      })
    },

    getScanStatus: (versionId) =>
      run((c) => {
        const v = c.d.listing_versions.find((x) => x.id === versionId)
        if (!v || !versionVisible(c, v)) bad('not_found', 'no such version')
        const ver = v as VersionRow
        return { scanStatus: ver.scan_status, reviewStatus: ver.review_status }
      }),

    getScanReport: (versionId) =>
      run((c) => {
        const v = c.d.listing_versions.find((x) => x.id === versionId)
        const l = v && c.d.listings.find((x) => x.id === v.listing_id)
        return v && l && (canEdit(c, l) || isStaff(c.role)) ? (v.scan_report ?? null) : null
      }),

    // Creator ------------------------------------------------------------------------
    async getMyCreator() {
      const c = await cx()
      const cr = ownCreator(c)
      return cr ? creatorOut(c, cr) : null
    },

    saveCreator: (input) =>
      run((c) => {
        const uid = active(c)
        const h = validateHandle(input.handle)
        if (!h.ok) bad('invalid', h.message)
        const name = input.displayName.trim()
        if (name.length < 1 || name.length > 80) bad('invalid', 'Names are 1 to 80 characters')
        if (input.tagline != null && input.tagline.length > 140) bad('invalid', 'Taglines can be at most 140 characters')
        if (input.bio != null && input.bio.length > 4000) bad('invalid', 'Bios can be at most 4000 characters')
        if (input.location != null && input.location.length > 80) bad('invalid', 'Locations can be at most 80 characters')
        if (input.logoUrl != null && !IMAGE.test(input.logoUrl)) bad('invalid', 'The logo must be an https address')
        if (input.bannerUrl != null && !IMAGE.test(input.bannerUrl)) bad('invalid', 'The banner must be an https address')
        const existing = ownCreator(c)
        if (c.d.creators.some((x) => x.handle === input.handle && x.id !== existing?.id)) bad('conflict', 'That handle is taken')
        if (existing) {
          existing.handle = input.handle
          existing.display_name = name
          if (input.tagline !== undefined) existing.tagline = input.tagline
          if (input.bio !== undefined) existing.bio = input.bio
          if (input.location !== undefined) existing.location = input.location
          if (input.logoUrl !== undefined) existing.logo_url = input.logoUrl
          if (input.bannerUrl !== undefined) existing.banner_url = input.bannerUrl
          if (input.status !== undefined) existing.status = input.status
          return creatorOut(c, existing)
        }
        const row: CreatorRow = {
          id: newId(),
          owner_id: uid,
          handle: input.handle,
          display_name: name,
          tagline: input.tagline ?? null,
          bio: input.bio ?? null,
          location: input.location ?? null,
          logo_url: input.logoUrl ?? null,
          banner_url: input.bannerUrl ?? null,
          status: input.status ?? 'active',
          trusted: false,
          created_at: now(),
        }
        c.d.creators.push(row)
        // A member who makes a creator page becomes a creator.
        const profile = c.d.profiles.find((p) => p.id === uid)
        if (profile && profile.role === 'member') profile.role = 'creator'
        return creatorOut(c, row)
      }),

    setCreatorLinks: (links) =>
      run((c): CreatorLink[] => {
        const cr = requireCreator(c)
        const checked = validateCreatorLinks(links)
        if (!checked.ok) bad('invalid', checked.message)
        const rows = (checked.ok ? checked.value : []).map((l, position) => ({ id: newId(), creator_id: cr.id, kind: l.kind, label: l.label ?? null, url: l.url, position }))
        c.d.creator_links = [...c.d.creator_links.filter((k) => k.creator_id !== cr.id), ...rows]
        return rows.map(toCreatorLink)
      }),

    uploadCreatorImage: (input) =>
      run((c) => {
        requireCreator(c)
        if (!IMAGE_TYPES.includes(input.contentType)) bad('invalid', 'Use a PNG, JPEG or WebP image')
        if (input.bytes.byteLength > MAX_IMAGE_BYTES) bad('invalid', 'Images can be at most 5 MB')
        let bin = ''
        for (let i = 0; i < input.bytes.length; i += 0x8000) bin += String.fromCharCode(...input.bytes.subarray(i, i + 0x8000))
        return `data:${input.contentType};base64,${btoa(bin)}`
      }),

    setFeatured: (listingIds) =>
      run((c) => {
        const cr = requireCreator(c)
        if (listingIds.length > MAX_FEATURED) bad('invalid', `Feature at most ${MAX_FEATURED} models`)
        if (new Set(listingIds).size !== listingIds.length) bad('invalid', 'A model can be featured once')
        for (const id of listingIds) {
          if (!c.d.listings.some((l) => l.id === id && l.creator_id === cr.id && l.status === 'approved')) bad('invalid', 'feature only your own approved models')
        }
        c.d.creator_featured = [...c.d.creator_featured.filter((f) => f.creator_id !== cr.id), ...listingIds.map((listing_id, i) => ({ creator_id: cr.id, listing_id, position: i + 1 }))]
      }),

    async listCreatorListings(handle) {
      return (await this.getCreatorByHandle(handle))?.listings ?? []
    },

    async getCreatorByHandle(handle) {
      const c = await cx()
      const cr = c.d.creators.find((x) => x.handle === handle)
      if (!cr || !creatorVisible(c, cr)) return null
      const listingRows = c.d.listings.filter((l) => l.creator_id === cr.id && l.status === 'approved' && listingVisible(c, l))
      const byNewest = [...listingRows].sort((a, b) => (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at))
      const featured = c.d.creator_featured
        .filter((f) => f.creator_id === cr.id)
        .sort((a, b) => a.position - b.position)
        .flatMap((f) => listingRows.filter((l) => l.id === f.listing_id))
      const out: CreatorPage = {
        creator: creatorOut(c, cr, true),
        links: c.d.creator_links
          .filter((k) => k.creator_id === cr.id)
          .sort((a, b) => a.position - b.position)
          .map(toCreatorLink),
        featured: featured.map((l) => listingOut(c, l)),
        listings: byNewest.map((l) => listingOut(c, l)),
      }
      return out
    },

    async listCreators(o = {}) {
      const c = await cx()
      const q = o.query?.trim().toLowerCase()
      const limit = Math.min(Math.max(o.limit ?? 50, 1), 200)
      return c.d.creators
        .filter((cr) => cr.status === 'active' && creatorVisible(c, cr) && (isStaff(c.role) || cr.owner_id === c.uid || c.d.listings.some((l) => l.creator_id === cr.id && l.status === 'approved')) && (!q || cr.handle.includes(q) || cr.display_name.toLowerCase().includes(q) || (cr.tagline ?? '').toLowerCase().includes(q)))
        .map((cr) => creatorOut(c, cr, true))
        .sort((a, b) => b.followers - a.followers || a.displayName.localeCompare(b.displayName))
        .slice(0, limit)
    },

    creatorDashboard: () =>
      run((c): DashboardRow[] => {
        signedIn(c)
        const cr = ownCreator(c)
        if (!cr) return []
        return c.d.listings
          .filter((l) => l.creator_id === cr.id)
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .map((l) => {
            const s = statsOf(c.d, l.id)
            return { listingId: l.id, title: l.title, status: l.status, likes: s.likes, comments: s.comments, makes: s.makes, downloads: s.downloads }
          })
      }),

    // Moderation ---------------------------------------------------------------------
    moderationQueue: () =>
      run((c) => {
        signedIn(c)
        if (!isStaff(c.role)) return []
        return c.d.listings
          .filter((l) => l.status === 'pending' || (l.status === 'approved' && c.d.listing_versions.some((v) => v.listing_id === l.id && v.review_status === 'pending')))
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .flatMap((l) => {
            const cr = c.d.creators.find((x) => x.id === l.creator_id)
            if (!cr) return []
            const waiting = c.d.listing_versions.filter((v) => v.listing_id === l.id && v.review_status === 'pending')
            return [
              toModerationItem({
                listing_id: l.id,
                slug: l.slug,
                title: l.title,
                status: l.status,
                submitted_at: l.created_at,
                creator_id: cr.id,
                creator_handle: cr.handle,
                creator_trusted: cr.trusted,
                uploader_id: cr.owner_id,
                uploader_banned: ownerBanned(c, cr),
                creator_approved_count: c.d.listings.filter((o) => o.creator_id === cr.id && o.status === 'approved').length,
                waiting_versions: waiting.length,
                ready: waiting.length > 0 && waiting.every((v) => v.scan_status === 'clean'),
              }),
            ]
          })
      }),

    approveListing: (id, note) =>
      run((c) => {
        if (!canModerate(c)) bad('forbidden', 'you cannot approve uploads in the current moderation mode')
        const l = c.d.listings.find((x) => x.id === id) ?? bad('not_found', 'no such listing')
        const listing = l as ListingRow
        if (listing.status !== 'pending' && listing.status !== 'approved') bad('conflict', `a ${listing.status} listing is not waiting for review`)
        const waiting = c.d.listing_versions.filter((v) => v.listing_id === id && v.review_status === 'pending')
        if (waiting.length === 0) bad('conflict', 'nothing is waiting for review')
        if (waiting.some((v) => v.scan_status !== 'clean')) bad('conflict', 'a file has not passed the upload scan yet')
        for (const v of waiting) v.review_status = 'approved'
        listing.status = 'approved'
        listing.review_note = null
        listing.reviewed_by = c.uid
        listing.reviewed_at = now()
        listing.published_at ??= now()
        audit(c, 'approve', 'listing', id, note ?? null, { title: listing.title })
      }),

    rejectListing: (id, reason) =>
      run((c) => {
        if (!canModerate(c)) bad('forbidden', 'you cannot reject uploads in the current moderation mode')
        const why = reason.trim()
        if (why.length < 3) bad('invalid', 'give the creator a reason')
        const l = (c.d.listings.find((x) => x.id === id) ?? bad('not_found', 'no such listing')) as ListingRow
        if (l.status !== 'pending' && l.status !== 'approved') bad('conflict', `a ${l.status} listing is not waiting for review`)
        for (const v of c.d.listing_versions) if (v.listing_id === id && v.review_status === 'pending') v.review_status = 'rejected'
        const was = l.status
        if (l.status === 'pending') {
          l.status = 'rejected'
          l.review_note = why
          l.reviewed_by = c.uid
          l.reviewed_at = now()
        }
        audit(c, 'reject', 'listing', id, why, { title: l.title, was })
      }),

    removeListing: (id, reason) =>
      run((c) => {
        if (!canModerate(c)) bad('forbidden', 'you cannot remove listings in the current moderation mode')
        const why = reason.trim()
        if (why.length < 3) bad('invalid', 'give the creator a reason')
        const l = (c.d.listings.find((x) => x.id === id) ?? bad('not_found', 'no such listing')) as ListingRow
        if (l.status === 'removed') return
        const was = l.status
        setStatus(c, l, 'removed')
        l.review_note = why
        l.reviewed_by = c.uid
        l.reviewed_at = now()
        audit(c, 'remove', 'listing', id, why, { title: l.title, was })
      }),

    banUser: (userId, reason) =>
      run((c) => {
        if (!isStaff(c.role)) bad('forbidden', 'only staff can ban accounts')
        const why = reason.trim()
        if (why.length < 3) bad('invalid', 'give a reason for the ban')
        const target = c.d.profiles.find((p) => p.id === userId) ?? bad('not_found', 'no such user')
        const t = target as (typeof c.d.profiles)[number]
        if (userId === c.uid || t.role === 'owner' || (t.role === 'moderator' && c.role !== 'owner')) bad('forbidden', 'this account cannot be banned by you')
        if (t.banned_at === null) {
          t.banned_at = now()
          t.ban_reason = why
        }
        for (const x of ctx.tokens) if (x.userId === userId && !x.token.revokedAt) x.token = { ...x.token, revokedAt: now() }
        audit(c, 'ban', 'user', userId, why, { role: t.role })
      }),

    unbanUser: (userId, reason) =>
      run((c) => {
        if (!isStaff(c.role)) bad('forbidden', 'only staff can lift a ban')
        const t = c.d.profiles.find((p) => p.id === userId)
        if (t && t.banned_at !== null) {
          t.banned_at = null
          t.ban_reason = null
          audit(c, 'unban', 'user', userId, reason ?? null)
        }
      }),

    auditLog: (o = {}) =>
      run((c) => {
        signedIn(c)
        if (!isStaff(c.role)) return []
        const limit = Math.min(Math.max(o.limit ?? 50, 1), 200)
        const before = o.before
        return c.d.audit_log
          .filter((r) => before === undefined || r.id < before)
          .sort((a, b) => b.id - a.id)
          .slice(0, limit)
          .map(toAudit)
      }),

    async getModerationMode() {
      const c = await cx()
      return settings(c.d).moderation_mode
    },

    async getLibrarySettings() {
      const c = await cx()
      const r = settings(c.d)
      const out: LibrarySettings = { moderationMode: r.moderation_mode, maxFileMb: r.max_file_mb, allowedFormats: [...r.allowed_formats] }
      return out
    },

    setModerationMode: (mode: ModerationMode) =>
      run((c) => {
        if (c.role !== 'owner') bad('forbidden', 'only the owner can change the moderation mode')
        if (!(MODERATION_MODES as readonly string[]).includes(mode)) bad('invalid', 'unknown moderation mode')
        const row = c.d.library_settings[0] ?? bad('unavailable', 'no library settings')
        const from = row.moderation_mode
        row.moderation_mode = mode
        audit(c, 'set_moderation_mode', 'setting', null, null, { from, to: mode })
      }),

    setUserRole: (userId, role, reason) =>
      run((c) => {
        if (c.role !== 'owner') bad('forbidden', 'only the owner can change roles')
        if (!['moderator', 'creator', 'member'].includes(role)) bad('invalid', 'roles that can be assigned: moderator, creator, member')
        const t = (c.d.profiles.find((p) => p.id === userId) ?? bad('not_found', 'no such user')) as (typeof c.d.profiles)[number]
        if (t.role === 'owner') bad('forbidden', 'the owner role cannot be changed here')
        const from = t.role
        t.role = role
        audit(c, 'role_change', 'user', userId, reason ?? null, { from, to: role })
      }),

    setCreatorTrusted: (creatorId, trusted) =>
      run((c) => {
        if (c.role !== 'owner') bad('forbidden', 'only the owner can mark a creator trusted')
        const cr = (c.d.creators.find((x) => x.id === creatorId) ?? bad('not_found', 'no such creator')) as CreatorRow
        cr.trusted = trusted
        audit(c, trusted ? 'trust' : 'untrust', 'creator', creatorId, null)
      }),

    async myRole() {
      return ctx.roleOf(await ctx.currentUser())
    },
  }

  function transition(c: Cx, id: string, from: ListingRow['status'], to: ListingRow['status']) {
    active(c)
    const l = c.d.listings.find((x) => x.id === id)
    if (!l || !isOwnListing(c, l)) bad('not_found', 'no such listing')
    const row = l as ListingRow
    if (row.status !== from) bad('forbidden', `a ${row.status} listing cannot become ${to}`)
    setStatus(c, row, to)
  }

  return client
}

/** An offline client: the auth part and the store part over one in-memory copy of the seed. */
export function createOfflineStore(opts: OfflineOptions): StoreClient {
  const ctx = createOfflineContext(opts)
  return { ...offlineAuth(ctx), ...offlineStore(ctx) }
}
