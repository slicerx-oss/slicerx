// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A stand-in for the SlicerX cloud slicer with the same SlicerHost shape the
// service client exposes (Host['cloud']). It reads the model's size, reports
// every pipeline stage as the service does, and returns estimates and a short
// G-code file sized from the settings. The app uses the real client
// when one is configured (see host/index.ts).
import {
  SLICE_STAGES,
  type GcodeExport,
  type GcodeTarget,
  type MeshHandle,
  type MeshPart,
  type SliceProgress,
  type SliceRequest,
  type SliceResult,
  type SlicerHost,
} from '@slicerx/contracts'
import { meshBounds } from './stl'

export interface CloudStubOptions {
  /** Time spent in each pipeline stage, ms. Tests pass 0. */
  stageMs?: number
  /** Time the job waits in the queue before slicing starts, ms. */
  queueMs?: number
}

const PLA_DENSITY = 1.24
const FILAMENT_AREA_MM2 = Math.PI * 0.875 * 0.875

function abortError(): DOMException {
  return new DOMException('Slice canceled', 'AbortError')
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(abortError())
    })
  })
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseFloat(v) : Number.NaN
  return Number.isFinite(n) ? n : fallback
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

interface Sliced {
  result: SliceResult
  name: string
  layerHeight: number
}

export function createCloudStub(opts: CloudStubOptions = {}): SlicerHost {
  const stageMs = opts.stageMs ?? 420
  const queueMs = opts.queueMs ?? 700
  const meshes = new Map<string, MeshHandle>()
  const slices = new Map<string, Sliced>()
  let seq = 1

  const handle = (name: string, triangles: number, bboxMm: [number, number, number]): MeshHandle => {
    const id = `cloud-mesh-${seq++}`
    const h: MeshHandle = { id, hash: id, name, triangles, bboxMm, openEdges: 0, parts: [{ name, slot: 1, triangles }] }
    meshes.set(id, h)
    return h
  }

  return {
    async loadModel(data, fileName) {
      const b = meshBounds(data)
      return handle(fileName, b.triangles, b.sizeMm)
    },
    async loadParts(name: string, parts: MeshPart[]) {
      let triangles = 0
      const min = [Infinity, Infinity, Infinity]
      const max = [-Infinity, -Infinity, -Infinity]
      for (const p of parts) {
        triangles += p.indices.length / 3
        for (let i = 0; i < p.positions.length; i++) {
          const v = p.positions[i] ?? 0
          const a = i % 3
          min[a] = Math.min(min[a] ?? v, v)
          max[a] = Math.max(max[a] ?? v, v)
        }
      }
      const size = [0, 1, 2].map((a) => Math.max(0, (max[a] ?? 0) - (min[a] ?? 0))) as [number, number, number]
      return handle(name, triangles, size)
    },
    async slice(req: SliceRequest, o?: { onProgress?: (p: SliceProgress) => void; signal?: AbortSignal }): Promise<SliceResult> {
      const started = performance.now()
      const signal = o?.signal
      await wait(queueMs, signal)
      const stageMicros: SliceResult['stageMicros'] = {}
      for (const stage of SLICE_STAGES) {
        const steps = 4
        for (let i = 0; i <= steps; i++) {
          o?.onProgress?.({ stage, fraction: i / steps })
          if (i < steps) await wait(stageMs / steps, signal)
        }
        stageMicros[stage] = stageMs * 1000
      }

      const layerHeight = num(req.config['layer_height'], 0.2)
      const walls = num(req.config['wall_loops'], 2)
      const infill = num(req.config['sparse_infill_density'], 15) / 100
      const objects = req.plate.objects.map((obj) => meshes.get(obj.mesh)).filter((m): m is MeshHandle => m !== undefined)
      const height = Math.max(layerHeight, ...objects.map((m) => m.bboxMm[2]))
      const layerCount = Math.max(1, Math.round(height / layerHeight))
      // Shell plus infill volume of each bounding box, scaled by a fill factor for typical parts.
      const volumeMm3 = objects.reduce((sum, m) => {
        const [x, y, z] = m.bboxMm
        const outer = x * y * z * 0.38
        const shell = 2 * (x * y + y * z + x * z) * 0.42 * walls * 0.5
        return sum + Math.min(outer, shell) + Math.max(0, outer - shell) * infill
      }, 0)
      const filamentMm = volumeMm3 / FILAMENT_AREA_MM2
      const grams = (volumeMm3 / 1000) * PLA_DENSITY
      const timeS = Math.round(layerCount * 6 + volumeMm3 / 9)
      const id = `cloud-slice-${seq++}`
      const layerZ = new Float32Array(layerCount).map((_, i) => (i + 1) * layerHeight)
      const layerTimeS = new Float32Array(layerCount).fill(timeS / layerCount)
      const result: SliceResult = {
        id,
        engine: 'sx',
        layerCount,
        layerZ,
        layerTimeS,
        stats: { timeS, filamentMm: [filamentMm], filamentG: [grams], cost: grams * 0.022, toolChanges: 0 },
        stageMicros,
        wallMs: performance.now() - started,
        warnings: [],
      }
      slices.set(id, { result, name: objects[0]?.name ?? 'plate', layerHeight })
      return result
    },
    getPreview(sliceId: string): Promise<ArrayBuffer> {
      return Promise.reject(new Error(`The cloud preview for ${sliceId} is not available on the phone`))
    },
    async exportGcode(sliceId: string, target: GcodeTarget): Promise<GcodeExport> {
      const s = slices.get(sliceId)
      if (!s) throw new Error(`Unknown slice ${sliceId}`)
      const base = s.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'plate'
      const lines = [
        `; local stand-in for cloud slicing`,
        `; layer_height = ${s.layerHeight}`,
        `; total layers = ${s.result.layerCount}`,
        `; estimated time = ${s.result.stats.timeS} s`,
        'G90',
        'M83',
        'G28',
      ]
      for (let i = 0; i < s.result.layerCount; i++) lines.push(`;LAYER:${i}`, `G1 Z${((i + 1) * s.layerHeight).toFixed(2)} F600`)
      lines.push('M84', '')
      const bytes = new TextEncoder().encode(lines.join('\n'))
      const buffer = bytes.buffer.slice(0) as ArrayBuffer
      const out: GcodeExport = { fileName: `${base}.gcode`, bytes: bytes.byteLength, sha256: await sha256Hex(buffer) }
      if (target.kind === 'blob') out.blob = new Blob([buffer], { type: 'text/x-gcode' })
      else out.path = target.path
      return out
    },
    release(id: string): void {
      meshes.delete(id)
      slices.delete(id)
    },
  }
}
