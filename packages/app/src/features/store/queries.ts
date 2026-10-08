// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Catalog and session queries over the edition host's store client.
import type { Creator, CreatorPage, EditionHost, ListingCard, ListingDetail, Session, StoreClient } from '@slicerx/contracts'
import { useHost } from '@slicerx/app'
import { infiniteQueryOptions, queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { applyFilter, listOptions, type LibraryFilter } from './filter'
import { ROW_LIMIT, type RowId } from './rows'

export function useStore(): StoreClient | undefined {
  return (useHost() as EditionHost).store
}

/** The full grid. The Saved filter and the ranked sorts come as one list from the store; the rest pages through the catalog. */
export function listingsQuery(store: StoreClient | undefined, f: LibraryFilter, signedIn = false) {
  return infiniteQueryOptions({
    queryKey: ['library', f.category, f.query.trim(), f.sort, f.saved, signedIn],
    queryFn: async ({ pageParam }): Promise<{ items: ListingCard[]; next: string | undefined }> => {
      if (!store) return { items: [], next: undefined }
      if (f.saved) return { items: applyFilter(await store.savedListings(), f, f.sort !== 'new' && f.sort !== 'popular'), next: undefined }
      if (f.sort === 'trending') return { items: applyFilter(await store.trending({ limit: 100 }), f, true), next: undefined }
      if (f.sort === 'liked') return { items: applyFilter(signedIn ? await store.recommended({ limit: 100 }) : [], f, true), next: undefined }
      const page = await store.listListings(listOptions(f, pageParam))
      return { items: applyFilter(page.items, f), next: page.next }
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next,
    staleTime: 60_000,
  })
}

export function detailQuery(store: StoreClient | undefined, idOrSlug: string | null) {
  return queryOptions<ListingDetail | null>({
    queryKey: ['library-detail', idOrSlug],
    queryFn: async () => (store && idOrSlug ? store.getListing(idOrSlug) : null),
    enabled: Boolean(store && idOrSlug),
    staleTime: 60_000,
  })
}

/**
 * Puts a session in the cache. A session read already running (a refetch once the query went stale) is cancelled
 * first: it started under the old session and would otherwise land afterwards and put that one back.
 */
async function putSession(client: QueryClient, s: Session | null): Promise<void> {
  await client.cancelQueries({ queryKey: ['session'] })
  client.setQueryData(['session'], s)
}

/** Signs out and shows it at once, wherever the session is read. */
export async function signOutSession(store: StoreClient, client: QueryClient): Promise<void> {
  await store.signOut()
  await putSession(client, null)
}

/** The signed-in member, kept current when the session changes or the window regains focus (after signing in on the website). */
export function useSession(): { session: Session | null; ready: boolean } {
  const store = useStore()
  const client = useQueryClient()
  const q = useQuery({ queryKey: ['session'], queryFn: async () => (store ? store.session() : null), enabled: Boolean(store), staleTime: 30_000 })
  useEffect(() => {
    if (!store) return
    const off = store.onSessionChange((s) => void putSession(client, s))
    const refresh = () => {
      if (document.visibilityState === 'visible') void client.invalidateQueries({ queryKey: ['session'] })
    }
    document.addEventListener('visibilitychange', refresh)
    return () => {
      off()
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [store, client])
  return { session: q.data ?? null, ready: !store || q.isSuccess || q.isError }
}

/** One row on the Library's front page. */
export function rowQuery(store: StoreClient | undefined, row: RowId, signedIn: boolean) {
  return queryOptions<ListingCard[]>({
    queryKey: ['library', 'row', row, signedIn],
    queryFn: async () => {
      if (!store) return []
      switch (row) {
        case 'popular':
          return (await store.listListings({ sort: 'popular', limit: ROW_LIMIT })).items
        case 'recent':
          return (await store.listListings({ sort: 'new', limit: ROW_LIMIT })).items
        case 'trending':
          return store.trending({ days: 7, limit: ROW_LIMIT })
        case 'liked':
          return signedIn ? store.recommended({ limit: ROW_LIMIT }) : []
      }
    },
    enabled: Boolean(store) && (row !== 'liked' || signedIn),
    staleTime: 60_000,
    // A row that fails is hidden, so do not hold the page on retries.
    retry: 1,
  })
}

export function newCreatorsQuery(store: StoreClient | undefined) {
  return queryOptions<Creator[]>({
    queryKey: ['library', 'new-creators'],
    queryFn: async () => (store ? store.newCreators({ days: 30, limit: 12 }) : []),
    enabled: Boolean(store),
    staleTime: 60_000,
    retry: 1,
  })
}

/** How many designs the member saved, for the Saved filter. Zero when signed out. */
export function savedCountQuery(store: StoreClient | undefined, signedIn: boolean) {
  return queryOptions<number>({
    queryKey: ['library', 'saved-count', signedIn],
    queryFn: async () => (store && signedIn ? (await store.savedListings()).length : 0),
    enabled: Boolean(store) && signedIn,
    staleTime: 30_000,
    retry: 1,
  })
}

export function creatorPageQuery(store: StoreClient | undefined, handle: string | null) {
  return queryOptions<CreatorPage | null>({
    queryKey: ['library', 'creator', handle],
    queryFn: async () => (store && handle ? store.getCreatorByHandle(handle) : null),
    enabled: Boolean(store && handle),
    staleTime: 30_000,
  })
}

export function myCreatorQuery(store: StoreClient | undefined, signedIn: boolean) {
  return queryOptions<Creator | null>({
    queryKey: ['library', 'my-creator', signedIn],
    queryFn: async () => (store && signedIn ? store.getMyCreator() : null),
    enabled: Boolean(store) && signedIn,
    staleTime: 30_000,
  })
}

/** Every Library read, so a like, save, follow or page edit shows everywhere at once. */
export const LIBRARY_KEY = ['library'] as const

/**
 * The name the account shows as: the creator page's display name once there is one, otherwise the email's local part
 * as typed (the profile handle is derived from it and drops characters such as hyphens).
 */
export function accountLabel(session: Pick<Session, 'email' | 'displayName' | 'handle'>, creator: Pick<Creator, 'displayName'> | null | undefined, fallback = 'Account'): string {
  const creatorName = creator?.displayName?.trim()
  if (creatorName) return creatorName
  const local = session.email?.split('@')[0]?.trim()
  if (local) return local
  return session.displayName ?? session.handle ?? fallback
}

/** The signed-in account's label for headers and settings (accountLabel), following the creator page. */
export function useAccountLabel(fallback = 'Account'): string | null {
  const store = useStore()
  const { session } = useSession()
  const mine = useQuery(myCreatorQuery(store, Boolean(session)))
  return session ? accountLabel(session, mine.data, fallback) : null
}
