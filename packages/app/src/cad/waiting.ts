// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The designs a design host keeps waiting for their first body, and where each waits (cad/design-host.ts). Shared with
// every reader: where a body stands (sketch-place.ts), and the timeline, which keeps a sketch drawn for a waiting design
// while the design has no body (plate/timeline.ts). Also how a cleared plate's kept solids are freed (releaseKeptBodies),
// so clearing a project does not load the geometry client and the history code it brings.
import type { Mat4 } from '@slicerx/cad-history'

const waiting = new Map<string, Mat4>()
/** How each live design host lets its waiting designs go (cad/design-host.ts). */
const owners = new Set<() => void>()
/** Which project the plate holds: one more each time the project is cleared (forgetWaiting). */
let generation = 0

/** The project the plate holds now; a body built for an earlier one is not put on the plate. */
export const projectGeneration = (): number => generation

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
  generation++
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

/** How kept solids are freed: set by the geometry client when it loads (geom/client.ts, releaseKept). */
let release: () => unknown = () => undefined

export function setKeptBodiesRelease(f: () => unknown): void {
  release = f
}

/**
 * Frees the solids the replays of a cleared plate kept, where they were kept. Before the geometry client loads no
 * provider is set and no replay ran, so nothing is kept and nothing loads for it.
 */
export function releaseKeptBodies(): void {
  release()
}
