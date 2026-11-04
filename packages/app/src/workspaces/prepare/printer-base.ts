// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The starting values of the printer settings: the schema defaults, then the selected printer's profile.
import type { PrintConfig } from '@slicerx/contracts'
import { defaultConfig, printerConfig, profileIdFor } from '@slicerx/settings'

export { profileIdFor }

export function printerBase(printer: { vendor: string; model: string } | undefined): PrintConfig {
  const id = profileIdFor(printer)
  return { ...defaultConfig('printer'), ...(id ? printerConfig(id) : {}) } as PrintConfig
}
