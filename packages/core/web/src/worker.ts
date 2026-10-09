// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One pool worker: its own sx-wasm instance and copies of the loaded meshes.
import type { FromWorker, MeshInfo, ShardInfo, ToWorker } from './protocol'
import { cubePart, encodeParts } from './parts'
import { workerRequest } from './request-meshes'
import { OUT_GCODE, OUT_SXPV, SxWasm } from './wasm'

declare const self: DedicatedWorkerGlobalScope

let wasm: SxWasm | null = null
const meshIds = new Map<string, number>()

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer)
}

function mapRequest(request: string): Uint8Array {
  return new TextEncoder().encode(workerRequest(request, (id) => meshIds.get(id)))
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data
  if (msg.type === 'init') {
    try {
      wasm = await SxWasm.create(msg.module)
    } catch (e) {
      post({ type: 'error', call: 0, message: e instanceof Error ? e.message : String(e) })
      return
    }
    if (msg.warmUp) {
      // One small slice through every stage, so the engine tiers up the hot
      // functions before the first real request. A failure here only costs speed.
      try {
        const id = wasm.loadMesh('warm-up', encodeParts([cubePart()]))
        wasm.sliceShard(new TextEncoder().encode(JSON.stringify({ plate: { objects: [{ mesh: id }] }, config: {} })), 0, 1)
        wasm.releaseMesh(id)
      } catch {
        // Ignored on purpose: the pool works without the warm-up.
      }
    }
    post({ type: 'ready' })
    return
  }
  if (!wasm) return
  if (msg.type === 'release') {
    const id = meshIds.get(msg.meshId)
    if (id !== undefined) wasm.releaseMesh(id)
    meshIds.delete(msg.meshId)
    return
  }
  try {
    if (msg.type === 'parts') {
      const id = meshIds.get(msg.meshId)
      if (id === undefined) throw new Error(`Mesh ${msg.meshId} is not loaded in this worker`)
      const data = wasm.meshParts(id).buffer as ArrayBuffer
      post({ type: 'parts', call: msg.call, data }, [data])
    } else if (msg.type === 'metadata') {
      post({ type: 'metadata', call: msg.call, info: wasm.projectMetadata(msg.fileName, new Uint8Array(msg.data)) })
    } else if (msg.type === 'finalize') {
      const thumb = msg.thumbnail ? { width: msg.thumbnail.width, height: msg.thumbnail.height, rgba: new Uint8Array(msg.thumbnail.rgba) } : undefined
      const text = (v: string | undefined) => (v ? new TextEncoder().encode(v) : undefined)
      const done = wasm.finalizeGcode(new Uint8Array(msg.data), thumb, text(msg.request), text(msg.collide))
      const data = done.data.buffer as ArrayBuffer
      post({ type: 'finalized', call: msg.call, data, format: done.format, ...(done.timeS !== undefined ? { timeS: done.timeS } : {}), ...(done.prepareS !== undefined ? { prepareS: done.prepareS } : {}), ...(done.layerTimeS ? { layerTimeS: done.layerTimeS } : {}), ...(done.fileName ? { fileName: done.fileName } : {}), ...(done.layerLines ? { layerLines: done.layerLines } : {}), ...(done.progressLines ? { progressLines: done.progressLines } : {}), ...(done.collisions ? { collisions: done.collisions, collisionFixes: done.collisionFixes ?? [] } : {}) }, [data])
    } else if (msg.type === 'load') {
      const id = wasm.loadMesh(msg.fileName, new Uint8Array(msg.data))
      meshIds.set(msg.meshId, id)
      post({ type: 'loaded', call: msg.call, info: wasm.outJson() as MeshInfo })
    } else {
      const t0 = performance.now()
      wasm.sliceShard(mapRequest(msg.request), msg.shard, msg.shards)
      const gcode = wasm.out(OUT_GCODE).buffer as ArrayBuffer
      const sxpv = wasm.out(OUT_SXPV).buffer as ArrayBuffer
      const info = wasm.outJson() as ShardInfo
      post({ type: 'sliced', call: msg.call, gcode, sxpv, info, ms: performance.now() - t0 }, [gcode, sxpv])
    }
  } catch (e) {
    post({ type: 'error', call: msg.call, message: e instanceof Error ? e.message : String(e) })
  }
}
