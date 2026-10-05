// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Library's search, category and sort. The store applies them; the same
// rules run again on what comes back, so a client that ignores an option
// (the bundled demo catalog) still shows the right models.
import type { ListingCard, ListListingsOptions } from '@slicerx/contracts'
import { useSyncExternalStore } from 'react'

export type LibrarySort = 'new' | 'popular'

export interface LibraryFilter {
  /** 'all' or a tag. */
  category: string
  query: string
  sort: LibrarySort
}

export const CATEGORIES = ['all', 'figures', 'keychains', 'functional', 'home', 'cosplay', 'toys', 'minis'] as const

export const DEFAULT_FILTER: LibraryFilter = { category: 'all', query: '', sort: 'new' }

export function listOptions(f: LibraryFilter, cursor?: string, limit = 24): ListListingsOptions {
  const q = f.query.trim()
  return {
    limit,
    sort: f.sort,
    ...(f.category !== 'all' ? { tag: f.category } : {}),
    ...(q ? { query: q } : {}),
    ...(cursor ? { cursor } : {}),
  }
}

export function matchesFilter(card: ListingCard, f: LibraryFilter): boolean {
  const { listing, creator } = card
  if (f.category !== 'all' && !listing.tags.some((t) => t.toLowerCase() === f.category)) return false
  const q = f.query.trim().toLowerCase()
  if (!q) return true
  const hay = [listing.title, creator.displayName, creator.handle, ...listing.tags].join(' ').toLowerCase()
  return q.split(/\s+/).every((word) => hay.includes(word))
}

function printed(c: ListingCard): number {
  return c.listing.stats?.makes ?? 0
}

export function applyFilter(cards: readonly ListingCard[], f: LibraryFilter): ListingCard[] {
  const list = cards.filter((c) => matchesFilter(c, f))
  const when = (c: ListingCard) => c.listing.publishedAt ?? c.listing.createdAt
  if (f.sort === 'popular') return list.sort((a, b) => printed(b) - printed(a) || (b.listing.stats?.downloads ?? 0) - (a.listing.stats?.downloads ?? 0) || when(b).localeCompare(when(a)))
  return list.sort((a, b) => when(b).localeCompare(when(a)))
}

let current: LibraryFilter = DEFAULT_FILTER
const listeners = new Set<() => void>()

export function setLibraryFilter(patch: Partial<LibraryFilter>): void {
  current = { ...current, ...patch }
  for (const l of listeners) l()
}

export function useLibraryFilter(): LibraryFilter {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
    () => current,
  )
}
