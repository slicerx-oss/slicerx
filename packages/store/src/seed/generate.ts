// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Deterministic seed generator. The same function produces packages/store/seed/*.json
// (offline mode) and supabase/seed/*.sql (local stack), so both serve the same data.
// No wall clock and no Math.random: every value comes from a seeded PRNG and
// fixed dates, so the output is byte-identical on every run.
import type {
  AuditRow,
  CollectionItemRow,
  CollectionRow,
  CommentRow,
  CreatorFeaturedRow,
  CreatorLinkRow,
  CreatorRow,
  DownloadRow,
  FileRow,
  FollowRow,
  LikeRow,
  ListingRow,
  MakeRow,
  PrintProfileRow,
  ProfileRow,
  SeedData,
  SeedUserRow,
  VersionRow,
} from '../rows'
import { COMMENT_LINES, DEMO_MEMBER, FILAMENTS, MAKE_CAPTIONS, PRINTERS, SEED_BANNED, SEED_CREATORS, SEED_MEMBERS, SEED_MODERATOR, SEED_OWNER } from './catalog'

/** Seed "now". */
export const SEED_NOW = '2026-09-30T20:00:00Z'
const DAY = 86_400_000
const HOUR = 3_600_000
const SEPT = Date.UTC(2026, 8, 1)

function hash128(s: string): [number, number, number, number] {
  // cyrb128: small, well distributed, dependency free.
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0]
}

const hex8 = (n: number) => n.toString(16).padStart(8, '0')

const SEED_FILAMENTS: [string, string][] = [
  ['#1c1c1e', 'Matte black'],
  ['#f2f0eb', 'Bone white'],
  ['#d4af37', 'Silk gold'],
  ['#c0392b', 'Signal red'],
  ['#2e6fd8', 'Cobalt blue'],
  ['#3fae5a', 'Grass green'],
  ['#f39c12', 'Amber'],
  ['#8e8e93', 'Ash gray'],
  ['#8e44ad', 'Plum'],
  ['#5dade2', 'Sky blue'],
]

/** A listing's colors from its slug alone (no PRNG draws, so the rest of the seed stays put). Multicolor listings get eight colors, two parts through the AMS. */
function seedColors(slug: string, tags: readonly string[]): VersionRow['colors'] {
  const [a, b] = hash128(`colors:${slug}`)
  const from = a % SEED_FILAMENTS.length
  const pick = (n: number) => Array.from({ length: n }, (_, i) => SEED_FILAMENTS[(from + i * 3) % SEED_FILAMENTS.length] as [string, string])
  const kind = tags.includes('multicolor') ? 3 : b % 10 < 5 ? 0 : b % 10 < 8 ? 1 : 2
  if (kind === 0) {
    const [hex, name] = pick(1)[0] as [string, string]
    return { colors: [{ hex, name }], parts: [{ name: 'Body', colors: [0], ams: false }] }
  }
  const n = kind === 3 ? 8 : 2 + (b % 3)
  const colors = pick(n).map(([hex, name]) => ({ hex, name }))
  const parts = colors.map((_, i) => ({ name: `Part ${i + 1}`, colors: [i], ams: false }))
  if (kind >= 2) parts.splice(0, 2, { name: 'Body', colors: [0, 1], ams: true })
  if (kind === 3) parts.splice(1, 2, { name: 'Face', colors: [2, 3, 4], ams: true })
  return { colors, parts }
}

/** A stable UUID (version 5 layout, variant 10) derived from a label. */
export function seedId(label: string): string {
  const [a, b, c, d] = hash128(`slicerx-seed:${label}`)
  const h = hex8(a) + hex8(b) + hex8(c) + hex8(d)
  const variant = ((parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function fakeSha256(label: string): string {
  let out = ''
  for (let i = 0; i < 2; i++) {
    const [a, b, c, d] = hash128(`sha:${label}:${i}`)
    out += hex8(a) + hex8(b) + hex8(c) + hex8(d)
  }
  return out
}

function prng(seed: string): () => number {
  let [a] = hash128(seed)
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z')

function pick<T>(rand: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)]
  if (item === undefined) throw new Error('pick from an empty list')
  return item
}

function sample<T>(rand: () => number, items: readonly T[], n: number): T[] {
  const pool = [...items]
  const out: T[] = []
  while (out.length < n && pool.length > 0) {
    const [item] = pool.splice(Math.floor(rand() * pool.length), 1)
    if (item !== undefined) out.push(item)
  }
  return out
}

/** A staff action to record in the audit log, before ids are assigned in time order. */
type AuditEvent = Omit<AuditRow, 'id'>

export function generateSeed(): SeedData {
  const rand = prng('slicerx-seed-v2')
  const users: SeedUserRow[] = []
  const profiles: ProfileRow[] = []
  const addUser = (handle: string, displayName: string, role: ProfileRow['role'] = 'member') => {
    const id = seedId(`user:${handle}`)
    users.push({ id, email: `${handle}@example.com`, handle, display_name: displayName })
    profiles.push({ id, handle, display_name: displayName, avatar_url: null, role, banned_at: null, ban_reason: null })
    return id
  }

  const ownerId = addUser(SEED_OWNER.handle, SEED_OWNER.displayName, 'owner')
  const modId = addUser(SEED_MODERATOR.handle, SEED_MODERATOR.displayName, 'moderator')
  const audit: AuditEvent[] = []
  audit.push({ at: iso(Date.UTC(2026, 5, 1, 8)), actor_id: ownerId, action: 'role_change', target_kind: 'user', target_id: modId, reason: 'Volunteer moderator', detail: { from: 'member', to: 'moderator' } })
  audit.push({ at: iso(Date.UTC(2026, 5, 1, 8, 5)), actor_id: ownerId, action: 'set_moderation_mode', target_kind: 'setting', target_id: null, reason: null, detail: { from: 'owner-approves-all', to: 'moderators' } })
  audit.push({ at: iso(Date.UTC(2026, 8, 28, 9)), actor_id: ownerId, action: 'set_moderation_mode', target_kind: 'setting', target_id: null, reason: null, detail: { from: 'moderators', to: 'owner-approves-all' } })

  const creators: CreatorRow[] = []
  const creatorLinks: CreatorLinkRow[] = []
  const featured: CreatorFeaturedRow[] = []
  const listings: ListingRow[] = []
  const versions: VersionRow[] = []
  const files: FileRow[] = []
  const printProfiles: PrintProfileRow[] = []

  SEED_CREATORS.forEach((c, creatorIndex) => {
    const creatorOwner = addUser(c.owner.handle, c.owner.displayName, 'creator')
    const creatorId = seedId(`creator:${c.handle}`)
    const creatorCreated = Date.UTC(2026, 5, 1 + creatorIndex, 9)
    creators.push({
      id: creatorId,
      owner_id: creatorOwner,
      handle: c.handle,
      display_name: c.displayName,
      tagline: c.tagline,
      bio: c.bio,
      location: c.location ?? null,
      logo_url: `https://example.com/logos/${c.handle}.png`,
      status: 'active',
      trusted: c.trusted ?? false,
      created_at: iso(creatorCreated),
    })
    if (c.trusted) audit.push({ at: iso(creatorCreated + 9 * DAY), actor_id: ownerId, action: 'trust', target_kind: 'creator', target_id: creatorId, reason: null, detail: {} })
    c.links.forEach((l, i) => {
      creatorLinks.push({ id: seedId(`link:${c.handle}:${i}`), creator_id: creatorId, kind: l.kind, label: l.label ?? null, url: l.url, position: i })
    })
    let approvedIndex = 0
    c.listings.forEach((l) => {
      const listingId = seedId(`listing:${l.slug}`)
      const status = l.status ?? 'approved'
      // Approved releases run from June to late September, creators interleaved.
      // Everything else is dated by what happened to it.
      const base = Date.UTC(2026, 5, 1) + (approvedIndex * SEED_CREATORS.length + creatorIndex) * 5 * DAY + Math.floor(rand() * 3) * DAY
      const created =
        status === 'pending' ? Date.UTC(2026, 8, 25 + creatorIndex % 4, 10) : status === 'rejected' ? Date.UTC(2026, 8, 15, 10) : status === 'removed' ? Date.UTC(2026, 7, 10, 10) : status === 'archived' ? Date.UTC(2026, 7, 1, 10) : base
      if (status === 'approved') approvedIndex += 1
      const wasPublic = status === 'approved' || status === 'archived' || status === 'removed'
      const publishedAt = wasPublic ? created + 3 * HOUR : null
      const reviewedAt = status === 'rejected' ? created + 26 * HOUR : status === 'removed' ? Date.UTC(2026, 8, 5, 14) : publishedAt
      listings.push({
        id: listingId,
        creator_id: creatorId,
        slug: l.slug,
        title: l.title,
        description: l.description,
        license: l.license,
        status,
        tags: l.tags,
        cover_url: null,
        review_note: status === 'rejected' || status === 'removed' ? (l.note ?? null) : null,
        reviewed_by: status === 'pending' ? null : modId,
        reviewed_at: reviewedAt === null ? null : iso(reviewedAt),
        published_at: publishedAt === null ? null : iso(publishedAt),
        created_at: iso(created),
      })
      if (wasPublic && publishedAt !== null) {
        audit.push({ at: iso(publishedAt), actor_id: modId, action: 'approve', target_kind: 'listing', target_id: listingId, reason: null, detail: { title: l.title } })
      }
      if (status === 'rejected' && reviewedAt !== null) {
        audit.push({ at: iso(reviewedAt), actor_id: modId, action: 'reject', target_kind: 'listing', target_id: listingId, reason: l.note ?? null, detail: { title: l.title, was: 'pending' } })
      }
      if (status === 'removed' && reviewedAt !== null) {
        audit.push({ at: iso(reviewedAt), actor_id: modId, action: 'remove', target_kind: 'listing', target_id: listingId, reason: l.note ?? null, detail: { title: l.title, was: 'approved' } })
      }
      const reviewStatus = status === 'pending' ? 'pending' : status === 'rejected' ? 'rejected' : 'approved'
      // The upload scan turns every clean upload into an .sx3mf, the only form a Vault file leaves in.
      const ext = 'sx3mf'
      l.versions.forEach((v, vi) => {
        const versionId = seedId(`version:${l.slug}:${v.version}`)
        const fileName = `${l.slug}-${v.version}.${ext}`
        const size = 400_000 + Math.floor(rand() * 9_000_000)
        const versionCreated = created + vi * 9 * DAY + HOUR
        versions.push({
          id: versionId,
          listing_id: listingId,
          version: v.version,
          changelog: v.changelog,
          storage_path: `${listingId}/${versionId}/${fileName}`,
          sha256: fakeSha256(`version:${versionId}`),
          format: ext,
          size_bytes: size,
          scan_status: 'clean',
          scan_report: { ok: true, checks: ['extension', 'signature', 'structure', 'size'], size_bytes: size },
          scanned_at: iso(versionCreated + 300_000),
          review_status: reviewStatus,
          created_at: iso(versionCreated),
          colors: seedColors(l.slug, l.tags),
        })
        files.push({ id: seedId(`file:${versionId}:model`), version_id: versionId, name: fileName, role: 'model', format: ext, size_bytes: size, sha256: fakeSha256(`file:${versionId}:model`) })
        files.push({ id: seedId(`file:${versionId}:cover`), version_id: versionId, name: 'cover.webp', role: 'image', format: null, size_bytes: 40_000 + Math.floor(rand() * 60_000), sha256: fakeSha256(`file:${versionId}:cover`) })
        for (const p of sample(rand, PRINTERS, 2)) {
          const layer = l.tags.includes('miniature') ? 0.12 : pick(rand, [0.16, 0.2, 0.2, 0.24])
          printProfiles.push({
            id: seedId(`profile:${versionId}:${p.model}`),
            version_id: versionId,
            printer_model: p.model,
            process: `${layer.toFixed(2)} mm ${layer <= 0.12 ? 'Fine' : layer >= 0.24 ? 'Draft' : 'Standard'}`,
            filament: l.tags.includes('tpu') ? 'Generic TPU 95A' : pick(rand, FILAMENTS.slice(0, 4)),
            layer_height_mm: layer,
            nozzle_mm: 0.4,
            time_s: 1_800 + Math.floor(rand() * 5) * 1_800 + Math.floor(rand() * 60) * 60,
            grams: Math.round((8 + rand() * 140) * 10) / 10,
            plates: 1 + Math.floor(rand() * 2),
            notes: null,
          })
        }
      })
    })
    c.featured.forEach((slug, i) => {
      featured.push({ creator_id: creatorId, listing_id: seedId(`listing:${slug}`), position: i + 1 })
    })
  })

  const memberIds = SEED_MEMBERS.map((m) => addUser(m.handle, m.displayName))
  const rvId = seedId(`user:${DEMO_MEMBER.handle}`)
  const bannedAt = Date.UTC(2026, 8, 10, 12)
  const bannedId = addUser(SEED_BANNED.handle, SEED_BANNED.displayName)
  const bannedProfile = profiles.find((p) => p.id === bannedId)
  if (bannedProfile) {
    bannedProfile.banned_at = iso(bannedAt)
    bannedProfile.ban_reason = SEED_BANNED.reason
  }
  audit.push({ at: iso(bannedAt), actor_id: modId, action: 'ban', target_kind: 'user', target_id: bannedId, reason: SEED_BANNED.reason, detail: { role: 'member' } })

  const approved = listings.filter((l) => l.status === 'approved')
  const everPublic = listings.filter((l) => l.published_at !== null)

  const downloads: DownloadRow[] = []
  for (const l of everPublic) {
    for (const userId of sample(rand, memberIds, 3 + Math.floor(rand() * 6))) {
      const first = SEPT + Math.floor(rand() * 26) * DAY + 30_000_000
      const count = 1 + Math.floor(rand() * 3)
      downloads.push({ user_id: userId, listing_id: l.id, count, first_at: iso(first), last_at: iso(first + (count - 1) * DAY) })
    }
  }

  const likes: LikeRow[] = []
  const comments: CommentRow[] = []
  const makes: MakeRow[] = []
  const follows: FollowRow[] = []
  memberIds.forEach((userId) => {
    for (const l of sample(rand, approved, 4 + Math.floor(rand() * 7))) {
      likes.push({ user_id: userId, listing_id: l.id, created_at: iso(SEPT + Math.floor(rand() * 29) * DAY + 43_200_000) })
    }
    const followCount = userId === rvId ? 3 : 1 + Math.floor(rand() * 3)
    for (const c of sample(rand, creators, followCount)) {
      follows.push({ user_id: userId, creator_id: c.id, created_at: iso(Date.UTC(2026, 6, 1) + Math.floor(rand() * 60) * DAY) })
    }
  })
  let editedOne = false
  for (const l of approved) {
    const n = 1 + Math.floor(rand() * 3)
    let firstId: string | null = null
    for (let i = 0; i < n; i++) {
      const id = seedId(`comment:${l.id}:${i}`)
      const createdAt = SEPT + (i * 5 + Math.floor(rand() * 5)) * DAY
      comments.push({
        id,
        listing_id: l.id,
        user_id: pick(rand, memberIds),
        parent_id: null,
        body: pick(rand, COMMENT_LINES),
        created_at: iso(createdAt),
        edited_at: !editedOne && i === 0 ? iso(createdAt + HOUR) : null,
        deleted_at: null,
      })
      editedOne = true
      firstId ??= id
    }
    if (firstId && rand() < 0.4) {
      const owner = creators.find((c) => c.id === l.creator_id)
      if (owner) {
        comments.push({
          id: seedId(`comment:${l.id}:reply`),
          listing_id: l.id,
          user_id: owner.owner_id,
          parent_id: firstId,
          body: 'Thanks for printing it. The tested profile is linked on the version.',
          created_at: iso(SEPT + 26 * DAY),
          edited_at: null,
          deleted_at: null,
        })
      }
    }
    // A make by someone who downloaded it.
    if (rand() < 0.45) {
      const d = downloads.find((x) => x.listing_id === l.id)
      if (d) {
        makes.push({
          id: seedId(`make:${l.id}:${d.user_id}`),
          listing_id: l.id,
          user_id: d.user_id,
          caption: pick(rand, MAKE_CAPTIONS),
          photo_url: null,
          printer_model: pick(rand, PRINTERS).model,
          created_at: iso(Date.parse(d.first_at) + 2 * DAY),
        })
      }
    }
  }

  const collections: CollectionRow[] = []
  const collectionItems: CollectionItemRow[] = []
  const addCollection = (ownerUser: string, name: string, isPublic: boolean, items: ListingRow[]) => {
    const id = seedId(`collection:${ownerUser}:${name}`)
    collections.push({ id, owner_id: ownerUser, name, is_public: isPublic, created_at: iso(SEPT + 2 * DAY) })
    items.forEach((l, i) => collectionItems.push({ collection_id: id, listing_id: l.id, added_at: iso(SEPT + (3 + i) * DAY) }))
  }
  addCollection(rvId, 'Desk upgrades', true, approved.filter((l) => l.tags.includes('desk')))
  addCollection(rvId, 'Tabletop night', false, approved.filter((l) => l.tags.includes('tabletop')))
  addCollection(seedId('user:ash'), 'Workshop', true, approved.filter((l) => l.tags.includes('workshop') || l.tags.includes('tool')))

  const auditLog: AuditRow[] = audit
    .map((e, i) => ({ e, i }))
    .sort((a, b) => Date.parse(a.e.at) - Date.parse(b.e.at) || a.i - b.i)
    .map(({ e }, n) => ({ id: n + 1, ...e }))

  return {
    users,
    profiles,
    library_settings: [{ id: true, moderation_mode: 'owner-approves-all', max_file_mb: 100, allowed_formats: ['3mf', 'sx3mf', 'stl'] }],
    creators,
    creator_links: creatorLinks,
    follows,
    listings,
    listing_versions: versions,
    listing_files: files,
    print_profiles: printProfiles,
    creator_featured: featured,
    likes,
    comments,
    makes,
    collections,
    collection_items: collectionItems,
    downloads,
    audit_log: auditLog,
  }
}
