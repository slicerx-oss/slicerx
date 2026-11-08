// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The designs a design host keeps waiting for their first body, and where each waits (cad/design-host.ts). Shared with
// every reader: where a body stands (sketch-place.ts), and the timeline, which keeps a sketch drawn for a waiting design
// while the design has no body (plate/timeline.ts).
import type { Mat4 } from '@slicerx/cad-history'

const waiting = new Map<string, Mat4>()

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
