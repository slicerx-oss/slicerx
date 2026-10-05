// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { resolveSlots } from './slots'
import { useApp } from '../state/store'

/** How many filaments the plate uses (at least 1). Multi-color settings show only from 2 (packages/settings/docs/tiers.md, showWhen multicolor). */
export function useFilamentCount(): number {
  return useApp((s) => Math.max(1, resolveSlots(s).filter((r) => r.used).length))
}
