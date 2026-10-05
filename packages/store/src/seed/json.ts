// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { SeedData, SeedTable } from '../rows'

/** File name to contents for packages/store/seed/, one file per table. */
export function renderSeedJson(seed: SeedData): Record<string, string> {
  const out: Record<string, string> = {}
  for (const table of Object.keys(seed) as SeedTable[]) {
    out[`${table.replaceAll('_', '-')}.json`] = `${JSON.stringify(seed[table], null, 1)}\n`
  }
  return out
}
