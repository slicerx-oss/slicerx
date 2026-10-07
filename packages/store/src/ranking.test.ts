// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { ListingRow } from './rows'
import { newCreatorIds, recommendedScores, trendingScores } from './ranking'

const NOW = new Date('2026-10-07T10:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

let n = 0
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
function listing(p: Partial<ListingRow> & { id: string }): ListingRow {
  return {
    creator_id: 'c1',
    slug: p.id,
    title: p.id,
    description: null,
    license: 'cc-by',
    status: 'approved',
    tags: [],
    cover_url: null,
    review_note: null,
    reviewed_by: null,
    reviewed_at: null,
    published_at: daysAgo(100),
    created_at: daysAgo(100),
    ...p,
  }
}
const like = (listing_id: string, age: number, user_id = uuid()) => ({ user_id, listing_id, created_at: daysAgo(age) })
const make = (listing_id: string, age: number) => ({ id: uuid(), listing_id, user_id: uuid(), caption: null, photo_url: null, printer_model: null, created_at: daysAgo(age) })
const download = (listing_id: string, age: number) => ({ user_id: uuid(), listing_id, count: 3, first_at: daysAgo(age + 20), last_at: daysAgo(age) })

describe('trending', () => {
  const listings = [listing({ id: 'a' }), listing({ id: 'b' }), listing({ id: 'c' }), listing({ id: 'd', published_at: daysAgo(1) })]

  it('weights likes 3, makes 5 and downloads 1 inside the window', () => {
    const out = trendingScores({ listings, likes: [like('a', 1), like('a', 2)], makes: [make('b', 3)], downloads: [download('c', 0), download('c', 6)] }, NOW)
    expect(out).toEqual([
      { listingId: 'a', score: 6 },
      { listingId: 'b', score: 5 },
      { listingId: 'c', score: 2 },
    ])
  })

  it('ignores activity older than the window, and counts a download once by its latest time', () => {
    const out = trendingScores({ listings, likes: [like('a', 8)], makes: [make('b', 30)], downloads: [download('c', 9)] }, NOW)
    expect(out).toEqual([])
  })

  it('widens with days', () => {
    const out = trendingScores({ listings, likes: [like('a', 8)], makes: [], downloads: [] }, NOW, { days: 30 })
    expect(out).toEqual([{ listingId: 'a', score: 3 }])
  })

  it('breaks ties by the newer listing, and caps the count', () => {
    const out = trendingScores({ listings, likes: [like('a', 1), like('d', 1)], makes: [], downloads: [] }, NOW)
    expect(out.map((x) => x.listingId)).toEqual(['d', 'a'])
    expect(trendingScores({ listings, likes: [like('a', 1), like('d', 1)], makes: [], downloads: [] }, NOW, { limit: 1 })).toHaveLength(1)
  })

  it('ranks only the listings it is given', () => {
    expect(trendingScores({ listings: [listings[1]!], likes: [like('a', 1)], makes: [], downloads: [] }, NOW)).toEqual([])
  })
})

describe('new creators', () => {
  it('finds creators whose first approved listing is recent, newest first', () => {
    const rows = [
      listing({ id: 'old', creator_id: 'veteran', published_at: daysAgo(200) }),
      listing({ id: 'new-from-veteran', creator_id: 'veteran', published_at: daysAgo(2) }),
      listing({ id: 'n1', creator_id: 'newbie', published_at: daysAgo(10) }),
      listing({ id: 'n2', creator_id: 'newbie', published_at: daysAgo(3) }),
      listing({ id: 'f1', creator_id: 'fresh', published_at: daysAgo(1) }),
    ]
    const out = newCreatorIds({ creatorIds: ['veteran', 'newbie', 'fresh'], listings: rows }, NOW)
    expect(out.map((x) => x.creatorId)).toEqual(['fresh', 'newbie'])
    expect(out[1]?.firstPublishedAt).toBe(daysAgo(10))
  })

  it('counts only approved listings', () => {
    const rows = [listing({ id: 'p', creator_id: 'x', status: 'pending', published_at: null }), listing({ id: 'r', creator_id: 'y', status: 'removed', published_at: daysAgo(1) })]
    expect(newCreatorIds({ creatorIds: ['x', 'y'], listings: rows }, NOW)).toEqual([])
  })

  it('leaves out creators the caller cannot see and those past the window', () => {
    const rows = [listing({ id: 'a', creator_id: 'hidden', published_at: daysAgo(1) }), listing({ id: 'b', creator_id: 'shown', published_at: daysAgo(40) })]
    expect(newCreatorIds({ creatorIds: ['shown'], listings: rows }, NOW)).toEqual([])
    expect(newCreatorIds({ creatorIds: ['shown'], listings: rows }, NOW, { days: 60 }).map((x) => x.creatorId)).toEqual(['shown'])
  })
})

describe('based on your likes', () => {
  const liked = [listing({ id: 'l1', creator_id: 'ferro', tags: ['tool', 'workshop'] }), listing({ id: 'l2', creator_id: 'marrow', tags: ['tool'] })]
  const candidates = [
    ...liked,
    listing({ id: 'shares-two-tags', creator_id: 'other', tags: ['tool', 'workshop'] }),
    listing({ id: 'same-creator', creator_id: 'ferro', tags: ['vase'] }),
    listing({ id: 'nothing-shared', creator_id: 'other', tags: ['vase'] }),
    listing({ id: 'mine', creator_id: 'me', tags: ['tool'] }),
  ]

  it('scores shared tags by how often they were liked and the same creator by twice its likes', () => {
    const out = recommendedScores({ candidates, liked, ownCreatorIds: ['me'] })
    expect(out).toEqual([
      { listingId: 'shares-two-tags', score: 3 },
      { listingId: 'same-creator', score: 2 },
    ])
  })

  it('leaves out liked listings, the member own uploads and anything with nothing shared', () => {
    const ids = recommendedScores({ candidates, liked, ownCreatorIds: ['me'] }).map((x) => x.listingId)
    expect(ids).not.toContain('l1')
    expect(ids).not.toContain('mine')
    expect(ids).not.toContain('nothing-shared')
  })

  it('is empty without likes', () => {
    expect(recommendedScores({ candidates, liked: [], ownCreatorIds: [] })).toEqual([])
  })

  it('does not count a tag twice when a listing repeats it', () => {
    const out = recommendedScores({ candidates: [listing({ id: 'dup', creator_id: 'z', tags: ['tool', 'tool'] })], liked, ownCreatorIds: [] })
    expect(out).toEqual([{ listingId: 'dup', score: 2 }])
  })
})
