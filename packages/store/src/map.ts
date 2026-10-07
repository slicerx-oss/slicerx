// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Row to contract mappers shared by the offline and Supabase clients.
import type {
  AccountDevice,
  AuditEntry,
  Collection,
  Comment,
  Creator,
  CreatorLink,
  DashboardRow,
  Listing,
  ListingColors,
  ListingFile,
  ListingStats,
  ListingVersion,
  Make,
  ModerationItem,
  PrintProfile,
  Profile,
} from '@slicerx/contracts'
import { validateListingColors } from './validate'
import type {
  AuditRow,
  CollectionRow,
  CommentRow,
  CreatorLinkRow,
  CreatorRow,
  DashboardDbRow,
  FileRow,
  ListingRow,
  MakeRow,
  PairedDeviceRow,
  PrintProfileRow,
  ProfileRow,
  QueueRow,
  VersionRow,
} from './rows'

/** Normalizes Postgres and seed timestamps to one ISO form. */
export const isoTime = (t: string): string => new Date(t).toISOString()

/** Copies only defined values, so optional fields stay absent (exactOptionalPropertyTypes). */
function opt<K extends string, V>(key: K, v: V | null | undefined): { [P in K]?: V } {
  return (v === null || v === undefined ? {} : { [key]: v }) as { [P in K]?: V }
}

export const toProfile = (r: ProfileRow): Profile => ({
  id: r.id,
  handle: r.handle,
  displayName: r.display_name,
  role: r.role,
  ...opt('avatarUrl', r.avatar_url),
  ...opt('bannedAt', r.banned_at === null ? null : isoTime(r.banned_at)),
  ...opt('banReason', r.ban_reason),
})

export const toCreator = (r: CreatorRow, followers: number, extra: { listingCount?: number; followedByMe?: boolean; firstPublishedAt?: string } = {}): Creator => ({
  id: r.id,
  handle: r.handle,
  displayName: r.display_name,
  followers,
  ownerId: r.owner_id,
  status: r.status,
  trusted: r.trusted,
  createdAt: isoTime(r.created_at),
  ...opt('bio', r.bio),
  ...opt('location', r.location),
  ...opt('logoUrl', r.logo_url),
  ...opt('bannerUrl', r.banner_url),
  ...(r.badges?.length ? { badges: [...r.badges] } : {}),
  ...opt('firstPublishedAt', extra.firstPublishedAt === undefined ? undefined : isoTime(extra.firstPublishedAt)),
  ...opt('tagline', r.tagline),
  ...opt('listingCount', extra.listingCount),
  ...opt('followedByMe', extra.followedByMe),
})

export const toCreatorLink = (r: CreatorLinkRow): CreatorLink => ({
  id: r.id,
  kind: r.kind,
  url: r.url,
  position: r.position,
  ...opt('label', r.label),
})

export const toPrintProfile = (r: PrintProfileRow): PrintProfile => ({
  id: r.id,
  versionId: r.version_id,
  printerModel: r.printer_model,
  process: r.process,
  filament: r.filament,
  ...opt('layerHeightMm', r.layer_height_mm),
  ...opt('nozzleMm', r.nozzle_mm),
  ...opt('timeS', r.time_s),
  ...opt('grams', r.grams),
  ...opt('plates', r.plates),
  ...opt('notes', r.notes),
})

export const toVersion = (r: VersionRow, profiles: readonly PrintProfileRow[] = []): ListingVersion => {
  const printProfiles: NonNullable<ListingVersion['printProfiles']> = {}
  for (const p of profiles) {
    printProfiles[p.printer_model] = {
      process: p.process,
      filament: p.filament,
      ...opt('timeS', p.time_s),
      ...opt('grams', p.grams),
    }
  }
  return {
    id: r.id,
    listingId: r.listing_id,
    version: r.version,
    format: r.format,
    sizeBytes: r.size_bytes,
    sha256: r.sha256,
    createdAt: isoTime(r.created_at),
    scanStatus: r.scan_status,
    reviewStatus: r.review_status,
    ...opt('changelog', r.changelog),
    ...(profiles.length > 0 ? { printProfiles } : {}),
    ...colorsOf(r.colors),
  }
}

export const toFile = (r: FileRow): ListingFile => ({
  id: r.id,
  versionId: r.version_id,
  name: r.name,
  role: r.role,
  sizeBytes: r.size_bytes,
  sha256: r.sha256,
  ...opt('format', r.format),
})

export const toListing = (
  r: ListingRow,
  extra: { currentVersion?: ListingVersion; stats?: ListingStats; likedByMe?: boolean; savedByMe?: boolean } = {},
): Listing => ({
  id: r.id,
  creatorId: r.creator_id,
  slug: r.slug,
  title: r.title,
  license: r.license,
  status: r.status,
  tags: r.tags,
  createdAt: isoTime(r.created_at),
  ...opt('description', r.description),
  ...opt('coverUrl', r.cover_url),
  ...opt('reviewNote', r.review_note),
  ...opt('reviewedAt', r.reviewed_at === null ? null : isoTime(r.reviewed_at)),
  ...opt('publishedAt', r.published_at === null ? null : isoTime(r.published_at)),
  ...opt('currentVersion', extra.currentVersion),
  ...opt('stats', extra.stats),
  ...opt('likedByMe', extra.likedByMe),
  ...opt('savedByMe', extra.savedByMe),
})

type Author = Comment['author']
const unknownAuthor = (id: string | null): Author =>
  id === null ? { id: '', handle: 'deleted', displayName: 'Deleted member' } : { id, handle: 'member', displayName: 'Member' }

export const toComment = (r: CommentRow, author: Author | undefined): Comment => ({
  id: r.id,
  listingId: r.listing_id,
  author: author ?? unknownAuthor(r.user_id),
  body: r.body,
  createdAt: isoTime(r.created_at),
  ...opt('parentId', r.parent_id),
  ...opt('editedAt', r.edited_at === null ? null : isoTime(r.edited_at)),
})

export const toMake = (r: MakeRow, author: Author | undefined): Make => ({
  id: r.id,
  listingId: r.listing_id,
  author: author ?? unknownAuthor(r.user_id),
  createdAt: isoTime(r.created_at),
  ...opt('caption', r.caption),
  ...opt('photoUrl', r.photo_url),
  ...opt('printerModel', r.printer_model),
})

export const toCollection = (r: CollectionRow, listingIds: string[]): Collection => ({
  id: r.id,
  ownerId: r.owner_id,
  name: r.name,
  isPublic: r.is_public,
  listingIds,
})

export const toDevice = (r: PairedDeviceRow): AccountDevice => ({
  id: r.id,
  deviceId: r.device_id,
  name: r.name,
  platform: r.platform,
  signPub: r.sign_pub,
  linkedAt: isoTime(r.linked_at),
  ...opt('revokedAt', r.revoked_at === null ? null : isoTime(r.revoked_at)),
})

export const toAudit = (r: AuditRow): AuditEntry => ({
  id: r.id,
  at: isoTime(r.at),
  action: r.action,
  targetKind: r.target_kind,
  detail: r.detail,
  ...opt('actorId', r.actor_id),
  ...opt('targetId', r.target_id),
  ...opt('reason', r.reason),
})

export const toModerationItem = (r: QueueRow): ModerationItem => ({
  listingId: r.listing_id,
  slug: r.slug,
  title: r.title,
  status: r.status,
  submittedAt: isoTime(r.submitted_at),
  creatorId: r.creator_id,
  creatorHandle: r.creator_handle,
  creatorTrusted: r.creator_trusted,
  uploaderId: r.uploader_id,
  uploaderBanned: r.uploader_banned,
  creatorApprovedCount: Number(r.creator_approved_count),
  waitingVersions: Number(r.waiting_versions),
  ready: r.ready,
})

export const toDashboardRow = (r: DashboardDbRow): DashboardRow => ({
  listingId: r.listing_id,
  title: r.title,
  status: r.status,
  likes: Number(r.likes),
  comments: Number(r.comments),
  makes: Number(r.makes),
  downloads: Number(r.downloads),
})

/** Vault model files leave only as .sx3mf, except to their own creator (and staff). */
export const SEALED_FILE = /\.sx3mf$/i

/**
 * The version a download hands out: the newest approved, clean one, and for anyone but the listing's creator only
 * an .sx3mf (public_download_path in supabase/migrations/0013_creator_pages.sql).
 */
export function downloadVersion<T extends { version: string; storage_path: string; review_status: string; scan_status: string }>(versions: readonly T[], anyFormat: boolean): T | undefined {
  return latestVersion(versions.filter((v) => v.review_status === 'approved' && v.scan_status === 'clean' && (anyFormat || SEALED_FILE.test(v.storage_path))))
}

/** Newest version by semantic version number. */
export function latestVersion<T extends { version: string }>(versions: readonly T[]): T | undefined {
  const key = (v: string) => v.split('.').map((n) => Number(n))
  return [...versions].sort((a, b) => {
    const [x, y] = [key(a.version), key(b.version)]
    for (let i = 0; i < 3; i++) {
      const d = (y[i] ?? 0) - (x[i] ?? 0)
      if (d !== 0) return d
    }
    return 0
  })[0]
}

/** A version's stored colors, or nothing when there are none or they do not check out. */
function colorsOf(v: unknown): { colors?: ListingColors } {
  if (!v || typeof v !== 'object') return {}
  const c = validateListingColors(v as ListingColors)
  return c.ok ? { colors: c.value } : {}
}
