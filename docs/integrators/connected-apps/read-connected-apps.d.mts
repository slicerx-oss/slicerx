// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Types for read-connected-apps.mjs, for TypeScript callers.
export interface Spool { id: number; name?: string; vendor?: string; material?: string; color?: string; remainingG?: number }
export interface Entity { entityId: string; state: string; name?: string }
export interface ConnectedApps {
  /** PLA spools from Spoolman; null when Spoolman isn't added; `{ error }` when it didn't answer. */
  spools: Spool[] | { error: string } | null
  /** Switches from Home Assistant, in the same shape. */
  switches: Entity[] | { error: string } | null
  /** The card raised to turn the first switch off: `needs_person` until a person answers it in SlicerX. */
  plugCard: { entityId: string; status: string | null; requestId: string | null; error: string | null } | null
}
export function readConnectedApps(call: (name: string, args: Record<string, unknown>) => Promise<unknown>, names: string[]): Promise<ConnectedApps>
