// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Catalog and session queries over the edition host's store client.
import type { EditionHost, ListingDetail, Session, StoreClient } from '@slicerx/contracts'
import { useHost } from '@slicerx/app'
import { infiniteQueryOptions, queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { applyFilter, listOptions, type LibraryFilter } from './filter'

export function useStore(): StoreClient | undefined {
  return (useHost() as EditionHost).store
}

export function listingsQuery(store: StoreClient | undefined, f: LibraryFilter) {
  return infiniteQueryOptions({
    queryKey: ['library', f.category, f.query.trim(), f.sort],
    queryFn: async ({ pageParam }) => {
      if (!store) return { items: [], next: undefined }
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

/** The signed-in member, kept current when the session changes or the window regains focus (after signing in on the website). */
export function useSession(): { session: Session | null; ready: boolean } {
  const store = useStore()
  const client = useQueryClient()
  const q = useQuery({ queryKey: ['session'], queryFn: async () => (store ? store.session() : null), enabled: Boolean(store), staleTime: 30_000 })
  useEffect(() => {
    if (!store) return
    const off = store.onSessionChange((s) => client.setQueryData(['session'], s))
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
