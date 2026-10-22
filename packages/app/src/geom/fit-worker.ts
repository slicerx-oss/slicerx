// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The fit check's own worker (client.ts, fitCall): the core engine build and the meshes it was sent, kept from check
// to check. A check runs synchronously in the engine, so a check no longer wanted ends with this worker, never with the
// shared one and its design state. The page keeps the compiled module and hands it to the next worker.
import { callEngine, type GeomExports } from './engine-call'

type Mesh = { positions: Float32Array; indices: Uint32Array | Uint16Array }

let engine: Promise<GeomExports> | null = null
/** Meshes sent once and named by key since, until the page says the plate dropped them. */
const meshes = new Map<number, Mesh>()

async function load(module: WebAssembly.Module | null): Promise<GeomExports> {
  if (!module) {
    const url = new URL('../../../geom/wasm/pkg/sx_geom_core.wasm', import.meta.url)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${url.pathname}: ${response.status}`)
    module = await WebAssembly.compileStreaming(response)
    // the page keeps it for the next worker; one it cannot take is compiled again then
    try {
      self.postMessage({ module })
    } catch {
      // not cloneable here
    }
  }
  return (await WebAssembly.instantiate(module, {})).exports as unknown as GeomExports
}

/** The request with each keyed mesh as its arrays, keeping the ones that came with it. */
function unkeyed(v: unknown): unknown {
  if (Array.isArray(v)) return v.length && typeof v[0] === 'object' ? v.map(unkeyed) : v
  if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v)) return v
  const { meshKey, ...o } = v as Record<string, unknown>
  if (typeof meshKey === 'number') {
    if (o['positions']) meshes.set(meshKey, { positions: o['positions'] as Float32Array, indices: o['indices'] as Mesh['indices'] })
    const m = meshes.get(meshKey)
    if (!m) throw new Error(`fit check: mesh ${meshKey} was never sent`)
    return { ...o, ...m }
  }
  const out: Record<string, unknown> = {}
  for (const [k, e] of Object.entries(o)) out[k] = unkeyed(e)
  return out
}

self.onmessage = async (e: MessageEvent<{ start: WebAssembly.Module | null } | { keep: number[] } | { id: number; request: unknown }>) => {
  const m = e.data
  if ('start' in m) {
    engine = load(m.start)
    return
  }
  if ('keep' in m) {
    const keep = new Set(m.keep)
    for (const k of meshes.keys()) if (!keep.has(k)) meshes.delete(k)
    return
  }
  let x: GeomExports | null = null
  try {
    x = await engine!
    const result = callEngine(x, 'fit.check', unkeyed(m.request))
    self.postMessage({ id: m.id, result, memoryBytes: x.memory.buffer.byteLength })
  } catch (err) {
    self.postMessage({ id: m.id, error: err instanceof Error ? err.message : String(err), memoryBytes: x?.memory.buffer.byteLength ?? 0 })
  }
}
