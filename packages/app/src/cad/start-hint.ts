// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How a tool opened from the view's ring menu starts: Chamfer opens the fillet tool on its chamfer shape.
let filletKind: 'fillet' | 'chamfer' | null = null

export function startFillet(kind: 'fillet' | 'chamfer'): void {
  filletKind = kind
}

/** The shape the ring asked for, once. */
export function takeFilletKind(): 'fillet' | 'chamfer' | null {
  const k = filletKind
  filletKind = null
  return k
}
