// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's way to its usage page, for a limit refusal in the chat. A host without one shows the refusal alone.
import { createContext } from 'react'

/** The mimir cloud codes that mean a free allowance ran out: the day (this install or this network), the edition's
 * day, and the per-minute limit. */
export const USAGE_CODES: ReadonlySet<string> = new Set(['day_used', 'edition_day_used', 'slow_down'])

/** Opens the usage page; null where the host has none. */
export const UsageLinkContext = createContext<(() => void) | null>(null)
