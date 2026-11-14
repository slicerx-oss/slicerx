// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs sx-geom (packages/geom/wasm) off the main thread: one request in, one response out. The
// calling convention mirrors packages/geom/wasm/geom.mjs: write "op\0json" into the module's input
// buffer, call geom_call, read the JSON output or the error. history.replay runs in TypeScript here
// (@slicerx/cad-history replay.ts) so meshes stay in the worker between steps; it yields between steps, so other
// requests still get answers meanwhile, and stops when its caller cancels. The engine is two builds (modules.ts):
// the core loads first, the full engine the first time a call needs it. Calls named brep.<op> go to the B-rep kernel
// (brep.ts), which loads the first time one comes.
import { releaseReplayCache, replayHistory, type EngineCall, type ReplayRequest } from '@slicerx/cad-history'
import { engineModules, type EngineModule } from './modules'
import { callEngine, EngineTrap, retriesAfterTrap, transferables, type GeomExports } from './engine-call'
import { loadBrep, type BrepModule } from './brep'
import { replayStepOf, workerLoop, type WorkerMessage } from './worker-loop'

async function load(url: URL): Promise<EngineModule> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url.pathname}: ${response.status}`)
  const instance = await WebAssembly.instantiate(await WebAssembly.compileStreaming(response), {})
  const x = instance.exports as unknown as GeomExports
  x.geom_ops()
  const operations = new Set(JSON.parse(new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.geom_out_ptr(), x.geom_out_len()))) as string[])
  return { operations, call: (op, request) => call(x, op, request) }
}

// A build that does not load is reported to the page (client.ts), ahead of the answer to the call that asked for it.
const startEngine = () => engineModules(
  () => load(new URL('../../../geom/wasm/pkg/sx_geom_core.wasm', import.meta.url)),
  () => load(new URL('../../../geom/wasm/pkg/sx_geom_wasm.wasm', import.meta.url)),
  (loadError) => self.postMessage({ loadError }),
)
let engine = startEngine()

/** The engine modules' memory, which only grows; each answer says how big it is, so the page can end a worker that holds a lot. */
const memories = new Set<WebAssembly.Memory>()
let loadedBrep: BrepModule | null = null
const memoryBytes = (): number => [...memories].reduce((n, m) => n + m.buffer.byteLength, loadedBrep?.memoryBytes() ?? 0)

function call(x: GeomExports, op: string, request: unknown): unknown {
  memories.add(x.memory)
  try {
    return callEngine(x, op, request)
  } catch (err) {
    // a trapped module traps on every later call, so the next call loads the engine again
    if (err instanceof EngineTrap) {
      memories.delete(x.memory)
      engine = startEngine()
    }
    throw err
  }
}

/** `first`, and when it ran out of memory (retriesAfterTrap) the same call once more on the engine loaded again, logged. */
async function retried(op: string, request: unknown, first: () => unknown): Promise<unknown> {
  try {
    return await first()
  } catch (err) {
    if (!retriesAfterTrap(err, op)) throw err
    console.warn(`sx-geom ${op}: ${err.message}; trying it once more on a fresh engine`)
    return (await engine.module(op, request)).call(op, request)
  }
}

/** A file sent as its bytes (`data.bytes`) goes to the engine as base64, encoded here rather than on the page. */
function bytesAsBase64(request: unknown): unknown {
  if (request === null || typeof request !== 'object') return request
  const data = (request as { data?: { bytes?: unknown } }).data
  const bytes = data?.bytes
  if (!(bytes instanceof Uint8Array)) return request
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { ...request, data: { base64: btoa(text) } }
}

let brep: Promise<BrepModule> | null = null

/** The B-rep kernel, loaded on the first brep.<op> call; a load that failed is tried again on the next call. */
function brepKernel(): Promise<BrepModule> {
  return (brep ??= loadBrep().then((module) => {
    loadedBrep = module
    return module
  }).catch((err: unknown) => {
    brep = null
    const message = err instanceof Error ? err.message : String(err)
    self.postMessage({ loadError: { module: 'brep', message } })
    throw new Error(`The B-rep kernel did not load: ${message}`)
  }))
}

/** How a replay here reaches the engine: brep.<op> calls go to the kernel, the rest to the mesh engine. */
const replayCall: EngineCall = async (o, r) => (o.startsWith('brep.') ? (await brepKernel()).call(o.slice('brep.'.length), r) : retried(o, r, () => engine.run(o, r)))

const handle = workerLoop((message, transfer) => self.postMessage(message, { transfer: transfer ?? [] }), {
  async prepare(op, request) {
    // a cleared plate's kept bodies, freed in the kernel they live in; with none kept the kernel is not loaded for it
    if (op === 'history.release') return () => releaseReplayCache(replayCall)
    if (op.startsWith('brep.')) {
      const kernel = await brepKernel()
      return () => kernel.call(op.slice('brep.'.length), request)
    }
    // started ahead of its first call (client.ts, startSpareGeomWorker): the core engine loads now
    if (op === 'engine.core') {
      const loaded = await engine.core()
      return () => loaded
    }
    if (op === 'engine.full') {
      const loaded = await engine.full()
      return () => loaded
    }
    // A project goes to the engine as its bytes (engine-call.ts, rawData), other files as base64.
    const input = op === 'format.read3mf' ? request : bytesAsBase64(request)
    const build = await engine.module(op, input)
    return () => retried(op, input, () => build.call(op, input))
  },
  // a replay with exact solids calls the kernel's ops too; the kernel lives in this worker, so its bodies last from
  // call to call
  replay: (request, yieldStep) => replayHistory(replayCall, request as ReplayRequest, { keepsBodies: true, yieldStep: (s) => yieldStep(replayStepOf(s)) }),
  memoryBytes,
  transfer: (op, result) => (op.startsWith('brep.') || op.startsWith('engine.') ? [] : transferables(result)),
})

self.onmessage = (e: MessageEvent<WorkerMessage>) => handle(e.data)
