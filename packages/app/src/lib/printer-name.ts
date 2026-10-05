// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which name a printer goes by in the app: the one the person gave it, else the one the printer
// announces for itself, else its model.
import type { PrinterInfo, PrinterStatus } from '@slicerx/contracts'

/** True when a stored name says no more than the model: empty, "H2D", or "Bambu Lab H2D". */
function onlyModel(info: Pick<PrinterInfo, 'name' | 'vendor' | 'model'>): boolean {
  const name = info.name.trim().toLowerCase()
  const model = info.model.trim().toLowerCase()
  return name === '' || name === model || name === `${info.vendor.trim().toLowerCase()} ${model}`
}

/**
 * The name to show for a printer. A printer added under its model alone shows the name it announces
 * for itself ("Tawain #1" rather than "H2D"); a name the person typed always wins.
 */
export function printerName(info: Pick<PrinterInfo, 'name' | 'vendor' | 'model'>, status?: Pick<PrinterStatus, 'ownName'> | null): string {
  const own = status?.ownName?.trim()
  return own && onlyModel(info) ? own : info.name
}
