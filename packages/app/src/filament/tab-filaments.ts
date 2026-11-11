// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The project's filaments as mimir's tab tools read and change them (@slicerx/mcp tab-filaments): the rail's slots,
// set the way the filament dialog sets one, so the rail, the slice and the parts' colors on screen all follow.
import type { FilamentList } from '@slicerx/mcp/toolset'
import { resolved, setSlot } from './slots'

export const appFilaments: FilamentList = {
  list: () => resolved().map((r) => ({ slot: r.index, type: r.type, color: r.color })),
  // a slot past the last starts from the defaults for its number, as Add filament makes one, without opening the dialog
  add: (slot, patch) => setSlot(slot, patch),
  set: (slot, patch) => setSlot(slot, patch),
}
