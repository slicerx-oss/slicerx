// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the panel keys ([, ] and Mod+J) toggle: whichever panel draws an edge tab on that side right now. A panel
// registers while it is on screen, so the keys follow the open mode and the look's sidebar side with no copy of
// that layout here.
import type { EdgeSide } from '@slicerx/ui'

const toggles = new Map<EdgeSide, () => void>()

/** Registers a panel's toggle for its side. Returns the unregister, which leaves a newer panel's toggle alone. */
export function registerEdge(side: EdgeSide, toggle: () => void): () => void {
  toggles.set(side, toggle)
  return () => {
    if (toggles.get(side) === toggle) toggles.delete(side)
  }
}

/** Toggles the panel on that side. False when no panel there has an edge tab. */
export function toggleEdge(side: EdgeSide): boolean {
  const t = toggles.get(side)
  t?.()
  return t !== undefined
}
