// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { router } from 'expo-router'
import { useMemo, useState } from 'react'
import { useCatalog, toEntry } from '../../src/data/catalog'
import { usePocketHost } from '../../src/data/provider'
import { LibraryScreen } from '../../src/screens/library-screen'

export default function LibraryRoute() {
  const host = usePocketHost()
  const catalog = useCatalog()
  const [refreshing, setRefreshing] = useState(false)
  const entries = useMemo(() => (catalog.data ?? []).map((i) => toEntry(i.listing, i.creator)), [catalog.data])
  return (
    <LibraryScreen
      entries={entries}
      unavailable={host.store === null}
      loading={catalog.isPending && catalog.fetchStatus !== 'idle'}
      failed={catalog.isError}
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true)
        void catalog.refetch().finally(() => setRefreshing(false))
      }}
      onOpen={(e) => router.push({ pathname: '/model/[slug]', params: { slug: e.slug } })}
      onImport={() => router.push({ pathname: '/send', params: { pick: '1' } })}
    />
  )
}
