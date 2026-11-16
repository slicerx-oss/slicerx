// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry engine comes in two builds (packages/geom/wasm/scripts/build.sh): a small core (booleans, cut, repair,
// import, arrange and the other mesh tools) that the worker loads first, and the full engine with the modeling tools
// and the heavier modules, loaded the first time a call needs it. Once loaded it takes every call, so face ids,
// which the core does not keep, never pass back through the core. An edition without the modeling tools ships the
// same build under both names. A third build is the full engine with exact solids (the SMLib kernel), loaded in place
// of the full engine when exact solids are on, and by the first exact call (brep.<op>) otherwise; from then on it takes
// every call, so the two full builds never answer side by side.

export interface EngineModule {
  operations: Set<string>
  call(op: string, request: unknown): unknown
}

/**
 * Whether a request carries a mesh with face ids (the core build would drop them). A typed array holds numbers only
 * (a mesh's arrays, a project file's bytes) and is never walked: listing the entries of a 36 MB file's bytes took
 * minutes in WebKit, and held a project's open back that long before its model could show.
 */
export function carriesFaces(request: unknown): boolean {
  if (request === null || typeof request !== 'object' || ArrayBuffer.isView(request)) return false
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
  module: 'core' | 'full' | 'exact'
  message: string
}

/**
 * The two builds. A build that does not load leaves the other to answer (or every call to fail), and `onLoadError` hears
 * once which one and why, so a broken or missing build is never silent.
 */
export function engineModules(
  loadCore: () => Promise<EngineModule>,
  loadFull: () => Promise<EngineModule>,
  onLoadError?: (e: LoadError) => void,
  loadExact?: () => Promise<EngineModule>,
) {
  let core: Promise<EngineModule | null> | null = null
  let full: Promise<EngineModule | null> | null = null
  let fullReady: EngineModule | null = null
  let exact: Promise<EngineModule | null> | null = null
  let exactReady: EngineModule | null = null
  const failed = (module: LoadError['module']) => (e: unknown) => {
    onLoadError?.({ module, message: e instanceof Error ? e.message : String(e) })
    return null
  }
  const fullModule = () => (full ??= loadFull().then((m) => (fullReady = m), failed('full')))
  const coreModule = () => (core ??= loadCore().catch(failed('core')))
  // a load that failed is tried again by the next exact call, as the separate kernel was
  const exactModule = () =>
    (exact ??= (loadExact ? loadExact() : Promise.reject(new Error('this build has no exact solids'))).then(
      (m) => (exactReady = m),
      (e: unknown) => {
        exact = null
        return failed('exact')(e)
      },
    ))
  const module = async (op: string, request: unknown): Promise<EngineModule> => {
    if (exactReady) return exactReady
    if (op.startsWith('brep.')) {
      const x = await exactModule()
      if (x) return x
      throw new Error('Exact solids did not load')
    }
    if (fullReady) return fullReady
    const c = await coreModule()
    if (c && c.operations.has(op) && !carriesFaces(request)) return c
    const f = await fullModule()
    if (f) return f
    if (c) {
      if (c.operations.has(op)) return c
      throw new Error(`${op} is not in this build`)
    }
    throw new Error('The geometry engine did not start')
  }
  return {
    /** Loads the core now (a worker started ahead of its first call). True when it is there. */
    async core(): Promise<boolean> {
      return (await coreModule()) !== null
    },
    /** Loads the full engine now (Design asks for it on the way in), the build with exact solids when `withExact`. True
     * when it is there. */
    async full(withExact = false): Promise<boolean> {
      if (exactReady) return true
      return (await (withExact ? exactModule() : fullModule())) !== null
    },
    /** The build with exact solids, when it has loaded. */
    exact: (): EngineModule | null => exactReady,
    /** The build that takes `op`, loaded first when it is not yet. */
    module,
    async run(op: string, request: unknown): Promise<unknown> {
      return (await module(op, request)).call(op, request)
    },
  }
}
