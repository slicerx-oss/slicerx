// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { appName } from '../edition'
import type { PendingApproval } from '../state/store'

/** What an approval lets the app do, by the requests' permission class. */
const PERMISSION_TEXT: Record<string, string> = {
  queue: 'send a file to the printer',
  start: 'heat and move the printer',
  profile: 'change a saved profile',
  slice: 'slice in this project',
  read: 'read data',
}

/**
 * The approval dialog's footer note: what pressing Approve lets the app do, once. A card whose work says it more
 * exactly than its permission class (a slot card changes one filament slot and moves nothing) names it in `allows`.
 */
export function allowsNote(approval: Pick<PendingApproval, 'requests' | 'allows'>): string {
  const what = approval.allows ?? [...new Set(approval.requests.map((r) => r.permission))].map((k) => PERMISSION_TEXT[k] ?? k).join(' and ')
  return `Allows ${appName()} to ${what}, once. The approval expires in 5 min.`
}
