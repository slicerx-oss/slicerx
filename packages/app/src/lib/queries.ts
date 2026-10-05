// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Server state through TanStack Query. Printer events
// write into the same cache, so every view of a printer agrees.
import type { PrinterHost, PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
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

/** The fleet with each printer's status. With no printer host (connect feature off) it is empty. */
export function fleetQuery(printers: PrinterHost | undefined, epoch = 0) {
  return queryOptions({
    // A new epoch is a new printer host (the bridge connected or left), so the old rows are not reused.
    queryKey: ['fleet', epoch],
    queryFn: async (): Promise<FleetRow[]> => {
      if (!printers) return []
      const list = await printers.list()
      return Promise.all(list.map(async (p) => named(p, await printers.status(p.id))))
    },
    staleTime: 30_000,
  })
}

/** Keeps the fleet cache live from printer events while mounted. */
export function useFleetLive(printers: PrinterHost | undefined, ids: readonly string[]): void {
  const qc = useQueryClient()
  const epoch = useApp((s) => s.linkEpoch)
  const key = ids.join(',')
  useEffect(() => {
    if (!printers) return
    const offs = key
      .split(',')
      .filter(Boolean)
      .map((id) =>
        printers.subscribe(id, (e) => {
          if (e.type !== 'status') return
          qc.setQueryData<FleetRow[]>(['fleet', epoch], (rows) => rows?.map((r) => (r.id === e.status.printerId ? named(r, e.status) : r)))
        }),
      )
    return () => {
      for (const off of offs) off()
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
    // Printer families the edition switched off never show.
    select: (rows: FleetRow[]) => rows.filter((r) => printerAllowed(edition, r.plugin)),
  })
  useFleetLive(printers, q.data?.map((r) => r.id) ?? [])
  return q
}
