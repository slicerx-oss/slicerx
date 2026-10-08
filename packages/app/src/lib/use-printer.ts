// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useMemo } from 'react'
import type { FleetRow } from './queries'
import { useFleet } from './queries'
import { useApp } from '../state/store'
import { EXPORT_PLUGIN, isExportOnly } from './hand-printers'
import type { ProjectPrinter } from '../state/store'

/** The printer the sidebar shows: the selected one, else the first idle one, else the first. An open project's own printer is listed first. */
export function usePrinter(): { rows: FleetRow[]; printer: FleetRow | undefined } {
  const fleet = useFleet()
  const printerId = useApp((s) => s.printerId)
  const project = useApp((s) => s.projectPrinter)
  const rows = useMemo(() => (project ? [projectRow(project), ...(fleet.data ?? [])] : (fleet.data ?? [])), [project, fleet.data])
  return { rows, printer: shownPrinter(rows, printerId) }
}

/** An open project's printer as a printer row: it takes no jobs, so Print exports its G-code. */
export function projectRow(p: ProjectPrinter): FleetRow {
  return { id: p.id, name: `${p.model} ${p.nozzle} from ${p.source}`, vendor: p.vendor, model: p.model, plugin: EXPORT_PLUGIN, nozzleCount: 1, status: { printerId: p.id, state: 'idle', nozzles: [], slots: [], cameraAvailable: false, updatedAt: new Date(0).toISOString() } }
}

export function shownPrinter(rows: FleetRow[], printerId: string | null): FleetRow | undefined {
  return rows.find((r) => r.id === printerId) ?? rows.find((r) => r.status.state === 'idle') ?? rows[0]
}

/**
 * The printer Print sends to. The plate is sliced for the chosen printer, so that printer when it can take a job (idle, or
 * finished, where the Print sheet asks about the plate). Only an idle printer of the same make and model stands in for it:
 * any other printer would get G-code made for a different machine. Undefined when none can.
 */
export function printTarget(printer: FleetRow | undefined, rows: FleetRow[]): FleetRow | undefined {
  // A printer with no connection takes no jobs: Print exports for it instead.
  if (!printer || isExportOnly(printer)) return undefined
  if (printer.status.state === 'idle' || printer.status.state === 'finished') return printer
  return rows.find((p) => !isExportOnly(p) && p.status.state === 'idle' && p.vendor === printer.vendor && p.model === printer.model)
}

/** The plate name a Print button shows under its label: the active plate's, only when the project has several. */
export function printPlateLabel(plates: readonly { id: string; name: string }[], activePlate: string): string | null {
  return plates.length > 1 ? (plates.find((p) => p.id === activePlate)?.name ?? null) : null
}
