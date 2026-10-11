// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The product's name in text people read, for packages that have no edition of their own (settings, the link
// client): SlicerX, or a white-label edition's name, which the app sets once at start.

let name = 'SlicerX'
const listeners = new Set<(name: string) => void>()

/** The name an app shows for itself. */
export function productName(): string {
  return name
}

/** Sets the name, from the edition's brand. The app calls it when it learns its edition. */
export function setProductName(next: string): void {
  name = next
  for (const l of listeners) l(next)
}

/** Calls `fn` with each new name, for data written once that names the app (the printer catalog). */
export function onProductName(fn: (name: string) => void): void {
  listeners.add(fn)
}
