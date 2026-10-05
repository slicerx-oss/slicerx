// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { router, useLocalSearchParams } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import { useMemo } from 'react'
import { creatorLinks, toCreatorDetail, toEntry, useCreatorPage } from '../../src/data/catalog'
import { safeLinkUrl } from '../../src/screens/creator-screen'
import { CreatorScreen } from '../../src/screens/creator-screen'

export default function CreatorRoute() {
  const { handle } = useLocalSearchParams<{ handle: string }>()
  const q = useCreatorPage(handle)
  const creator = q.data?.creator
  const links = useMemo(() => creatorLinks(q.data?.links ?? []), [q.data])
  const models = useMemo(() => (q.data ? q.data.listings.map((l) => toEntry(l)) : []), [q.data])
  return (
    <CreatorScreen
      creator={creator ? toCreatorDetail(creator) : null}
      links={links}
      models={models}
      loading={q.isPending && q.fetchStatus !== 'idle'}
      failed={q.isError}
      onBack={() => router.back()}
      onRetry={() => void q.refetch()}
      // Checked again here: only https addresses leave the app.
      onOpenLink={(url) => {
        const safe = safeLinkUrl(url)
        if (safe) void WebBrowser.openBrowserAsync(safe)
      }}
      onOpenModel={(e) => router.push({ pathname: '/model/[slug]', params: { slug: e.slug } })}
    />
  )
}
