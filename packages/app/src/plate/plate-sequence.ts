// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plate's print sequence: its own, or the Print sequence setting when the plate follows it.
import type { PlateMeta } from '../state/store'

/**
 * The sequence a plate prints with: its own, or the Print sequence setting in `cfg` (the resolved print settings)
 * when the plate follows it, as Orca's "same as global" does.
 */
export function plateSequence(meta: Pick<PlateMeta, 'settings'> | undefined, cfg: Readonly<Record<string, unknown>>): 'by-layer' | 'by-object' {
  const global = Array.isArray(cfg['print_sequence']) ? cfg['print_sequence'][0] : cfg['print_sequence']
  return meta?.settings.sequence ?? (global === 'by object' ? 'by-object' : 'by-layer')
}
