// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Auth and the free, moderated model library as the app sees them.
// Ids are UUID strings. Times are ISO 8601 UTC strings.
import type { Host } from './host'
import type { SlicerHost } from './slice'

/**
 * pending: waiting for review. approved: public. rejected: sent back with a
 * note. archived: hidden by its creator. removed: taken down by staff.
 */
export type ListingStatus = 'pending' | 'approved' | 'rejected' | 'archived' | 'removed'
export type ListingLicense = 'cc0' | 'cc-by' | 'cc-by-sa' | 'cc-by-nc' | 'cc-by-nc-sa' | 'cc-by-nd' | 'cc-by-nc-nd' | 'custom'
export type FileFormat = '3mf' | 'sx3mf' | 'stl'
/** uploading: row made, file going to quarantine. queued: waiting for the scan. scanning: claimed by a worker. clean: passed. rejected: failed a check. */
export type ScanStatus = 'uploading' | 'queued' | 'scanning' | 'clean' | 'rejected'
export type ReviewStatus = 'pending' | 'approved' | 'rejected'
export type AuthProvider = 'github' | 'google' | 'apple' | 'discord'
/** A way to sign in: the email magic link or an OAuth provider. */
export type SignInMethod = 'email' | AuthProvider

/** Who a member is on the platform. The owner is unique; moderators and creators are assigned. */
export type MemberRole = 'owner' | 'moderator' | 'creator' | 'member'
/** What my_role() answers: a banned account reads as 'banned'. */
export type EffectiveRole = MemberRole | 'banned'
/**
 * 'owner-approves-all': only the owner approves. 'moderators': moderators approve too.
 * 'trusted-creators': as moderators, and a clean upload from a trusted creator goes live at once.
 * 'auto-after-scan': a clean upload from anyone goes live at once; staff review afterwards.
 */
export type ModerationMode = 'owner-approves-all' | 'moderators' | 'trusted-creators' | 'auto-after-scan'

/** The library's rules, readable by everyone. The edition config supplies them; the owner can change the mode. */
export interface LibrarySettings {
  moderationMode: ModerationMode
  /** Largest model file, in megabytes. */
  maxFileMb: number
  allowedFormats: FileFormat[]
}

export interface Profile {
  id: string
  handle: string
  displayName: string
  avatarUrl?: string
  role?: MemberRole
  bannedAt?: string
  banReason?: string
}

export type CreatorLinkKind =
  | 'website'
  | 'patreon'
  | 'makerworld'
  | 'printables'
  | 'thingiverse'
  | 'cults3d'
  | 'youtube'
  | 'instagram'
  | 'tiktok'
  | 'x'
  | 'discord'
  | 'github'
  | 'kofi'
  | 'buymeacoffee'
  | 'other'

export interface CreatorLink {
  id: string
  kind: CreatorLinkKind
  label?: string
  url: string
  position: number
}

/** A link as a creator enters it. The client checks it against the same rules as the database. */
export interface CreatorLinkInput {
  kind: CreatorLinkKind
  label?: string | undefined
  url: string
}

/** A creator page. One member has at most one. */
export interface Creator {
  id: string
  /** The page address: /creators/<handle>. */
  handle: string
  displayName: string
  tagline?: string
  bio?: string
  location?: string
  logoUrl?: string
  /** A wide image across the top of the page. */
  bannerUrl?: string
  /** Tags staff set on the page, such as "N3D team". The creator cannot change them. */
  badges?: string[]
  /** On the new creators row: when their first approved listing went live. */
  firstPublishedAt?: string
  followers: number
  ownerId: string
  status: 'active' | 'paused'
  /** Set by the owner; under moderation mode 'trusted' clean uploads from this creator go live at once. */
  trusted: boolean
  createdAt: string
  /** Approved listings, on directory rows. */
  listingCount?: number
  /** Signed-in member only. */
  followedByMe?: boolean
}

/** A print profile the creator tested for one version on one printer model. */
export interface PrintProfile {
  id: string
  versionId: string
  printerModel: string
  process: string
  filament: string
  layerHeightMm?: number
  nozzleMm?: number
  timeS?: number
  grams?: number
  plates?: number
  notes?: string
}

export interface ListingFile {
  id: string
  versionId: string
  name: string
  role: 'model' | 'plate' | 'image' | 'readme'
  format?: FileFormat
  sizeBytes: number
  sha256: string
}

export interface ListingVersion {
  id: string
  listingId: string
  version: string
  changelog?: string
  format: FileFormat
  sizeBytes: number
  sha256: string
  createdAt: string
  scanStatus: ScanStatus
  reviewStatus: ReviewStatus
  /** Print profiles the creator tested, keyed by printer model. */
  printProfiles?: Record<string, { process: string; filament: string; timeS?: number; grams?: number }>
  /** The filament colors the model prints in and which parts need more than one. */
  colors?: ListingColors
}

/** One filament color of a model: `#rrggbb` and the creator's name for it ("Silk gold"). */
export interface ListingColor {
  hex: string
  name?: string
}

/** A printed part (a plate object) and the colors it uses, as indexes into `ListingColors.colors`. */
export interface ListingPart {
  name: string
  colors: number[]
  /** Needs a filament changer (AMS): set from the file when the part uses more than one color, the creator may change it. */
  ams: boolean
}

/** A model's colors in the creator's order, read from its 3MF on upload and edited by the creator. */
export interface ListingColors {
  colors: ListingColor[]
  parts: ListingPart[]
}

export interface ListingStats {
  likes: number
  makes: number
  comments: number
  downloads: number
}

export interface Listing {
  id: string
  creatorId: string
  slug: string
  title: string
  description?: string
  license: ListingLicense
  status: ListingStatus
  tags: string[]
  coverUrl?: string
  /** Why staff rejected or removed it. Shown to the creator. */
  reviewNote?: string
  reviewedAt?: string
  publishedAt?: string
  createdAt: string
  /** The newest version the caller may see: approved for everyone, any stage for the creator and staff. */
  currentVersion?: ListingVersion
  stats?: ListingStats
  /** Signed-in member only. */
  likedByMe?: boolean
  /** Signed-in member only: on the member's private Saved list. */
  savedByMe?: boolean
}

export interface ListingCard {
  listing: Listing
  creator: Creator
}

export interface FeedItem extends ListingCard {
  reason: 'following' | 'popular' | 'new'
  makes: number
}

/** A creator page as visitors see it. */
export interface CreatorPage {
  creator: Creator
  links: CreatorLink[]
  /** Up to six approved listings the creator chose to show first, in order. */
  featured: Listing[]
  /** Approved listings, newest first. */
  listings: Listing[]
}

export interface ListingDetail {
  listing: Listing
  creator: Creator
  /** Versions the caller may see, newest first. */
  versions: ListingVersion[]
}

export interface Comment {
  id: string
  listingId: string
  author: Pick<Profile, 'id' | 'handle' | 'displayName'>
  body: string
  parentId?: string
  createdAt: string
  editedAt?: string
}

/** A member's photo or note of a finished print. */
export interface Make {
  id: string
  listingId: string
  author: Pick<Profile, 'id' | 'handle' | 'displayName'>
  caption?: string
  photoUrl?: string
  printerModel?: string
  createdAt: string
}

export interface Collection {
  id: string
  ownerId: string
  name: string
  isPublic: boolean
  listingIds: string[]
}

export interface Session {
  userId: string
  email?: string
  handle?: string
  displayName?: string
  role?: EffectiveRole
  /** The member's creator page, when they have made one. */
  creatorId?: string
}

export type StoreErrorCode =
  | 'not_signed_in'
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'conflict'
  | 'unavailable'
  | 'offline'
  /** Too many downloads without signing in from one network; signing in lifts the limit. */
  | 'rate_limited'

export type StoreResult<T> = { ok: true; value: T } | { ok: false; code: StoreErrorCode; message: string }

export interface ListListingsOptions {
  cursor?: string
  limit?: number
  /** Only listings with this tag. */
  tag?: string
  creatorId?: string
  /** Matches title and tags. */
  query?: string
  /** Defaults to 'new'. */
  sort?: 'new' | 'popular'
  /** Defaults to 'approved'. Other statuses show only what the caller may see: their own, or all for staff. */
  status?: ListingStatus
}

export interface CreateListingInput {
  /** Defaults to a slug made from the title. */
  slug?: string
  title: string
  description?: string
  license?: ListingLicense
  tags?: string[]
  coverUrl?: string
}

export interface UpdateListingInput {
  slug?: string
  title?: string
  description?: string | null
  license?: ListingLicense
  tags?: string[]
  coverUrl?: string | null
}

/** A model file for a new version. */
export interface UploadVersionInput {
  /** File name, lowercase, ending .3mf, .sx3mf or .stl. */
  name: string
  /** Semantic version, for example 1.2.0. */
  version: string
  changelog?: string
  bytes: Uint8Array
  format: FileFormat
  /** How the creator printed it, shown on the listing. */
  printProfile?: UploadPrintProfile
  /** The model's filament colors, shown on the listing. */
  colors?: ListingColors
}

/** One tested print of an upload: the printer, the presets and what the slicer measured. */
export interface UploadPrintProfile {
  printerModel: string
  process: string
  filament: string
  layerHeightMm?: number
  nozzleMm?: number
  timeS?: number
  grams?: number
}

export interface ScanState {
  scanStatus: ScanStatus
  reviewStatus: ReviewStatus
}

export interface DownloadLink {
  /** Where to fetch the file. Signed in: a signed URL, valid for a short time. Signed out: a direct storage URL that needs `headers`. */
  url: string
  /** Request headers the fetch must send. Set only for a signed-out download, where they carry the anon key and a grant valid for about two minutes. */
  headers?: Record<string, string>
  versionId: string
  version: string
  fileName: string
}

export interface SaveCreatorInput {
  handle: string
  displayName: string
  tagline?: string | null
  bio?: string | null
  location?: string | null
  logoUrl?: string | null
  bannerUrl?: string | null
  status?: 'active' | 'paused'
}

/** Which creator page image an upload replaces. */
/** banner and logo belong to the creator page; cover is a listing's picture. */
export type CreatorImageKind = 'banner' | 'logo' | 'cover'

export interface CreatorImageInput {
  kind: CreatorImageKind
  bytes: Uint8Array
  /** image/png, image/jpeg or image/webp; a banner may also be image/gif, stored as is so it stays animated. */
  contentType: string
}

export interface DashboardRow {
  listingId: string
  title: string
  status: ListingStatus
  likes: number
  comments: number
  makes: number
  downloads: number
}

/** One row of the review queue: a pending listing, or an approved one with a new version waiting. */
export interface ModerationItem {
  listingId: string
  slug: string
  title: string
  status: ListingStatus
  submittedAt: string
  creatorId: string
  creatorHandle: string
  creatorTrusted: boolean
  uploaderId: string
  uploaderBanned: boolean
  creatorApprovedCount: number
  waitingVersions: number
  /** True when every waiting version has passed the upload scan. */
  ready: boolean
}

export interface AuditEntry {
  id: number
  at: string
  /** Absent for automatic actions and after the actor deletes their account. */
  actorId?: string
  action: string
  targetKind: 'user' | 'listing' | 'version' | 'creator' | 'comment' | 'setting'
  targetId?: string
  reason?: string
  detail: Record<string, unknown>
}

/** What a personal API token may be used for. */
export type ApiTokenScope = 'read' | 'mcp' | 'cli' | 'cloud_slice' | 'link' | 'sxlock_open' | 'sxlock_seal'

/**
 * Why the account side of a locked project (.sxlock, packages/sx3mf/SPEC-sxlock.md) said no. `offline`: the
 * account service could not be reached, and locked projects open only online. `unavailable`: this build has
 * no account service at all.
 */
export type SxlockFailure = 'offline' | 'unavailable' | 'signed_out' | 'wrong_account' | 'revoked' | 'unknown_key' | 'missing_scope' | 'rate_limited' | 'banned' | 'invalid'

export type SxlockResult<T> = { ok: true; value: T } | { ok: false; reason: SxlockFailure; message: string }

/** What a locked file's header names: its owner, the account key and the file's salt (64 hex digits). */
export interface SxlockKeyRef {
  owner: string
  keyId: string
  salt: string
}

/** A content key for a new locked file (64 hex digits) and the header fields it goes with. */
export interface SxlockSealed {
  owner: string
  keyId: string
  contentKey: string
}

/**
 * The account side of locked projects as the format code needs it: the signed-in store, or an integrator's token
 * (tokenKeys in @slicerx/embed/sxlock).
 */
export interface SxlockKeys {
  /** Absent for an opener that may not export. */
  seal?(salt: string): Promise<SxlockResult<SxlockSealed>>
  open(ref: SxlockKeyRef): Promise<SxlockResult<string>>
}

/** One of the account's locked-project keys. The secret itself stays on the server. */
export interface SxlockAccountKey {
  id: string
  createdAt: string
  /** A newer key took over; files locked with this one still open. */
  retiredAt?: string
  /** Revoked: files locked with this key no longer open. */
  revokedAt?: string
}

/** A personal API token for integrations (the SlicerX MCP server, the CLI, cloud features). */
export interface ApiToken {
  id: string
  name: string
  /** First 12 characters of the token, for telling tokens apart. */
  prefix: string
  scopes: ApiTokenScope[]
  /** Requests allowed per minute; the cloud service answers 429 beyond it. */
  rateLimitPerMinute: number
  createdAt: string
  expiresAt?: string
  lastUsedAt?: string
  /** Client address of the last accepted request, as the service reported it. */
  lastUsedIp?: string
  revokedAt?: string
}

export type DevicePlatform = 'ios' | 'android' | 'desktop' | 'web'

/** A phone or other device linked to the account by the pairing flow. Holds only the public signing key. */
export interface AccountDevice {
  id: string
  /** The device's own identifier from the pairing protocol. */
  deviceId: string
  name: string
  platform: DevicePlatform
  /** Ed25519 public key, base64 or base64url. */
  signPub: string
  linkedAt: string
  revokedAt?: string
}

export interface AddPairedDeviceInput {
  deviceId: string
  name: string
  platform: DevicePlatform
  signPub: string
}

/** What onPairedDeviceChange reports: a device was linked, or revoked from anywhere. */
export interface PairedDeviceEvent {
  type: 'added' | 'revoked'
  device: AccountDevice
}

/** What deleting an account removes and keeps, and how long the grace period is. */
export interface AccountDeletionPolicy {
  graceDays: number
  removed: string[]
  kept: string[]
}

export interface AccountDeletionPlan extends AccountDeletionPolicy {
  /** When the account is removed, unless the member cancels first. */
  purgeAfter: string
}

/**
 * Everything stored about the member, as the server returns it (snake_case
 * rows, one key per section). Sections depend on the installed modules; the
 * store adds paired_devices, downloads, creator_page, listings,
 * listing_versions and creator_links next to likes, follows, comments, makes
 * and collections.
 */
export type AccountExport = { format: 'slicerx-account-export'; version: number; exported_at: string } & Record<string, unknown>

/**
 * Sign-in, session, API tokens and paired devices. This part stays when the
 * store module is removed; a build without the store uses an AuthClient on its own.
 */
export interface AuthClient {
  /** 'offline' serves the bundled seed; 'supabase' talks to a project. */
  readonly mode: 'offline' | 'supabase'
  session(): Promise<Session | null>
  /** The sign-in methods this build offers, in display order. Others are refused. */
  signInMethods(): SignInMethod[]
  /** Sends a magic link that returns to the host's auth redirect URL. */
  signInWithEmail(email: string): Promise<StoreResult<void>>
  /** Starts an OAuth flow. Resolves once the browser or system browser is open. */
  signInWithOAuth(provider: AuthProvider): Promise<StoreResult<void>>
  /** Finishes a PKCE flow from the redirect or deep link URL that carries the code. */
  completeSignIn(callbackUrl: string): Promise<StoreResult<Session>>
  signOut(): Promise<void>
  onSessionChange(cb: (s: Session | null) => void): () => void
  /**
   * The signed-in user's access token (a short-lived JWT) for edition services
   * such as cloud slicing. Refreshed first when it expires within a minute.
   * Null when signed out, and always null offline.
   */
  getAccessToken(): Promise<string | null>
  /** Same as getAccessToken(). */
  accessToken(): Promise<string | null>
  /** Called with the new access token after sign-in, refresh and sign-out (null). */
  onTokenChange(cb: (token: string | null) => void): () => void

  apiTokens(): Promise<ApiToken[]>
  /** The secret is returned once and never stored in readable form. */
  createApiToken(input: { name: string; scopes: ApiTokenScope[]; expiresInDays?: number | null; rateLimitPerMinute?: number }): Promise<StoreResult<{ token: ApiToken; secret: string }>>
  revokeApiToken(id: string): Promise<StoreResult<void>>
  /** Revokes every active token of the member, for example after a leak. */
  revokeAllApiTokens(): Promise<StoreResult<{ revoked: number }>>

  /** A content key for a new locked project, under the account's active key. `salt` is 32 random bytes as hex. */
  sxlockSeal(salt: string): Promise<SxlockResult<SxlockSealed>>
  /** The content key of a locked project; only the owning account gets it, and only online. */
  sxlockOpen(ref: SxlockKeyRef): Promise<SxlockResult<string>>
  /** The account's locked-project keys, newest first. */
  sxlockKeys(): Promise<SxlockAccountKey[]>
  /** Retires the active key; locked projects made before still open, new ones use a new key. */
  rotateSxlockKey(): Promise<SxlockResult<SxlockAccountKey>>
  /** Revokes a key for good: every project locked with it stops opening. */
  revokeSxlockKey(id: string): Promise<SxlockResult<void>>

  /** Devices linked by the phone pairing flow, newest first, revoked ones included. */
  listPairedDevices(): Promise<AccountDevice[]>
  /** Links a device. An account holds at most 10 active devices. */
  addPairedDevice(input: AddPairedDeviceInput): Promise<StoreResult<AccountDevice>>
  /** Marks the device revoked. Every client subscribed through onPairedDeviceChange learns at once. */
  revokePairedDevice(id: string): Promise<StoreResult<void>>
  /** Reports devices added or revoked on this account, from any client. Uses Realtime; offline it reports this client's own changes. */
  onPairedDeviceChange(cb: (e: PairedDeviceEvent) => void): () => void

  /** A JSON document with everything stored about the member, for download. */
  exportMyData(): Promise<StoreResult<AccountExport>>
  accountDeletionPolicy(): Promise<AccountDeletionPolicy>
  /** Schedules deletion after the grace period and revokes API tokens now. The owner account cannot request deletion. */
  requestAccountDeletion(): Promise<StoreResult<AccountDeletionPlan>>
  cancelAccountDeletion(): Promise<StoreResult<void>>
  /** The scheduled deletion, if any. */
  pendingAccountDeletion(): Promise<{ requestedAt: string; purgeAfter: string } | null>
}

/** The free model library: browsing, creator pages, uploads and moderation. A removable module on top of AuthClient. */
export interface StoreClient extends AuthClient {
  // Library
  /** Approved listings, newest first unless sorted otherwise. */
  listListings(opts?: ListListingsOptions): Promise<{ items: ListingCard[]; next?: string }>
  /** The storefront feed: approved listings with why each one is shown. */
  feed(opts?: { cursor?: string; limit?: number; category?: string }): Promise<{ items: FeedItem[]; next?: string }>
  /** By id or slug. Null when the listing does not exist or the caller may not see it. */
  getListing(idOrSlug: string): Promise<ListingDetail | null>
  /** The signed-in creator's own listings in every status. */
  myListings(): Promise<Listing[]>
  /** New listings start pending. Needs a creator page. */
  createListing(input: CreateListingInput): Promise<StoreResult<Listing>>
  /** Editing an approved or archived listing sends it back to review. */
  updateListing(id: string, patch: UpdateListingInput): Promise<StoreResult<Listing>>
  /** Approved to archived. */
  archiveListing(id: string): Promise<StoreResult<void>>
  /** Archived back to approved. */
  unarchiveListing(id: string): Promise<StoreResult<void>>
  /** Rejected back to pending. */
  resubmitListing(id: string): Promise<StoreResult<void>>
  /** Pending, rejected and archived listings only. */
  deleteListing(id: string): Promise<StoreResult<void>>
  /** Approved listings ranked by likes, makes and downloads in the last `days` days (default 7). Listings with no activity are left out. */
  trending(opts?: { days?: number; limit?: number }): Promise<ListingCard[]>
  /** Creators whose first approved listing went live in the last `days` days (default 30), newest first. */
  newCreators(opts?: { days?: number; limit?: number }): Promise<Creator[]>
  /** Approved listings sharing tags or a creator with the signed-in member's likes. Empty when signed out or without likes. */
  recommended(opts?: { limit?: number }): Promise<ListingCard[]>
  /** The signed-in member's private Saved list, newest save first. Empty when signed out. */
  savedListings(): Promise<ListingCard[]>
  setSaved(listingId: string, saved: boolean): Promise<StoreResult<void>>
  like(listingId: string): Promise<StoreResult<void>>
  unlike(listingId: string): Promise<StoreResult<void>>
  /** Comments and collections are deferred past v1: the SlicerX edition's client returns none and refuses writes with 'unavailable'. */
  comments(listingId: string): Promise<Comment[]>
  addComment(listingId: string, body: string, parentId?: string): Promise<StoreResult<Comment>>
  editComment(id: string, body: string): Promise<StoreResult<Comment>>
  /** Soft delete through the database function; the text is removed. The author or staff. */
  deleteComment(id: string): Promise<StoreResult<void>>
  makes(listingId: string): Promise<Make[]>
  addMake(listingId: string, input: { caption?: string; photoUrl?: string; printerModel?: string }): Promise<StoreResult<Make>>
  collections(): Promise<Collection[]>
  createCollection(name: string, isPublic?: boolean): Promise<StoreResult<Collection>>
  setInCollection(collectionId: string, listingId: string, present: boolean): Promise<StoreResult<void>>
  follow(creatorId: string): Promise<StoreResult<void>>
  unfollow(creatorId: string): Promise<StoreResult<void>>
  /** Counts for listing cards, keyed by listing id. Listings the caller cannot see are missing. */
  listingStats(listingIds: string[]): Promise<Record<string, ListingStats>>
  printProfiles(versionId: string): Promise<PrintProfile[]>
  files(versionId: string): Promise<ListingFile[]>
  /**
   * Returns a link to the newest approved, clean version's .sx3mf (the listing's own creator gets the newest file in
   * any format) and counts the download once the link is made. Works signed out, where downloads are limited per
   * network (rate_limited) unless the owner turned that off.
   */
  download(listingId: string): Promise<StoreResult<DownloadLink>>

  // Upload
  /** Checks the file against the library settings, records the version, puts the bytes in the uploads-quarantine bucket and queues the scan. */
  uploadVersion(listingId: string, input: UploadVersionInput): Promise<StoreResult<ListingVersion>>
  /** Replaces a version's colors; null clears them. The listing's creator only. Does not send the listing back to review. */
  setVersionColors(versionId: string, colors: ListingColors | null): Promise<StoreResult<ListingVersion>>
  getScanStatus(versionId: string): Promise<StoreResult<ScanState>>
  /** The scan report. The creator and staff only; null while no scan has finished. */
  getScanReport(versionId: string): Promise<StoreResult<Record<string, unknown> | null>>

  // Creator
  getMyCreator(): Promise<Creator | null>
  /** Makes the page on first call, updates it after. */
  saveCreator(input: SaveCreatorInput): Promise<StoreResult<Creator>>
  /** Replaces every link. At most 12, https only, service links on the service's own domain. */
  setCreatorLinks(links: CreatorLinkInput[]): Promise<StoreResult<CreatorLink[]>>
  /** Stores a banner, logo or listing cover for the signed-in creator and returns its public URL, for saveCreator or a listing's coverUrl. PNG, JPEG or WebP up to 5 MB; a banner may also be a GIF, kept as is. */
  uploadCreatorImage(input: CreatorImageInput): Promise<StoreResult<string>>
  /** Removes an image uploadCreatorImage stored that the page does not use, such as one a failed save left behind. An image the page shows is kept. */
  removeCreatorImage(url: string): Promise<StoreResult<void>>
  /** Replaces the featured models: up to six of the creator's approved listings, in order. The first is the pinned design. */
  setFeatured(listingIds: string[]): Promise<StoreResult<void>>
  getCreatorByHandle(handle: string): Promise<CreatorPage | null>
  /** A creator's approved listings, newest first. Empty for an unknown or hidden creator. Works signed out. */
  listCreatorListings(handle: string): Promise<Listing[]>
  /** The library's moderation mode, file size limit and accepted formats. Falls back to the defaults (100 MB, all three formats) when unreachable. */
  getLibrarySettings(): Promise<LibrarySettings>
  /** The creator directory, largest following first. Only creators with an approved listing, unless the caller is staff or the creator. */
  listCreators(opts?: { query?: string; limit?: number }): Promise<Creator[]>
  creatorDashboard(): Promise<StoreResult<DashboardRow[]>>

  // Moderation. Staff only unless noted; errors carry the database's message.
  moderationQueue(): Promise<StoreResult<ModerationItem[]>>
  approveListing(id: string, note?: string): Promise<StoreResult<void>>
  /** The reason is required (3 characters or more) and shown to the creator. */
  rejectListing(id: string, reason: string): Promise<StoreResult<void>>
  removeListing(id: string, reason: string): Promise<StoreResult<void>>
  banUser(userId: string, reason: string): Promise<StoreResult<void>>
  unbanUser(userId: string, reason?: string): Promise<StoreResult<void>>
  /** Newest first. `before` is the id of the last entry already loaded. */
  auditLog(opts?: { limit?: number; before?: number }): Promise<StoreResult<AuditEntry[]>>
  getModerationMode(): Promise<ModerationMode>
  /** Owner only. */
  setModerationMode(mode: ModerationMode): Promise<StoreResult<void>>
  /** Owner only. Assigns moderator, creator or member. */
  setUserRole(userId: string, role: Exclude<MemberRole, 'owner'>, reason?: string): Promise<StoreResult<void>>
  /** Owner only. */
  setCreatorTrusted(creatorId: string, trusted: boolean): Promise<StoreResult<void>>
  /** The caller's role; 'banned' for a banned account, null when signed out. */
  myRole(): Promise<EffectiveRole | null>
}

/** Sign-in plumbing the platform provides: where OAuth returns, opening the system browser, deep links. */
export interface AuthHost {
  redirectUrl(): string
  openExternal(url: string): Promise<void>
  onDeepLink(cb: (url: string) => void): () => void
}

/** The SlicerX edition's host: the base Host plus the store, sign-in and cloud slicing (cloud is off for v1). */
export interface EditionHost extends Host {
  store?: StoreClient
  /**
   * Keys for locked projects when the host has no store of its own, such as an app that embeds SlicerX and acts
   * for its signed-in account with a token (tokenKeys). Absent: the store's session is used.
   */
  sxlock?: SxlockKeys
  auth?: AuthHost
  cloud?: SlicerHost
}
