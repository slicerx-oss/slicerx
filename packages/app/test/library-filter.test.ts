// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { Creator, Listing, ListingCard } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { applyFilter, DEFAULT_FILTER, listOptions, showsGrid } from '../src/features/store/filter'

function card(id: string, title: string, o: { tags?: string[]; at?: string; makes?: number; downloads?: number; creator?: string } = {}): ListingCard {
  const creator = { id: `c-${id}`, handle: (o.creator ?? 'maker').toLowerCase(), displayName: o.creator ?? 'Maker' } as Creator
  const listing = {
    id,
    slug: id,
    title,
    tags: o.tags ?? [],
    publishedAt: o.at ?? '2026-01-01T00:00:00Z',
    createdAt: o.at ?? '2026-01-01T00:00:00Z',
    stats: { likes: 0, comments: 0, makes: o.makes ?? 0, downloads: o.downloads ?? 0 },
  } as Listing
  return { listing, creator }
}

const cards = [
  card('a', 'Dragon figure', { tags: ['figures', 'toys'], at: '2026-03-01T00:00:00Z', makes: 5, creator: 'Ada' }),
  card('b', 'Cable clip', { tags: ['functional'], at: '2026-05-01T00:00:00Z', makes: 40, creator: 'Bo' }),
  card('c', 'Key fob', { tags: ['keychains'], at: '2026-04-01T00:00:00Z', makes: 12, downloads: 9, creator: 'Ada' }),
]

describe('library filter', () => {
  it('sorts newest first by default', () => {
    expect(applyFilter(cards, DEFAULT_FILTER).map((c) => c.listing.id)).toEqual(['b', 'c', 'a'])
  })
  it('sorts most printed first', () => {
    expect(applyFilter(cards, { ...DEFAULT_FILTER, sort: 'popular' }).map((c) => c.listing.id)).toEqual(['b', 'c', 'a'])
    const swapped = [card('x', 'X', { makes: 1, at: '2026-09-01T00:00:00Z' }), card('y', 'Y', { makes: 9, at: '2026-01-01T00:00:00Z' })]
    expect(applyFilter(swapped, { ...DEFAULT_FILTER, sort: 'popular' }).map((c) => c.listing.id)).toEqual(['y', 'x'])
  })
  it('filters by category tag', () => {
    expect(applyFilter(cards, { ...DEFAULT_FILTER, category: 'toys' }).map((c) => c.listing.id)).toEqual(['a'])
  })
  it('searches title, creator and tags, every word must match', () => {
    const ids = (q: string) => applyFilter(cards, { ...DEFAULT_FILTER, query: q }).map((c) => c.listing.id)
    expect(ids('dragon')).toEqual(['a'])
    expect(ids('ada')).toEqual(['c', 'a'])
    expect(ids('ada key')).toEqual(['c'])
    expect(ids('functional')).toEqual(['b'])
    expect(ids('nothing here')).toEqual([])
  })
  it('does not change the input order', () => {
    const copy = [...cards]
    applyFilter(cards, { ...DEFAULT_FILTER, sort: 'popular' })
    expect(cards).toEqual(copy)
  })
  it('builds store options and leaves out empty ones', () => {
    expect(listOptions(DEFAULT_FILTER)).toEqual({ limit: 24, sort: 'new' })
    expect(listOptions({ ...DEFAULT_FILTER, category: 'home', query: '  vase ', sort: 'popular' }, 'p2')).toEqual({ limit: 24, sort: 'popular', tag: 'home', query: 'vase', cursor: 'p2' })
  })
  it('asks the store for the newest page under the ranked sorts', () => {
    expect(listOptions({ ...DEFAULT_FILTER, sort: 'trending' }).sort).toBe('new')
    expect(listOptions({ ...DEFAULT_FILTER, sort: 'liked' }).sort).toBe('new')
  })
  it('keeps a ranked list in the order it came', () => {
    expect(applyFilter(cards, { ...DEFAULT_FILTER, sort: 'trending' }, true).map((c) => c.listing.id)).toEqual(['a', 'b', 'c'])
    expect(applyFilter(cards, { ...DEFAULT_FILTER, sort: 'trending', query: 'ada' }, true).map((c) => c.listing.id)).toEqual(['a', 'c'])
  })
  it('shows the rows until a search, category, Saved or See all asks for the grid', () => {
    expect(showsGrid(DEFAULT_FILTER)).toBe(false)
    expect(showsGrid({ ...DEFAULT_FILTER, query: '  ' })).toBe(false)
    expect(showsGrid({ ...DEFAULT_FILTER, query: 'vase' })).toBe(true)
    expect(showsGrid({ ...DEFAULT_FILTER, category: 'toys' })).toBe(true)
    expect(showsGrid({ ...DEFAULT_FILTER, saved: true })).toBe(true)
    expect(showsGrid({ ...DEFAULT_FILTER, view: 'grid' })).toBe(true)
  })
})
