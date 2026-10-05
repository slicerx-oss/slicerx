// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { router, useLocalSearchParams } from 'expo-router'
import { useMemo } from 'react'
import { toModelDetail, useListing } from '../../src/data/catalog'
import { ModelScreen } from '../../src/screens/model-screen'

export default function ModelRoute() {
  const { slug } = useLocalSearchParams<{ slug: string }>()
  const q = useListing(slug)
  const model = useMemo(() => (q.data ? toModelDetail(q.data.listing, q.data.creator, q.data.versions) : null), [q.data])
  return (
    <ModelScreen
      model={model}
      loading={q.isPending && q.fetchStatus !== 'idle'}
      failed={q.isError}
      onBack={() => router.back()}
      onRetry={() => void q.refetch()}
      onOpenCreator={(s) => router.push({ pathname: '/creator/[handle]', params: { handle: s } })}
      onSend={() => router.push({ pathname: '/send', params: { listing: slug } })}
    />
  )
}
