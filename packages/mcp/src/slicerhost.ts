// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A SlicerHost for Node, so mimir's skills can slice outside the app. It
// keeps meshes in memory, writes each plate as one STL with the object
// transforms applied, and slices it with the configured engine (the sx CLI
// or the stub). The core centers the combined plate on the bed.
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { GcodeExport, GcodeTarget, MeshHandle, MeshPart, PrintConfig, SettingValue, SliceRequest, SliceResult, SlicerHost } from '@slicerx/contracts'
import { defaultConfig, sameValue } from '@slicerx/settings'
import { meshStats, readStlPositions, transformPositions, writeBinaryStl } from './mesh'
import type { SlicerBackend } from './slicer'

interface StoredMesh {
  handle: MeshHandle
  positions: Float32Array
  minMm: [number, number, number]
}

interface StoredSlice {
  result: SliceResult
  gcodePath?: string
  previewPath?: string
}

export interface NodeSlicerHost extends SlicerHost {
  /** Geometry of a loaded mesh as one part, for orient and cut. */
  parts(meshId: string): MeshPart[]
  /** Lowest bounding box corner, so the project can place objects on the bed. */
  minCorner(meshId: string): [number, number, number]
  /** Size and lowest corner of a mesh after a 4x4 transform (a rotation), for placing it. */
  boundsAfter(meshId: string, transform: number[]): { size: [number, number, number]; min: [number, number, number] }
  /** Paths of the files a slice wrote. */
  files(sliceId: string): { gcodePath?: string; previewPath?: string } | undefined
}

function positionsFromParts(parts: MeshPart[]): Float32Array {
  const out: number[] = []
  for (const p of parts) for (const i of p.indices) out.push(p.positions[i * 3] ?? 0, p.positions[i * 3 + 1] ?? 0, p.positions[i * 3 + 2] ?? 0)
  return new Float32Array(out)
}

/** Keys that differ from the schema defaults: what profiles and overrides chose, which is all an engine with its own defaults needs. */
export function explicitKeys(config: PrintConfig): Record<string, SettingValue> {
  const defaults = defaultConfig()
  return Object.fromEntries(Object.entries(config).filter(([k, v]) => !sameValue(defaults[k], v)))
}

/**
 * `trustGcode` says whether a request's custom G-code is the text SlicerX ships, so the engine's normal G-code
 * checks apply instead of the strict ones. Without it every request gets the strict checks.
 */
export function createNodeSlicerHost(backend: SlicerBackend, outDir: string, trustGcode?: (config: Record<string, SettingValue>) => boolean): NodeSlicerHost {
  const meshes = new Map<string, StoredMesh>()
  const slices = new Map<string, StoredSlice>()

  const store = (name: string, positions: Float32Array): MeshHandle => {
    const stats = meshStats(positions)
    const hash = createHash('sha256').update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength)).digest('hex')
    const handle: MeshHandle = { id: `mesh-${hash.slice(0, 12)}`, hash, name, triangles: stats.triangles, bboxMm: stats.bboxMm, openEdges: 0, parts: [{ name, slot: 1, triangles: stats.triangles }] }
    meshes.set(handle.id, { handle, positions, minMm: stats.minMm })
    return handle
  }

  return {
    async loadModel(data, fileName) {
      if (extname(fileName).toLowerCase() !== '.stl') throw new Error(`${fileName}: only STL models can be loaded today.`)
      return store(fileName, readStlPositions(Buffer.from(data)))
    },
    async loadParts(name, parts) {
      return store(name, positionsFromParts(parts))
    },
    async slice(req: SliceRequest, opts) {
      if (opts?.signal?.aborted) throw new Error('Canceled')
      const started = performance.now()
      const chunks: Float32Array[] = []
      for (const obj of req.plate.objects) {
        const m = meshes.get(obj.mesh)
        if (!m) throw new Error(`Mesh ${obj.mesh} is not loaded`)
        chunks.push(transformPositions(m.positions, obj.transform))
      }
      if (chunks.length === 0) throw new Error('The plate is empty')
      const total = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
      let at = 0
      for (const c of chunks) {
        total.set(c, at)
        at += c.length
      }
      const id = `slice-${randomUUID().slice(0, 8)}`
      const dir = join(outDir, 'plates', id)
      mkdirSync(dir, { recursive: true })
      const modelPath = join(dir, 'plate.stl')
      writeFileSync(modelPath, writeBinaryStl(total))
      // One file per mesh, so an engine that takes a plate keeps each object's own transform.
      const objects = req.plate.objects.map((obj) => {
        const m = meshes.get(obj.mesh)
        const path = join(dir, `${obj.mesh}.stl`)
        if (m && !existsSync(path)) writeFileSync(path, writeBinaryStl(m.positions))
        return { path, name: obj.name, transform: obj.transform }
      })
      const summary = await backend.slice({
        plate: { bed: req.plate.bed, objects },
        modelPath,
        config: req.config,
        explicitConfig: explicitKeys(req.config),
        profileNames: [],
        overrides: {},
        outDir: dir,
        emitGcode: req.options?.emitGcode ?? true,
        trustedGcode: trustGcode?.(req.config as unknown as Record<string, SettingValue>) ?? false,
        emitPreview: req.options?.emitPreview ?? false,
      })
      const costPerKg = (() => {
        const v = req.config['filament_cost']
        const x = Array.isArray(v) ? v[0] : v
        return typeof x === 'number' ? x : 20
      })()
      const result: SliceResult = {
        id,
        engine: 'sx',
        layerCount: summary.layer_count,
        layerZ: new Float32Array(0),
        layerTimeS: new Float32Array(0),
        stats: { timeS: summary.time_s, filamentMm: [summary.filament_mm], filamentG: [summary.filament_g], cost: Math.round((summary.filament_g / 1000) * costPerKg * 100) / 100, toolChanges: 0 },
        stageMicros: {},
        wallMs: performance.now() - started,
        warnings: [...summary.warnings.map((message) => ({ code: 'unsupported_setting' as const, message })), ...(summary.note ? [{ code: 'unsupported_setting' as const, message: summary.note }] : [])],
      }
      slices.set(id, { result, ...(summary.gcode_path ? { gcodePath: summary.gcode_path } : {}), ...(summary.preview_path ? { previewPath: summary.preview_path } : {}) })
      opts?.onProgress?.({ stage: 'gcode', fraction: 1 })
      return result
    },
    async getPreview(sliceId) {
      const s = slices.get(sliceId)
      if (!s?.previewPath || !existsSync(s.previewPath)) throw new Error('No preview for this slice. The sx engine writes one when emitPreview is set.')
      const b = readFileSync(s.previewPath)
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
    },
    async exportGcode(sliceId, target: GcodeTarget): Promise<GcodeExport> {
      const s = slices.get(sliceId)
      if (!s?.gcodePath) throw new Error(`No G-code for slice ${sliceId}`)
      const bytes = readFileSync(s.gcodePath)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const fileName = `${sliceId}.gcode`
      if (target.kind === 'path') {
        copyFileSync(s.gcodePath, target.path)
        return { fileName, bytes: bytes.length, sha256, path: target.path }
      }
      return { fileName, bytes: bytes.length, sha256, blob: new Blob([bytes], { type: 'text/x-gcode' }) }
    },
    release(id) {
      meshes.delete(id)
      slices.delete(id)
    },
    parts(meshId) {
      const m = meshes.get(meshId)
      if (!m) return []
      const n = m.positions.length / 3
      return [{ name: m.handle.name, slot: 1, positions: m.positions, indices: Uint32Array.from({ length: n }, (_, i) => i) }]
    },
    minCorner(meshId) {
      return meshes.get(meshId)?.minMm ?? [0, 0, 0]
    },
    boundsAfter(meshId, transform) {
      const m = meshes.get(meshId)
      if (!m) return { size: [0, 0, 0], min: [0, 0, 0] }
      const stats = meshStats(transformPositions(m.positions, transform))
      return { size: stats.bboxMm, min: stats.minMm }
    },
    files(sliceId) {
      const s = slices.get(sliceId)
      return s ? { ...(s.gcodePath ? { gcodePath: s.gcodePath } : {}), ...(s.previewPath ? { previewPath: s.previewPath } : {}) } : undefined
    },
  }
}
