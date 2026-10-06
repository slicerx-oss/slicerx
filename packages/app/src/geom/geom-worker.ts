// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs sx-geom (packages/geom/wasm) off the main thread: one request in, one response out. The
// calling convention mirrors packages/geom/wasm/geom.mjs: write "op\0json" into the module's input
// buffer, call geom_call, read the JSON output or the error. history.replay runs in TypeScript here
// (cad/history/replay.ts) so meshes stay in the worker between steps; it yields between steps, so other
// requests still get answers meanwhile, and stops when its caller cancels.
import { replayHistory, type ReplayRequest } from '../cad/history/replay'
import { askFaces } from './client'

interface GeomExports {
  memory: WebAssembly.Memory
  geom_input(len: number): number
  geom_call(): number
  geom_out_ptr(): number
  geom_out_len(): number
  geom_error_ptr(): number
  geom_error_len(): number
}

let ready: Promise<GeomExports> | null = null

function load(): Promise<GeomExports> {
  return (ready ??= (async () => {
    const url = new URL('../../../geom/wasm/pkg/sx_geom_wasm.wasm', import.meta.url)
    const module = await WebAssembly.compileStreaming(fetch(url))
    const instance = await WebAssembly.instantiate(module, {})
    return instance.exports as unknown as GeomExports
  })())
}

// Every mesh comes back with its faces, which the parts keep and send again with the next call.
function call(x: GeomExports, op: string, request: unknown): unknown {
  const bytes = new TextEncoder().encode(`${op}\0${JSON.stringify(askFaces(request))}`)
  const at = x.geom_input(bytes.length)
  new Uint8Array(x.memory.buffer, at, bytes.length).set(bytes)
  const code = x.geom_call()
  const text = (ptr: number, len: number) => new TextDecoder().decode(new Uint8Array(x.memory.buffer, ptr, len))
  if (code === 0) return JSON.parse(text(x.geom_out_ptr(), x.geom_out_len()))
  let message = text(x.geom_error_ptr(), x.geom_error_len())
  try {
    message = (JSON.parse(message) as { error?: string }).error ?? message
  } catch {
    // A plain message stays as it is.
  }
  throw new Error(message)
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
    const x = await load()
    if (op === 'history.replay') {
      const result = await replayHistory(async (o, r) => call(x, o, r), request as ReplayRequest, {
        yieldStep: async () => {
          await new Promise((r) => setTimeout(r, 0))
          if (canceled.has(id)) throw Object.assign(new Error('Canceled'), { name: 'AbortError' })
        },
      })
      canceled.delete(id)
      self.postMessage({ id, result })
      return
    }
    self.postMessage({ id, result: call(x, op, request) })
  } catch (err) {
    canceled.delete(id)
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
