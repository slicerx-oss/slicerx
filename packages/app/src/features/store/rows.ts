// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Library's front page: one featured design, then rows in a fixed order.
import type { ListingCard } from '@slicerx/contracts'
import type { LibrarySort } from './filter'

export type RowId = 'popular' | 'recent' | 'trending' | 'liked'

/** Cards fetched for one row. */
export const ROW_LIMIT = 12

export interface RowSpec {
  id: RowId | 'new-creators'
  title: string
  /** The grid sort See all opens; absent for the creators row. */
  sort?: LibrarySort
  /** Only for a signed-in member, and hidden when empty. */
  signedIn?: boolean
}

/** Owner order (2026-10-07): popular, recent, trending this week, new creators, based on your likes. */
export const ROWS: RowSpec[] = [
  { id: 'popular', title: 'Most popular', sort: 'popular' },
  { id: 'recent', title: 'Recent', sort: 'new' },
  { id: 'trending', title: 'Trending this week', sort: 'trending' },
  { id: 'new-creators', title: 'New creators' },
  { id: 'liked', title: 'Based on your likes', sort: 'liked', signedIn: true },
]

/** The featured design: the top of this week's trending row, else the most popular design. */
export function pickFeatured(trending: readonly ListingCard[] | undefined, popular: readonly ListingCard[] | undefined): ListingCard | null {
  return trending?.[0] ?? popular?.[0] ?? null
}

/** The rows under the featured design, without it, so it does not show twice at the top. */
export function withoutFeatured(cards: readonly ListingCard[], featured: ListingCard | null): ListingCard[] {
  return featured ? cards.filter((c) => c.listing.id !== featured.listing.id) : [...cards]
}
