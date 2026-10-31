// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Server state through TanStack Query. Printer events
// write into the same cache, so every view of a printer agrees.
import type { PrinterHost, PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { keepPreviousData, queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useHasFeature } from '../features'
import { printerAllowed, useEdition } from '../edition'
import { useHost } from '../host'
import { useApp } from '../state/store'
import { printerName } from './printer-name'
import { noteStatus } from './last-seen'

export type FleetRow = PrinterInfo & { status: PrinterStatus }

/** A fleet row under the name it is shown by: the printer's own name when it was added under its model alone (lib/printer-name.ts). */
function named(p: PrinterInfo, status: PrinterStatus): FleetRow {
  noteStatus(status)
  return { ...p, name: printerName(p, status), status }
}

/** A printer's status, or offline with the reason when asking fails: one printer's error (a wrong code, a driver
 * failure) shows on its own tile instead of failing the whole list. */
export async function statusOrOffline(printers: PrinterHost, id: string): Promise<PrinterStatus> {
  try {
    return await printers.status(id)
  } catch (e) {
    return { printerId: id, state: 'offline', nozzles: [], slots: [], cameraAvailable: false, message: e instanceof Error ? e.message : String(e), updatedAt: new Date().toISOString() }
  }
}

/** The fleet with each printer's status. With no printer host (connect feature off) it is empty. */
export function fleetQuery(printers: PrinterHost | undefined, epoch = 0) {
  return queryOptions({
    // A new epoch is a new printer host (the bridge connected or left), so the old rows are not reused.
    queryKey: ['fleet', epoch],
    queryFn: async (): Promise<FleetRow[]> => {
      if (!printers) return []
      const list = await printers.list()
      return Promise.all(list.map(async (p) => named(p, await statusOrOffline(printers, p.id))))
    },
    staleTime: 30_000,
  })
}

/**
 * The live link from one printer host to one fleet cache: one subscription per printer, however many readers keep it,
 * and the statuses that arrive together written in one go. A host reports every printer in the same moment (the demo
 * fleet's tick, a bridge's burst), and a write per printer per reader kept a slow computer's page busy for most of
 * every second.
 */
type Live = { subs: Map<string, { readers: number; off: () => void }>; pending: Map<string, PrinterStatus>; queued: boolean }

const lives = new WeakMap<QueryClient, WeakMap<PrinterHost, Map<number, Live>>>()

function liveFor(qc: QueryClient, printers: PrinterHost, epoch: number): Live {
  let byHost = lives.get(qc)
  if (!byHost) lives.set(qc, (byHost = new WeakMap()))
  let byEpoch = byHost.get(printers)
  if (!byEpoch) byHost.set(printers, (byEpoch = new Map()))
  let live = byEpoch.get(epoch)
  if (!live) byEpoch.set(epoch, (live = { subs: new Map(), pending: new Map(), queued: false }))
  return live
}

/** Writes the statuses that came in since the last write, once the task that brought them is done. */
function queueWrite(qc: QueryClient, live: Live, epoch: number, s: PrinterStatus): void {
  live.pending.set(s.printerId, s)
  if (live.queued) return
  live.queued = true
  queueMicrotask(() => {
    live.queued = false
    const next = live.pending
    live.pending = new Map()
    if (next.size === 0) return
    qc.setQueryData<FleetRow[]>(['fleet', epoch], (rows) =>
      rows?.map((r) => {
        const s = next.get(r.id)
        return s ? named(r, s) : r
      }),
    )
  })
}

/** Keeps the fleet cache live from printer events while mounted. Readers of the same printer share its subscription. */
export function useFleetLive(printers: PrinterHost | undefined, ids: readonly string[]): void {
  const qc = useQueryClient()
  const epoch = useApp((s) => s.linkEpoch)
  const key = ids.join(',')
  useEffect(() => {
    if (!printers) return
    const live = liveFor(qc, printers, epoch)
    const mine = key.split(',').filter(Boolean)
    for (const id of mine) {
      const sub = live.subs.get(id)
      if (sub) {
        sub.readers++
        continue
      }
      const off = printers.subscribe(id, (e) => {
        if (e.type === 'status') queueWrite(qc, live, epoch, e.status)
      })
      live.subs.set(id, { readers: 1, off })
    }
    return () => {
      for (const id of mine) {
        const sub = live.subs.get(id)
        if (!sub || --sub.readers > 0) continue
        live.subs.delete(id)
        sub.off()
      }
      if (live.subs.size === 0) lives.get(qc)?.get(printers)?.delete(epoch)
    }
  }, [printers, qc, key, epoch])
}

/** The printer host when the connect feature is on, otherwise undefined. */
export function usePrinters(): PrinterHost | undefined {
  const host = useHost()
  useApp((s) => s.linkEpoch)
  return useHasFeature('connect') ? host.printers : undefined
}

/** Fleet rows kept live from printer events. Empty when the connect feature is off. */
export function useFleet() {
  const printers = usePrinters()
  const edition = useEdition()
  const epoch = useApp((s) => s.linkEpoch)
  const q = useQuery({
    ...fleetQuery(printers, epoch),
    enabled: printers !== undefined,
    // A reconnected bridge is a new epoch: its rows replace the last ones when they arrive, so no card leaves and comes back.
    placeholderData: keepPreviousData,
    // Printer families the edition switched off never show.
    select: (rows: FleetRow[]) => rows.filter((r) => printerAllowed(edition, r.plugin)),
  })
  useFleetLive(printers, q.data?.map((r) => r.id) ?? [])
  return q
}

/**
 * One value read from the fleet, kept live like useFleet. The reader renders again only when `pick`'s answer changes
 * (compared by value), not on every status a printer sends: the top bar needs a count and a dot, not the temperatures.
 */
export function useFleetPick<T>(pick: (rows: FleetRow[]) => T): T | undefined {
  const printers = usePrinters()
  const edition = useEdition()
  const epoch = useApp((s) => s.linkEpoch)
  const q = useQuery({
    ...fleetQuery(printers, epoch),
    enabled: printers !== undefined,
    placeholderData: keepPreviousData,
    select: (rows: FleetRow[]) => {
      const shown = rows.filter((r) => printerAllowed(edition, r.plugin))
      return { ids: shown.map((r) => r.id), value: pick(shown) }
    },
  })
  useFleetLive(printers, q.data?.ids ?? [])
  return q.data?.value
}
