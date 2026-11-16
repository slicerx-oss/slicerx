// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useCallback, useMemo } from 'react'
import type { FleetRow } from './queries'
import { useFleet, useFleetPick } from './queries'
import { useApp } from '../state/store'
import { EXPORT_PLUGIN, isExportOnly } from './hand-printers'
import type { ProjectPrinter } from '../state/store'

/** The printer the sidebar shows (shownPrinter): the selected one, else the one shown last, else the first idle one, else the first. An open project's own printer is listed first. */
export function usePrinter(): { rows: FleetRow[]; printer: FleetRow | undefined } {
  const fleet = useFleet()
  const printerId = useApp((s) => s.printerId)
  const kept = useApp((s) => s.printerModel?.id ?? null)
  const project = useApp((s) => s.projectPrinter)
  const rows = useMemo(() => (project ? [projectRow(project), ...(fleet.data ?? [])] : (fleet.data ?? [])), [project, fleet.data])
  return { rows, printer: shownPrinter(rows, printerId, kept) }
}

/**
 * One value read from the printer the sidebar shows, as usePrinter picks it. The reader renders again only when `pick`'s
 * answer changes (compared by value), so one that needs the printer's model or its last print skips every temperature.
 * Pass a stable `pick` (defined outside the component), or it is worked out again on every render.
 */
export function useShownPrinterPick<T>(pick: (printer: FleetRow | undefined) => T): T {
  const printerId = useApp((s) => s.printerId)
  const kept = useApp((s) => s.printerModel?.id ?? null)
  const project = useApp((s) => s.projectPrinter)
  // Wrapped, so an answer of undefined is told apart from a fleet that has not answered.
  const fromRows = useCallback((rows: FleetRow[]) => ({ value: pick(shownPrinter(project ? [projectRow(project), ...rows] : rows, printerId, kept)) }), [pick, project, printerId, kept])
  // Until the fleet answers, and with no printer host, there are no rows, as in usePrinter: an open project's printer still shows.
  return (useFleetPick(fromRows) ?? fromRows([])).value
}

/** An open project's printer as a printer row: it takes no jobs, so Print exports its G-code. */
export function projectRow(p: ProjectPrinter): FleetRow {
  return { id: p.id, name: `${p.model} ${p.nozzle} from ${p.source}`, vendor: p.vendor, model: p.model, plugin: EXPORT_PLUGIN, nozzleCount: 1, status: { printerId: p.id, state: 'idle', nozzles: [], slots: [], cameraAvailable: false, updatedAt: new Date(0).toISOString() } }
}

/**
 * The chosen printer, else the one shown last (`kept`, the printer the slice follows now) while it is still connected,
 * else the first idle one, else the first. With nothing chosen, a print started on the shown printer makes it busy; it
 * stays the one shown, so the slice just sent keeps its printer and never reads as made for another one.
 */
export function shownPrinter(rows: FleetRow[], printerId: string | null, kept?: string | null): FleetRow | undefined {
  const still = kept ? rows.find((r) => r.id === kept && r.status.state !== 'offline') : undefined
  return rows.find((r) => r.id === printerId) ?? still ?? rows.find((r) => r.status.state === 'idle') ?? rows[0]
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
