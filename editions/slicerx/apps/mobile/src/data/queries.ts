// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Server state for Pocket. Screens get view models from these hooks and never touch the
// host. Printer status arrives by subscription and is written into the query cache, so
// every screen reads the same live values.
import type { Fleet, PrinterInfo, PrinterStatus, Session } from '@slicerx/contracts'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import type { PrinterView } from '../components/printers/printer-bits'
import { usePocketHost } from './provider'

export const keys = {
  printers: ['printers'] as const,
  fleets: ['fleets'] as const,
  status: (id: string) => ['status', id] as const,
  snapshot: (id: string) => ['snapshot', id] as const,
  session: ['session'] as const,
}

export function usePrinters() {
  const host = usePocketHost()
  return useQuery<PrinterInfo[]>({ queryKey: keys.printers, queryFn: () => host.printers.list(), staleTime: Infinity })
}

export function useFleets() {
  const host = usePocketHost()
  return useQuery<Fleet[]>({ queryKey: keys.fleets, queryFn: () => host.printers.fleets(), staleTime: Infinity })
}

/** Every printer with its live status, in list order. */
export function usePrinterViews(): { views: PrinterView[]; loading: boolean; refetch: () => Promise<unknown> } {
  const host = usePocketHost()
  const list = usePrinters()
  const statuses = useQueries({
    queries: (list.data ?? []).map((p) => ({ queryKey: keys.status(p.id), queryFn: () => host.printers.status(p.id), staleTime: Infinity })),
  })
  const views = useMemo(() => (list.data ?? []).map((info, i) => ({ info, status: (statuses[i]?.data as PrinterStatus | undefined) ?? null })), [list.data, statuses])
  return { views, loading: list.isPending, refetch: list.refetch }
}

export function usePrinterView(printerId: string): PrinterView | null {
  const { views } = usePrinterViews()
  return views.find((v) => v.info.id === printerId) ?? null
}

/** A camera snapshot as a data URI. The query refetches only on request. */
export function useSnapshot(printerId: string, enabled: boolean) {
  const host = usePocketHost()
  return useQuery({
    queryKey: keys.snapshot(printerId),
    enabled,
    staleTime: Infinity,
    queryFn: async () => {
      const uri = await host.printers.snapshotUri(printerId)
      return uri ? { uri, takenAt: new Date().toISOString() } : null
    },
  })
}

export function useSession() {
  const host = usePocketHost()
  const client = useQueryClient()
  useEffect(() => host.account.onSessionChange((s) => client.setQueryData(keys.session, s)), [host, client])
  return useQuery<Session | null>({ queryKey: keys.session, queryFn: () => host.account.session(), staleTime: Infinity })
}

/** Keeps every printer's status in the cache from its event stream. Mounted once by the provider. */
export function useStatusSync(): void {
  const host = usePocketHost()
  const client = useQueryClient()
  const { data: printers } = usePrinters()
  useEffect(() => {
    if (!printers) return undefined
    const offs = printers.map((p) =>
      host.printers.subscribe(p.id, (e) => {
        if (e.type === 'status') client.setQueryData(keys.status(p.id), e.status)
      }),
    )
    return () => {
      for (const off of offs) off()
    }
  }, [host, printers, client])
}
