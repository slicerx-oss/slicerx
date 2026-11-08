// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The designs a design host keeps waiting for their first body, and where each waits (cad/design-host.ts). Shared with
// every reader: where a body stands (sketch-place.ts), and the timeline, which keeps a sketch drawn for a waiting design
// while the design has no body (plate/timeline.ts).
import type { Mat4 } from '@slicerx/cad-history'

const waiting = new Map<string, Mat4>()
/** How each live design host lets its waiting designs go (cad/design-host.ts). */
const owners = new Set<() => void>()

/** A design host's way to let its waiting designs go, called by forgetWaiting; returns how to take it back. */
export function ownWaiting(forget: () => void): () => void {
  owners.add(forget)
  return () => void owners.delete(forget)
}

/**
 * Every design host lets its waiting designs go: the project they were started in is gone (a new project, or one
 * opened in its place), so none of them can land on the plate now.
 */
export function forgetWaiting(): void {
  for (const forget of [...owners]) forget()
  waiting.clear()
}

/** A design host's waiting design `id` stands at `transform`, or (null) no longer waits. */
export function setWaiting(id: string, transform: Mat4 | null): void {
  if (transform) waiting.set(id, [...transform])
  else waiting.delete(id)
}

/** Where waiting design `id` stands, or undefined when it does not wait. */
export function waitingAt(id: string): Mat4 | undefined {
  return waiting.get(id)
}

/** Whether design `id` waits for its first body. */
export const waits = (id: string): boolean => waiting.has(id)
