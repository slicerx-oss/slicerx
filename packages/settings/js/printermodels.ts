// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printer catalog model id to knowledge printer id. The catalog (packages/connect/catalog) names models
// like `bambu-x1-carbon`; settings knowledge and SetupRef.printer use `bambu_x1c`. The table is
// printer-models.json. src/printer_models.rs does the same.
import type { SetupRef } from '@slicerx/contracts/settings'
import table from '../printer-models.json'
import { K } from './knowledge'

const MODELS = (table as { models: Record<string, string> }).models

/** The knowledge printer id for a catalog model id, or undefined when settings knowledge has no entry for it. */
export function printerForModel(modelId: string): string | undefined {
  const id = MODELS[modelId]
  return id !== undefined && K.printers[id] !== undefined ? id : undefined
}

/** Every catalog model id that maps to a knowledge printer, in table order. */
export function modelsForPrinter(printerId: string): string[] {
  return Object.entries(MODELS).filter(([, p]) => p === printerId).map(([m]) => m)
}

/** Every catalog model id the table maps. */
export function mappedModels(): string[] {
  return Object.keys(MODELS)
}

/**
 * A setup for a catalog model and a filament: the knowledge printer, the nozzle (the given one, else the
 * printer's stock nozzle, else 0.4 mm) and the process the printer's baseline names. Undefined when the
 * model has no knowledge entry.
 */
export function setupForModel(modelId: string, filament: string, nozzleDiameter?: number): SetupRef | undefined {
  const printer = printerForModel(modelId)
  if (printer === undefined) return undefined
  const nozzle = nozzleDiameter ?? K.printers[printer]?.hotend.stockNozzle?.diameter ?? 0.4
  return { printer, nozzleDiameter: nozzle, filament }
}
