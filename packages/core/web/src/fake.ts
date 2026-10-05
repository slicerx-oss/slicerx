// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A stand-in SlicerHost for consumers that need a slicer before the WASM pool
// is ready: it answers after a fixed delay with a synthetic SXPV (a stack of
// rings) and a matching short G-code file.
import {
  FEATURE,
  SXPV_HEADER_BYTES,
  SXPV_MAGIC,
  SXPV_SEGMENT_BYTES,
  SXPV_VERSION,
  type GcodeExport,
  type GcodeTarget,
  type MeshHandle,
  type MeshPart,
  type SliceProgress,
  type SliceRequest,
  type SliceResult,
  type SlicerHost,
} from '@slicerx/contracts'

export interface FakeSlicerOptions {
  /** Delay before slice() resolves, ms. */
  delayMs?: number
  /** Layers in the synthetic result. */
  layers?: number
}

interface RingSpec {
  layers: number
  layerHeight: number
  segmentsPerRing: number
  centerX: number
  centerY: number
}

/** Writes a synthetic SXPV buffer: per layer an outer and an inner ring whose radius follows a vase profile. */
export function syntheticPreview(spec: Partial<RingSpec> = {}): ArrayBuffer {
  const { layers = 508, layerHeight = 0.2, segmentsPerRing = 64, centerX = 128, centerY = 128 } = spec
  const rings = 2
  const segmentCount = layers * rings * segmentsPerRing
  const tableBytes = (layers + 1) * 4 + layers * 4 + layers * 4
  const raw = new ArrayBuffer(SXPV_HEADER_BYTES + tableBytes + segmentCount * SXPV_SEGMENT_BYTES)
  const v = new DataView(raw)
  v.setUint32(0, SXPV_MAGIC, true)
  v.setUint16(4, SXPV_VERSION, true)
  v.setUint16(6, 0, true)
  v.setUint32(8, segmentCount, true)
  v.setUint32(12, layers, true)
  v.setUint32(16, 0, true)
  v.setUint32(20, 1, true)
  v.setFloat32(24, layerHeight, true)
  let o = SXPV_HEADER_BYTES
  for (let l = 0; l <= layers; l++) v.setUint32(o + l * 4, l * rings * segmentsPerRing, true)
  o += (layers + 1) * 4
  for (let l = 0; l < layers; l++) v.setFloat32(o + l * 4, (l + 1) * layerHeight, true)
  o += layers * 4
  for (let l = 0; l < layers; l++) v.setFloat32(o + l * 4, 4 + 2 * Math.sin(l / 40), true)
  o += layers * 4
  const width = 0.42
  const flow = ((width - layerHeight) * layerHeight + Math.PI * (layerHeight / 2) ** 2) * 200
  for (let l = 0; l < layers; l++) {
    const t = l / Math.max(1, layers - 1)
    const outer = 18 + 14 * Math.sin(Math.PI * t) + 3 * Math.sin(t * 18)
    const z = (l + 1) * layerHeight
    for (let r = 0; r < rings; r++) {
      const radius = outer - r * width
      for (let s = 0; s < segmentsPerRing; s++) {
        const a0 = (s / segmentsPerRing) * Math.PI * 2
        const a1 = ((s + 1) / segmentsPerRing) * Math.PI * 2
        v.setFloat32(o, centerX + radius * Math.cos(a0), true)
        v.setFloat32(o + 4, centerY + radius * Math.sin(a0), true)
        v.setFloat32(o + 8, centerX + radius * Math.cos(a1), true)
        v.setFloat32(o + 12, centerY + radius * Math.sin(a1), true)
        v.setFloat32(o + 16, z, true)
        v.setUint16(o + 20, Math.round(width * 1000), true)
        v.setUint16(o + 22, Math.round(layerHeight * 1000), true)
        v.setUint8(o + 24, r === 0 ? FEATURE.outerWall : FEATURE.innerWall)
        v.setUint8(o + 25, 0)
        v.setUint16(o + 26, 2000, true)
        v.setFloat32(o + 28, flow, true)
        o += SXPV_SEGMENT_BYTES
      }
    }
  }
  return raw
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function abortError(): DOMException {
  return new DOMException('Slice canceled', 'AbortError')
}

export function createFakeSlicer(opts: FakeSlicerOptions = {}): SlicerHost {
  const delayMs = opts.delayMs ?? 150
  const layers = opts.layers ?? 508
  const meshes = new Map<string, MeshHandle>()
  const previews = new Map<string, ArrayBuffer>()
  let nextId = 1

  const handle = (name: string, triangles: number): MeshHandle => {
    const id = `mesh-${nextId++}`
    const h: MeshHandle = {
      id,
      hash: id,
      name,
      triangles,
      bboxMm: [75.18, 84.85, 101.53],
      openEdges: 0,
      parts: [{ name, slot: 1, triangles }],
    }
    meshes.set(id, h)
    return h
  }

  return {
    loadModel(data: ArrayBuffer, fileName: string): Promise<MeshHandle> {
      return Promise.resolve(handle(fileName, Math.max(0, Math.floor((data.byteLength - 84) / 50))))
    },
    loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> {
      const triangles = parts.reduce((n, p) => n + p.indices.length / 3, 0)
      return Promise.resolve(handle(name, triangles))
    },
    slice(req: SliceRequest, o?: { onProgress?: (p: SliceProgress) => void; signal?: AbortSignal }): Promise<SliceResult> {
      const started = performance.now()
      const layerHeight = typeof req.config.layer_height === 'number' ? req.config.layer_height : 0.2
      return new Promise((resolve, reject) => {
        if (o?.signal?.aborted) {
          reject(abortError())
          return
        }
        const timer = setTimeout(() => {
          const id = `slice-${nextId++}`
          previews.set(id, syntheticPreview({ layers, layerHeight }))
          const layerZ = new Float32Array(layers).map((_, i) => (i + 1) * layerHeight)
          const layerTimeS = new Float32Array(layers).fill(4)
          resolve({
            id,
            engine: 'sx',
            layerCount: layers,
            layerZ,
            layerTimeS,
            stats: { timeS: layers * 4, filamentMm: [4200], filamentG: [12.6], cost: 0.25, toolChanges: 0 },
            stageMicros: {},
            wallMs: performance.now() - started,
            warnings: [],
          })
        }, delayMs)
        o?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(abortError())
        })
      })
    },
    getPreview(sliceId: string): Promise<ArrayBuffer> {
      const p = previews.get(sliceId)
      return p ? Promise.resolve(p.slice(0)) : Promise.reject(new Error(`Unknown slice ${sliceId}`))
    },
    async exportGcode(sliceId: string, target: GcodeTarget): Promise<GcodeExport> {
      if (!previews.has(sliceId)) throw new Error(`Unknown slice ${sliceId}`)
      const text = `; SlicerX synthetic G-code for ${sliceId}\nG90\nM83\nG28\n; ${layers} layers\nM84\n`
      const bytes = new TextEncoder().encode(text)
      const buffer = bytes.buffer.slice(0) as ArrayBuffer
      const out: GcodeExport = { fileName: `${sliceId}.gcode`, bytes: bytes.byteLength, sha256: await sha256Hex(buffer) }
      if (target.kind === 'blob') out.blob = new Blob([buffer], { type: 'text/x-gcode' })
      else out.path = target.path
      return out
    },
    release(id: string): void {
      meshes.delete(id)
      previews.delete(id)
    },
  }
}
