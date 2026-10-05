// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Browser slice timing page for packages/core/bench/web-slice.mjs. Query:
// model and config (URLs), workers (optional). Results land in
// window.sxBench and in the page text.
import type { SliceRequest } from '@slicerx/contracts'
import { createWasmSlicer, createWebSlicer } from '../src/index'

interface ModelJson {
  qMin?: [number, number, number]
  qMax?: [number, number, number]
}

/** Translation that puts the model's footprint center on the bed center. */
function placement(fileName: string, bytes: ArrayBuffer): [number, number, number] {
  if (fileName.endsWith('.json')) {
    const m = JSON.parse(new TextDecoder().decode(bytes)) as ModelJson
    if (m.qMin && m.qMax) return [128 - (m.qMin[0] + m.qMax[0]) / 2, 128 - (m.qMin[1] + m.qMax[1]) / 2, -m.qMin[2]]
  }
  // Reference models are generated centered on x = y = 0 and resting on z = 0.
  return [128, 128, 0]
}

interface BenchResult {
  poolMs: number
  loadMs: number
  firstSliceMs: number
  warmSliceMs: number
  previewMs: number
  layers: number
  gcodeBytes: number
  gcodeSha256: string
  /** Stitched SXPV and G-code from 1 shard equal those from the pool's shard count. */
  shardsEqual: boolean
  workers: number
  error?: string
}

declare global {
  interface Window {
    sxBench?: BenchResult
  }
}

async function run(): Promise<BenchResult> {
  const params = new URLSearchParams(location.search)
  const workers = Number(params.get('workers') ?? '0') || navigator.hardwareConcurrency
  const t0 = performance.now()
  const perWorker = Number(params.get('perWorker') ?? '0') || undefined
  const wasmUrl = new URL('../pkg/sx_wasm.wasm', import.meta.url)
  const warmParam = params.get('warm')
  const slicer =
    perWorker || warmParam !== null
      ? await createWasmSlicer({ workers, wasm: wasmUrl, shardsPerWorker: perWorker ?? 8, warmUp: warmParam !== '0' })
      : await createWebSlicer({ workers, wasmUrl })
  const poolMs = performance.now() - t0
  const modelBytes = await (await fetch(params.get('model') ?? '')).arrayBuffer()
  const bench = (await (await fetch(params.get('config') ?? '')).json()) as { config: SliceRequest['config'] }
  const modelUrl = params.get('model') ?? ''
  const fileName = modelUrl.split('/').pop() ?? 'model.stl'
  const [tx, ty, tz] = placement(fileName, modelBytes)
  const t1 = performance.now()
  const mesh = await slicer.loadModel(modelBytes, fileName)
  const loadMs = performance.now() - t1
  const req: SliceRequest = {
    plate: {
      bed: { widthMm: 256, depthMm: 256, heightMm: 250 },
      objects: [{ id: 'o1', name: fileName, mesh: mesh.id, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1] }],
    },
    config: bench.config,
  }
  const t2 = performance.now()
  const first = await slicer.slice(req)
  const firstSliceMs = performance.now() - t2
  const t3 = performance.now()
  const warm = await slicer.slice(req)
  const warmSliceMs = performance.now() - t3
  const t4 = performance.now()
  await slicer.getPreview(warm.id)
  const previewMs = performance.now() - t4
  const gcode = await slicer.exportGcode(first.id, { kind: 'blob' })
  const single = await slicer.slice({ ...req, options: { shards: 1 } })
  const [a, b] = await Promise.all([slicer.getPreview(single.id), slicer.getPreview(first.id)])
  const singleGcode = await slicer.exportGcode(single.id, { kind: 'blob' })
  const shardsEqual = singleGcode.sha256 === gcode.sha256 && a.byteLength === b.byteLength && new Uint8Array(a).every((v, i) => v === new Uint8Array(b)[i])
  return { poolMs, loadMs, firstSliceMs, warmSliceMs, previewMs, layers: first.layerCount, gcodeBytes: gcode.bytes, gcodeSha256: gcode.sha256, shardsEqual, workers }
}

const out = document.getElementById('out')
run()
  .then((r) => {
    window.sxBench = r
    if (out) out.textContent = JSON.stringify(r, null, 2)
  })
  .catch((e: unknown) => {
    const error = e instanceof Error ? e.message : String(e)
    window.sxBench = { poolMs: 0, loadMs: 0, firstSliceMs: 0, warmSliceMs: 0, previewMs: 0, layers: 0, gcodeBytes: 0, gcodeSha256: '', shardsEqual: false, workers: 0, error }
    if (out) out.textContent = error
  })
