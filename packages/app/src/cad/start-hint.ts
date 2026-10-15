// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How a tool opened from the view's ring menu starts: Chamfer opens the fillet tool on its chamfer shape.
import { appStore, get } from '../state/store'

let filletKind: 'fillet' | 'chamfer' | null = null
let off: (() => void) | null = null

function drop(): void {
  filletKind = null
  off?.()
  off = null
}

export function startFillet(kind: 'fillet' | 'chamfer'): void {
  off?.()
  filletKind = kind
  // The hint stays until the tool has opened and then closed (or another tool took its place), so a panel that
  // mounts again (the pane opening with the tool, development double mounts) still starts on the same shape.
  let seen = get().objectTool === 'fillet'
  off = appStore.subscribe((s) => {
    if (s.objectTool === 'fillet') seen = true
    else if (seen) drop()
  })
}

/** The shape the ring asked for, while the tool it opened is still open. */
export function filletKindHint(): 'fillet' | 'chamfer' | null {
  return filletKind
}
