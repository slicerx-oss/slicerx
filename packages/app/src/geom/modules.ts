// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry engine comes in two builds (packages/geom/wasm/scripts/build.sh): a small core (booleans, cut, repair,
// import, arrange and the other mesh tools) that the worker loads first, and the full engine with the modeling tools
// and the heavier modules, loaded the first time a call needs it. Once loaded it takes every call, so face ids,
// which the core does not keep, never pass back through the core. An edition without the modeling tools ships the
// same build under both names.

export interface EngineModule {
  operations: Set<string>
  call(op: string, request: unknown): unknown
}

/** Whether a request carries a mesh with face ids (the core build would drop them). */
export function carriesFaces(request: unknown): boolean {
  if (request === null || typeof request !== 'object') return false
  if (Array.isArray(request)) return request.some(carriesFaces)
  for (const [k, v] of Object.entries(request)) {
    if (k === 'faces' && v !== null && typeof v === 'object' && 'ids' in v) return true
    // Flat mesh arrays hold numbers only; skip them rather than walk a million entries.
    if (k === 'positions' || k === 'indices') continue
    if (carriesFaces(v)) return true
  }
  return false
}

/** A build of the engine that did not load, and why. */
export interface LoadError {
  module: 'core' | 'full'
  message: string
}

/**
 * The two builds. A build that does not load leaves the other to answer (or every call to fail), and `onLoadError` hears
 * once which one and why, so a broken or missing build is never silent.
 */
export function engineModules(loadCore: () => Promise<EngineModule>, loadFull: () => Promise<EngineModule>, onLoadError?: (e: LoadError) => void) {
  let core: Promise<EngineModule | null> | null = null
  let full: Promise<EngineModule | null> | null = null
  let fullReady: EngineModule | null = null
  const failed = (module: LoadError['module']) => (e: unknown) => {
    onLoadError?.({ module, message: e instanceof Error ? e.message : String(e) })
    return null
  }
  const fullModule = () => (full ??= loadFull().then((m) => (fullReady = m), failed('full')))
  const coreModule = () => (core ??= loadCore().catch(failed('core')))
  return {
    /** Loads the full engine now (Design asks for it on the way in). True when it is there. */
    async full(): Promise<boolean> {
      return (await fullModule()) !== null
    },
    async run(op: string, request: unknown): Promise<unknown> {
      if (fullReady) return fullReady.call(op, request)
      const c = await coreModule()
      if (c && c.operations.has(op) && !carriesFaces(request)) return c.call(op, request)
      const f = await fullModule()
      if (f) return f.call(op, request)
      if (c) {
        if (c.operations.has(op)) return c.call(op, request)
        throw new Error(`${op} is not in this build`)
      }
      throw new Error('The geometry engine did not start')
    },
  }
}
