// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The free library and creator pages. Reads work signed out; the catalog is public.
import type { Creator, CreatorLink as StoreCreatorLink, Listing, ListingVersion } from '@slicerx/contracts'
import { useQuery } from '@tanstack/react-query'
import { cleanLinks, type CreatorDetail, type CreatorLink } from '../screens/creator-screen'
import type { LibraryEntry } from '../screens/library-screen'
import type { ModelDetail } from '../screens/model-screen'
import { usePocketHost } from './provider'

export interface CatalogItem {
  listing: Listing
  creator: Creator
}

export const catalogKeys = {
  feed: ['catalog', 'feed'] as const,
  listing: (slug: string) => ['catalog', 'listing', slug] as const,
  creator: (handle: string) => ['catalog', 'creator', handle] as const,
}

export function useCatalog() {
  const host = usePocketHost()
  return useQuery<CatalogItem[]>({
    queryKey: catalogKeys.feed,
    enabled: host.store !== null,
    queryFn: async () => (await host.store!.feed({ limit: 60 })).items.map(({ listing, creator }) => ({ listing, creator })),
  })
}

export function useListing(slug: string | undefined) {
  const host = usePocketHost()
  return useQuery({
    queryKey: catalogKeys.listing(slug ?? ''),
    enabled: host.store !== null && Boolean(slug),
    queryFn: () => host.store!.getListing(slug!),
  })
}

export function useCreatorPage(handle: string | undefined) {
  const host = usePocketHost()
  return useQuery({
    queryKey: catalogKeys.creator(handle ?? ''),
    enabled: host.store !== null && Boolean(handle),
    queryFn: () => host.store!.getCreatorByHandle(handle!),
  })
}

const kb = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`)

export function toEntry(listing: Listing, creator?: Creator): LibraryEntry {
  return {
    id: `listing-${listing.id}`,
    slug: listing.slug,
    name: listing.title,
    format: listing.currentVersion?.format ?? '3mf',
    tags: listing.tags,
    ...(creator ? { creator: creator.displayName } : {}),
    ...(listing.coverUrl ? { thumbUri: listing.coverUrl } : {}),
  }
}

const mins = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.round(s / 60)} min`)

export function toModelDetail(listing: Listing, creator: Creator, versions: ListingVersion[]): ModelDetail {
  const v = listing.currentVersion ?? versions[0]
  return {
    id: listing.id,
    title: listing.title,
    description: listing.description,
    coverUri: listing.coverUrl,
    creator: { name: creator.displayName, handle: creator.handle, avatarUri: creator.logoUrl },
    tags: listing.tags,
    format: v?.format,
    version: v?.version,
    sizeLabel: v ? kb(v.sizeBytes) : undefined,
    changelog: v?.changelog,
    profiles: Object.entries(v?.printProfiles ?? {}).map(([printer, p]) => ({
      printer,
      detail: [p.process, p.filament, p.timeS ? mins(p.timeS) : null, p.grams ? `${p.grams} g` : null].filter(Boolean).join(', '),
    })),
    likes: listing.stats?.likes,
    makes: listing.stats?.makes,
  }
}

/** The creator's own links (Patreon, a website, MakerWorld), checked and named by site when unlabeled. */
export function creatorLinks(links: StoreCreatorLink[]): CreatorLink[] {
  return cleanLinks([...links].sort((a, b) => a.position - b.position).map((l) => ({ label: l.label, url: l.url })))
}

export function toCreatorDetail(c: Creator): CreatorDetail {
  return { name: c.displayName, tagline: c.tagline, bio: c.bio, avatarUri: c.logoUrl, followers: c.followers }
}
