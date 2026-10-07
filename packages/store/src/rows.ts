// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Database row shapes (snake_case, as PostgREST returns them). The offline seed
// uses the same shapes, so one set of mappers serves both modes.
import { z } from 'zod'
import { LINK_KINDS } from './validate'

export { LINK_KINDS }

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const ts = z.string().min(10)
const nullable = <T extends z.ZodType>(t: T) => t.nullable()
const format = z.enum(['3mf', 'sx3mf', 'stl'])
// numeric columns arrive as numbers from the seed and as numbers or strings from PostgREST.
const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number)])
const json = z.record(z.string(), z.unknown())

export const ROLES = ['owner', 'moderator', 'creator', 'member'] as const
export const LISTING_STATUSES = ['pending', 'approved', 'rejected', 'archived', 'removed'] as const
export const LICENSES = ['cc0', 'cc-by', 'cc-by-sa', 'cc-by-nc', 'cc-by-nc-sa', 'cc-by-nd', 'cc-by-nc-nd', 'custom'] as const

export const profileRow = z.object({
  id,
  handle: z.string(),
  display_name: z.string(),
  avatar_url: nullable(z.string()),
  role: z.enum(ROLES),
  banned_at: nullable(ts),
  ban_reason: nullable(z.string()),
})

export const creatorRow = z.object({
  id,
  owner_id: id,
  handle: z.string(),
  display_name: z.string(),
  tagline: nullable(z.string()),
  bio: nullable(z.string()),
  location: nullable(z.string()),
  logo_url: nullable(z.string()),
  // Added after the bundled seed was made; absent there.
  banner_url: nullable(z.string()).optional(),
  badges: z.array(z.string()).optional(),
  status: z.enum(['active', 'paused']),
  trusted: z.boolean(),
  created_at: ts,
})

export const creatorLinkRow = z.object({
  id,
  creator_id: id,
  kind: z.enum(LINK_KINDS),
  label: nullable(z.string()),
  url: z.string(),
  position: z.number().int(),
})

export const creatorFeaturedRow = z.object({ creator_id: id, listing_id: id, position: z.number().int() })

export const followRow = z.object({ user_id: id, creator_id: id, created_at: ts })

export const listingRow = z.object({
  id,
  creator_id: id,
  slug: z.string(),
  title: z.string(),
  description: nullable(z.string()),
  license: z.enum(LICENSES),
  status: z.enum(LISTING_STATUSES),
  tags: z.array(z.string()),
  cover_url: nullable(z.string()),
  review_note: nullable(z.string()),
  reviewed_by: nullable(id),
  reviewed_at: nullable(ts),
  published_at: nullable(ts),
  created_at: ts,
})

export const versionRow = z.object({
  id,
  listing_id: id,
  version: z.string(),
  changelog: nullable(z.string()),
  storage_path: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  format,
  size_bytes: num,
  scan_status: z.enum(['uploading', 'queued', 'scanning', 'clean', 'rejected']),
  scan_report: json.nullable().optional(),
  scanned_at: nullable(ts),
  review_status: z.enum(['pending', 'approved', 'rejected']),
  created_at: ts,
  // 0016_listing_colors; absent on a project without it. Checked again when mapped.
  colors: z.unknown().optional(),
})

export const fileRow = z.object({
  id,
  version_id: id,
  name: z.string(),
  role: z.enum(['model', 'plate', 'image', 'readme']),
  format: nullable(format),
  size_bytes: num,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})

export const printProfileRow = z.object({
  id,
  version_id: id,
  printer_model: z.string(),
  process: z.string(),
  filament: z.string(),
  layer_height_mm: nullable(num),
  nozzle_mm: nullable(num),
  time_s: nullable(z.number().int()),
  grams: nullable(num),
  plates: nullable(z.number().int()),
  notes: nullable(z.string()),
})

export const likeRow = z.object({ user_id: id, listing_id: id, created_at: ts })

export const commentRow = z.object({
  id,
  listing_id: id,
  // Null once the author deletes their account.
  user_id: nullable(id),
  parent_id: nullable(id),
  body: z.string(),
  created_at: ts,
  edited_at: nullable(ts),
  deleted_at: nullable(ts),
})

export const makeRow = z.object({
  id,
  listing_id: id,
  user_id: id,
  caption: nullable(z.string()),
  photo_url: nullable(z.string()),
  printer_model: nullable(z.string()),
  created_at: ts,
})

// kind 'saved' is the member's private Saved list. Absent in the bundled seed, where every collection is 'custom'.
export const collectionRow = z.object({ id, owner_id: id, name: z.string(), is_public: z.boolean(), kind: z.enum(['custom', 'saved']).optional(), created_at: ts })

export const collectionItemRow = z.object({ collection_id: id, listing_id: id, added_at: ts })

export const downloadRow = z.object({ user_id: id, listing_id: id, count: z.number().int(), first_at: ts, last_at: ts })

export const auditRow = z.object({
  id: z.number().int(),
  at: ts,
  actor_id: nullable(id),
  action: z.string(),
  target_kind: z.enum(['user', 'listing', 'version', 'creator', 'comment', 'setting']),
  target_id: nullable(id),
  reason: nullable(z.string()),
  detail: json,
})

export const MODERATION_MODES = ['owner-approves-all', 'moderators', 'trusted-creators', 'auto-after-scan'] as const

export const librarySettingsRow = z.object({
  id: z.boolean(),
  moderation_mode: z.enum(MODERATION_MODES),
  max_file_mb: z.number().int(),
  allowed_formats: z.array(format),
})

export const pairedDeviceRow = z.object({
  id,
  user_id: id,
  device_id: z.string(),
  name: z.string(),
  platform: z.enum(['ios', 'android', 'desktop', 'web']),
  sign_pub: z.string(),
  linked_at: ts,
  revoked_at: nullable(ts),
})

/** The moderation_queue view. */
export const queueRow = z.object({
  listing_id: id,
  slug: z.string(),
  title: z.string(),
  status: z.enum(LISTING_STATUSES),
  submitted_at: ts,
  creator_id: id,
  creator_handle: z.string(),
  creator_trusted: z.boolean(),
  uploader_id: id,
  uploader_banned: z.boolean(),
  creator_approved_count: num,
  waiting_versions: num,
  ready: z.boolean(),
})

export const dashboardRow = z.object({
  listing_id: id,
  title: z.string(),
  status: z.enum(LISTING_STATUSES),
  likes: num,
  comments: num,
  makes: num,
  downloads: num,
})

/** Seed-only: the auth users behind the profiles. Local stack and offline mode only. */
export const seedUserRow = z.object({ id, email: z.string(), handle: z.string(), display_name: z.string() })

export type ProfileRow = z.infer<typeof profileRow>
export type CreatorRow = z.infer<typeof creatorRow>
export type CreatorLinkRow = z.infer<typeof creatorLinkRow>
export type CreatorFeaturedRow = z.infer<typeof creatorFeaturedRow>
export type FollowRow = z.infer<typeof followRow>
export type ListingRow = z.infer<typeof listingRow>
export type VersionRow = z.infer<typeof versionRow>
export type FileRow = z.infer<typeof fileRow>
export type PrintProfileRow = z.infer<typeof printProfileRow>
export type LikeRow = z.infer<typeof likeRow>
export type CommentRow = z.infer<typeof commentRow>
export type MakeRow = z.infer<typeof makeRow>
export type CollectionRow = z.infer<typeof collectionRow>
export type CollectionItemRow = z.infer<typeof collectionItemRow>
export type DownloadRow = z.infer<typeof downloadRow>
export type AuditRow = z.infer<typeof auditRow>
export type LibrarySettingsRow = z.infer<typeof librarySettingsRow>
export type PairedDeviceRow = z.infer<typeof pairedDeviceRow>
export type QueueRow = z.infer<typeof queueRow>
export type DashboardDbRow = z.infer<typeof dashboardRow>
export type SeedUserRow = z.infer<typeof seedUserRow>

/** Table name to row schema, in dependency order for inserts. */
export const SEED_TABLES = {
  users: seedUserRow,
  profiles: profileRow,
  library_settings: librarySettingsRow,
  creators: creatorRow,
  creator_links: creatorLinkRow,
  follows: followRow,
  listings: listingRow,
  listing_versions: versionRow,
  listing_files: fileRow,
  print_profiles: printProfileRow,
  creator_featured: creatorFeaturedRow,
  likes: likeRow,
  comments: commentRow,
  makes: makeRow,
  collections: collectionRow,
  collection_items: collectionItemRow,
  downloads: downloadRow,
  audit_log: auditRow,
} as const

export type SeedTable = keyof typeof SEED_TABLES
export type SeedData = { [K in SeedTable]: z.infer<(typeof SEED_TABLES)[K]>[] }
