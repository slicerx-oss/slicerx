// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the plate view draws, for read-back: a client that shows a plate checks the view drew that plate's objects.
// Kept out of the view's own module so the app link reads it without loading the view.

let source: (() => string[]) | null = null

/** The view started: it answers what it draws. Returns the call that lets go when the view goes. */
export function drawnFrom(read: () => string[]): () => void {
  source = read
  return () => {
    if (source === read) source = null
  }
}

/** The ids of the objects the plate view draws now, or null when no view is up. */
export function drawnObjects(): string[] | null {
  return source ? source() : null
}
