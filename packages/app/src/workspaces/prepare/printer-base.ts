// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The starting values of the printer settings: the schema defaults, then the selected printer's profile.
import type { PrintConfig } from '@slicerx/contracts'
import { defaultConfig, listPrinterProfiles, printerConfig } from '@slicerx/settings'

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** The profile of a printer named by vendor and model, matched on the words we have. */
export function profileIdFor(printer: { vendor: string; model: string } | undefined): string | undefined {
  if (!printer) return undefined
  const model = norm(printer.model)
  const vendor = norm(printer.vendor)
  return listPrinterProfiles().find((p) => norm(p.model) === model && (norm(p.vendor).includes(vendor) || vendor.includes(norm(p.vendor)) || norm(p.brand) === vendor))?.id
}

export function printerBase(printer: { vendor: string; model: string } | undefined): PrintConfig {
  const id = profileIdFor(printer)
  return { ...defaultConfig('printer'), ...(id ? printerConfig(id) : {}) } as PrintConfig
}
