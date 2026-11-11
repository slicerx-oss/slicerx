// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Types for geom.mjs.

export interface Geom {
  /** Operation names the module accepts. */
  operations(): string[]
  /** Runs one operation on a request object and returns the response object. */
  call(op: string, request: unknown): unknown
}

/** What a call that stopped the engine throws: why it stopped, and whether it ran out of memory (no panic kept). */
export interface GeomTrap extends Error {
  trapped: true
  outOfMemory: boolean
}

export function createGeom(module: WebAssembly.Module, opts?: { log?: (line: string) => void }): Promise<Geom>
