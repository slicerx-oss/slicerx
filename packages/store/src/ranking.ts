// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The library rows' ranking, the same rules as trending_listings, new_creators
// and recommended_listings in supabase/migrations/0013_creator_pages.sql. The
// offline store runs these; the database runs the SQL.
import type { DownloadRow, LikeRow, ListingRow, MakeRow } from './rows'

const DAY_MS = 86_400_000

/** What one event adds to a listing's trending score. */
export const TRENDING_WEIGHTS = { like: 3, make: 5, download: 1 } as const

export const clamp = (n: number | undefined, fallback: number, lo: number, hi: number): number => Math.min(Math.max(Math.round(n ?? fallback), lo), hi)

const newestFirst = (a: { score: number; publishedAt: string; id: string }, b: { score: number; publishedAt: string; id: string }) =>
  b.score - a.score || b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id)

export interface Scored {
  listingId: string
  score: number
}

/**
 * Trending: each listing's likes, makes and member downloads in the last `days`
 * days, weighted by TRENDING_WEIGHTS. A download counts once per member, by its
 * latest time. Listings with no activity in the window are left out. `listings`
 * must already be the approved ones the caller can see.
 */
export function trendingScores(
  d: { listings: readonly ListingRow[]; likes: readonly LikeRow[]; makes: readonly MakeRow[]; downloads: readonly DownloadRow[] },
  now: Date,
  opts: { days?: number; limit?: number } = {},
): Scored[] {
  const since = now.getTime() - clamp(opts.days, 7, 1, 90) * DAY_MS
  const recent = (t: string) => Date.parse(t) >= since
  const score = new Map<string, number>()
  const add = (id: string, n: number) => score.set(id, (score.get(id) ?? 0) + n)
  for (const x of d.likes) if (recent(x.created_at)) add(x.listing_id, TRENDING_WEIGHTS.like)
  for (const x of d.makes) if (recent(x.created_at)) add(x.listing_id, TRENDING_WEIGHTS.make)
  for (const x of d.downloads) if (recent(x.last_at)) add(x.listing_id, TRENDING_WEIGHTS.download)
  return d.listings
    .map((l) => ({ id: l.id, score: score.get(l.id) ?? 0, publishedAt: l.published_at ?? l.created_at }))
    .filter((x) => x.score > 0)
    .sort(newestFirst)
    .slice(0, clamp(opts.limit, 24, 1, 100))
    .map((x) => ({ listingId: x.id, score: x.score }))
}

/**
 * New creators: creators whose first approved listing went live in the last
 * `days` days, newest first. `creatorIds` are the creators the caller may see;
 * `listings` may hold any status, only approved ones count.
 */
export function newCreatorIds(
  d: { creatorIds: readonly string[]; listings: readonly ListingRow[] },
  now: Date,
  opts: { days?: number; limit?: number } = {},
): { creatorId: string; firstPublishedAt: string }[] {
  const since = now.getTime() - clamp(opts.days, 30, 1, 365) * DAY_MS
  const first = new Map<string, string>()
  for (const l of d.listings) {
    if (l.status !== 'approved' || !l.published_at) continue
    const was = first.get(l.creator_id)
    if (!was || l.published_at < was) first.set(l.creator_id, l.published_at)
  }
  return d.creatorIds
    .flatMap((id) => {
      const at = first.get(id)
      return at && Date.parse(at) >= since ? [{ creatorId: id, firstPublishedAt: at }] : []
    })
    .sort((a, b) => b.firstPublishedAt.localeCompare(a.firstPublishedAt) || a.creatorId.localeCompare(b.creatorId))
    .slice(0, clamp(opts.limit, 12, 1, 50))
}

/**
 * Based on your likes: each candidate gains, per tag it shares with a liked
 * listing, how many of the member's likes carry that tag, and twice the number
 * of likes the member gave its creator. Liked listings and the member's own
 * uploads (`ownCreatorIds`) are left out, as is anything scoring 0.
 * `candidates` are the approved listings the member can see; `liked` are the
 * listings the member liked, in any status.
 */
export function recommendedScores(
  d: { candidates: readonly ListingRow[]; liked: readonly ListingRow[]; ownCreatorIds: readonly string[] },
  opts: { limit?: number } = {},
): Scored[] {
  if (d.liked.length === 0) return []
  const tagWeight = new Map<string, number>()
  const creatorWeight = new Map<string, number>()
  for (const l of d.liked) {
    for (const t of new Set(l.tags)) tagWeight.set(t, (tagWeight.get(t) ?? 0) + 1)
    creatorWeight.set(l.creator_id, (creatorWeight.get(l.creator_id) ?? 0) + 1)
  }
  const likedIds = new Set(d.liked.map((l) => l.id))
  const own = new Set(d.ownCreatorIds)
  return d.candidates
    .filter((l) => !likedIds.has(l.id) && !own.has(l.creator_id))
    .map((l) => ({
      id: l.id,
      publishedAt: l.published_at ?? l.created_at,
      score: [...new Set(l.tags)].reduce((n, t) => n + (tagWeight.get(t) ?? 0), 0) + 2 * (creatorWeight.get(l.creator_id) ?? 0),
    }))
    .filter((x) => x.score > 0)
    .sort(newestFirst)
    .slice(0, clamp(opts.limit, 24, 1, 100))
    .map((x) => ({ listingId: x.id, score: x.score }))
}
