// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs sx-geom (packages/geom/wasm) off the main thread: one request in, one response out. The
// calling convention mirrors packages/geom/wasm/geom.mjs: write "op\0json" into the module's input
// buffer, call geom_call, read the JSON output or the error. history.replay runs in TypeScript here
// (cad/history/replay.ts) so meshes stay in the worker between steps; it yields between steps, so other
// requests still get answers meanwhile, and stops when its caller cancels. The engine is two builds (modules.ts):
// the core loads first, the full engine the first time a call needs it.
import { replayHistory, type ReplayRequest } from '../cad/history/replay'
import { engineModules, type EngineModule } from './modules'
import { callEngine, transferables, type GeomExports } from './engine-call'

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
const engine = engineModules(
  () => load(new URL('../../../geom/wasm/pkg/sx_geom_core.wasm', import.meta.url)),
  () => load(new URL('../../../geom/wasm/pkg/sx_geom_wasm.wasm', import.meta.url)),
  (loadError) => self.postMessage({ loadError }),
)

/** The engine modules' memory, which only grows; each answer says how big it is, so the page can end a worker that holds a lot. */
const memories = new Set<WebAssembly.Memory>()
const memoryBytes = (): number => [...memories].reduce((n, m) => n + m.buffer.byteLength, 0)

function call(x: GeomExports, op: string, request: unknown): unknown {
  memories.add(x.memory)
  return callEngine(x, op, request)
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

const canceled = new Set<number>()

self.onmessage = async (e: MessageEvent<{ id: number; op: string; request: unknown } | { cancel: number }>) => {
  if ('cancel' in e.data) {
    canceled.add(e.data.cancel)
    // Cancels of quick calls arrive after their answer; keep only the latest few.
    if (canceled.size > 256) canceled.delete(canceled.values().next().value as number)
    return
  }
  const { id, op, request } = e.data
  try {
    if (op === 'history.replay') {
      const result = await replayHistory(async (o, r) => engine.run(o, r), request as ReplayRequest, {
        yieldStep: async () => {
          await new Promise((r) => setTimeout(r, 0))
          if (canceled.has(id)) throw Object.assign(new Error('Canceled'), { name: 'AbortError' })
        },
      })
      canceled.delete(id)
      self.postMessage({ id, result, memoryBytes: memoryBytes() })
      return
    }
    if (op === 'engine.full') {
      self.postMessage({ id, result: await engine.full(), memoryBytes: memoryBytes() })
      return
    }
    const result = await engine.run(op, bytesAsBase64(request))
    self.postMessage({ id, result, memoryBytes: memoryBytes() }, { transfer: transferables(result) })
  } catch (err) {
    canceled.delete(id)
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err), memoryBytes: memoryBytes() })
  }
}
