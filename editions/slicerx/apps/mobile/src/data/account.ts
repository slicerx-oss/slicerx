// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Data export and account deletion for the signed-in account (AuthClient in @slicerx/contracts).
import type { AccountExport, StoreResult } from '@slicerx/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { File, Paths } from 'expo-file-system'
import { useMemo } from 'react'
import { Platform, Share } from 'react-native'
import type { AccountDataProps } from '../screens/account-screen'
import { usePocketHost } from './provider'
import { useSession } from './queries'

const KEYS = { policy: ['account', 'deletion-policy'] as const, pending: (id: string | null) => ['account', 'deletion', id] as const }

/** The value, or an error carrying the store's message, so the screen can show it. */
export function unwrap<T>(r: StoreResult<T>): T {
  if (!r.ok) throw new Error(r.message)
  return r.value
}

export const exportFileName = (data: AccountExport): string => `slicerx-account-${data.exported_at.slice(0, 10)}.json`

/** Writes the export to the cache and opens the share sheet. Android shares the text itself. */
export async function shareExport(data: AccountExport): Promise<void> {
  const json = JSON.stringify(data, null, 2)
  if (Platform.OS === 'android') {
    await Share.share({ title: exportFileName(data), message: json })
    return
  }
  const file = new File(Paths.cache, exportFileName(data))
  if (file.exists) file.delete()
  file.create()
  file.write(json)
  await Share.share({ url: file.uri })
}

export function useAccountData(): AccountDataProps {
  const host = usePocketHost()
  const client = useQueryClient()
  const { data: session } = useSession()
  const userId = session?.userId ?? null
  const policy = useQuery({ queryKey: KEYS.policy, queryFn: () => host.account.accountDeletionPolicy(), staleTime: Infinity, enabled: userId !== null })
  const pending = useQuery({ queryKey: KEYS.pending(userId), queryFn: () => host.account.pendingAccountDeletion(), enabled: userId !== null })
  const refetch = () => client.invalidateQueries({ queryKey: KEYS.pending(userId) })

  return useMemo(
    () => ({
      policy: policy.data ?? null,
      pending: pending.data ? { purgeAfter: pending.data.purgeAfter } : null,
      onExport: async () => shareExport(unwrap(await host.account.exportMyData())),
      onRequestDeletion: async () => {
        unwrap(await host.account.requestAccountDeletion())
        await refetch()
      },
      onCancelDeletion: async () => {
        unwrap(await host.account.cancelAccountDeletion())
        await refetch()
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [host, policy.data, pending.data, userId],
  )
}
