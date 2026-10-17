// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The end-to-end test build's slicer, and only that build's: playwright.config.ts sets SLICERX_E2E_NATIVE_URL, and
// every other build leaves this file out (scripts/check-test-host.mjs checks the bundle). Meshes are kept and opened
// as in the CAD-only build (meshes.ts). Slices run in the native engine behind e2e/native-host/server.mjs, the same
// sx-core the desktop app links, with the request and result shapes of the desktop's slicer
// (apps/desktop/src/host/slicer.ts), so the browser suite tests what the desktop slices.
import type { GcodeExport, MeshPart, ProjectMetadata, SliceRequest, SliceResult, SliceStage, SliceWarning, SlicerHost } from '@slicerx/contracts'
import { encodeParts, sliceClock } from '@slicerx/slicer'
import { createMeshHost } from './meshes'

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === 'object'
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number) : [])

const WARNING_CODES = new Set<SliceWarning['code']>(['open_edges', 'thin_wall', 'floating_region', 'long_bridge', 'outside_bed', 'unsupported_setting', 'manual_step', 'collision', 'safety_limit'])

/** The engine's report (`sx slice --request`), as the desktop's slicer reads its own. */
export function toResult(id: string, v: unknown, wallMs: number): SliceResult {
  if (!isRec(v) || !isRec(v['stats']) || !Array.isArray(v['warnings'])) throw new Error('The test slicer returned an unexpected slice result')
  const st = v['stats']
  const stageMicros: SliceResult['stageMicros'] = {}
  if (isRec(v['stageMicros'])) for (const [k, x] of Object.entries(v['stageMicros'])) stageMicros[k as SliceStage] = Number(x) || 0
  const fm = v['filamentMap']
  const collisions = Array.isArray(v['collisions']) && v['collisions'].length ? { collisions: v['collisions'] as SliceResult['collisions'] & object, collisionFixes: (Array.isArray(v['collisionFixes']) ? v['collisionFixes'] : []) as SliceResult['collisionFixes'] & object } : {}
  return {
    id,
    engine: 'sx',
    layerCount: Number(v['layerCount']) || 0,
    layerZ: Float32Array.from(nums(v['layerZ'])),
    layerTimeS: Float32Array.from(nums(v['layerTimeS'])),
    stats: { timeS: Number(st['timeS']) || 0, ...(Number(st['prepareS']) > 0 ? { prepareS: Number(st['prepareS']) } : {}), filamentMm: nums(st['filamentMm']), filamentG: nums(st['filamentG']), cost: Number(st['cost']) || 0, toolChanges: Number(st['toolChanges']) || 0 },
    stageMicros,
    wallMs,
    ...(typeof v['wallMs'] === 'number' ? { engineWallMs: v['wallMs'] } : {}),
    warnings: (v['warnings'] as unknown[]).flatMap((w) =>
      isRec(w) && typeof w['code'] === 'string' && typeof w['message'] === 'string'
        ? [{ code: WARNING_CODES.has(w['code'] as SliceWarning['code']) ? (w['code'] as SliceWarning['code']) : 'unsupported_setting', message: w['message'], ...(typeof w['layer'] === 'number' ? { layer: w['layer'] } : {}) }]
        : [],
    ),
    ...(v['gcodeFormat'] === 'bgcode' ? { gcodeFormat: 'bgcode' as const } : {}),
    ...(typeof v['fileName'] === 'string' && v['fileName'] ? { fileName: v['fileName'] } : {}),
    ...(isRec(v['primeTower']) ? { primeTower: v['primeTower'] as unknown as NonNullable<SliceResult['primeTower']> } : {}),
    ...(isRec(v['varyLayerCost']) ? { varyLayerCost: v['varyLayerCost'] as unknown as NonNullable<SliceResult['varyLayerCost']> } : {}),
    ...(isRec(fm) ? { filamentMap: { extruders: nums(fm['extruders']), nozzles: nums(fm['nozzles']), auto: fm['auto'] === true } } : {}),
    ...collisions,
  }
}

/** Byte offsets of each line of `gcode`, as the desktop's slicer hands them to the G-code panel. */
export function lineStarts(gcode: Uint8Array): Uint32Array {
  const out = [0]
  for (let i = 0; i < gcode.length - 1; i++) if (gcode[i] === 10) out.push(i + 1)
  return Uint32Array.from(out)
}

/** The parts of a model in the raw parts format (SXMP, as `Mesh::from_raw` reads it), without the paint after them; null for any other file. */
export function rawParts(data: ArrayBuffer): MeshPart[] | null {
  const b = new Uint8Array(data)
  if (b.length < 8 || String.fromCharCode(...b.subarray(0, 4)) !== 'SXMP') return null
  const v = new DataView(data)
  const parts: MeshPart[] = []
  let o = 8
  for (let i = v.getUint32(4, true); i > 0; i--) {
    const slot = v.getUint8(o)
    const len = v.getUint16(o + 1, true)
    const name = new TextDecoder().decode(b.subarray(o + 3, o + 3 + len))
    o += 3 + len
    const nv = v.getUint32(o, true)
    const positions = new Float32Array(data.slice(o + 4, o + 4 + nv * 12))
    o += 4 + nv * 12
    const nt = v.getUint32(o, true)
    const indices = new Uint32Array(data.slice(o + 4, o + 4 + nt * 12))
    o += 4 + nt * 12
    parts.push({ name, slot, positions, indices })
  }
  return parts
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function createNativeTestSlicer(url: string): SlicerHost {
  const meshes = createMeshHost()
  const sent = new Set<string>()
  // models loaded from raw parts (a painted object's copy) go to the engine as they came, paint block included
  const raw = new Map<string, ArrayBuffer>()
  const gcode = new Map<string, Promise<Uint8Array>>()
  let nextJob = 1
  // Every page of a run shares the server, so each keeps its meshes and slices under its own session.
  const base = `${url}/s/${crypto.randomUUID()}`
  const call = async (path: string, init?: RequestInit): Promise<Response> => {
    const r = await fetch(`${base}${path}`, init)
    if (!r.ok) throw new Error((await r.text()) || `${path}: ${r.status}`)
    return r
  }
  // Each mesh crosses once, in the raw parts format with its paint, the way the desktop app hands meshes to the engine.
  const upload = async (id: string): Promise<void> => {
    if (sent.has(id)) return
    const body = raw.get(id) ?? encodeParts(await meshes.meshParts!(id))
    await call(`/meshes/${encodeURIComponent(id)}`, { method: 'PUT', body: body as BodyInit })
    sent.add(id)
  }
  const bytesOf = (id: string): Promise<Uint8Array> => {
    let g = gcode.get(id)
    if (!g) {
      g = call(`/slices/${id}/gcode`).then(async (r) => new Uint8Array(await r.arrayBuffer()))
      gcode.set(id, g)
    }
    return g
  }
  return {
    async loadModel(data, fileName) {
      const parts = rawParts(data)
      if (!parts) return meshes.loadModel(data, fileName)
      const handle = await meshes.loadParts(fileName, parts)
      raw.set(handle.id, data)
      return handle
    },
    loadParts: (name, parts) => meshes.loadParts(name, parts),
    meshParts: (id) => meshes.meshParts!(id),
    async reviewScripts(inputs) {
      const r = await call('/script-review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(inputs) })
      return r.json()
    },
    async projectMetadata(data: ArrayBuffer, fileName: string): Promise<ProjectMetadata> {
      const r = await call(`/metadata?name=${encodeURIComponent(fileName)}`, { method: 'POST', body: data })
      return (await r.json()) as ProjectMetadata
    },
    async slice(req: SliceRequest, opts): Promise<SliceResult> {
      const started = performance.now()
      const ids = new Set(req.plate.objects.flatMap((o) => [o.mesh, ...(o.volumes ?? []).map((v) => v.mesh)]))
      await Promise.all([...ids].map(upload))
      if (opts?.signal?.aborted) throw new DOMException('Slice canceled', 'AbortError')
      opts?.onProgress?.({ stage: 'layers', fraction: 0 })
      const job = `native-slice-${nextJob++}`
      const cancel = () => void fetch(`${base}/slices/${job}`, { method: 'DELETE' }).catch(() => undefined)
      opts?.signal?.addEventListener('abort', cancel, { once: true })
      let report: unknown
      try {
        const r = await call(`/slices/${job}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plate: req.plate, config: req.config, options: { ...sliceClock(), ...(req.options ?? {}) } }) })
        report = await r.json()
      } catch (e) {
        if (opts?.signal?.aborted) throw new DOMException('Slice canceled', 'AbortError')
        throw e
      } finally {
        opts?.signal?.removeEventListener('abort', cancel)
      }
      if (opts?.signal?.aborted) throw new DOMException('Slice canceled', 'AbortError')
      opts?.onProgress?.({ stage: 'preview', fraction: 1 })
      return toResult(job, report, performance.now() - started)
    },
    async getPreview(id) {
      return (await call(`/slices/${id}/preview`)).arrayBuffer()
    },
    async exportGcode(id, target): Promise<GcodeExport> {
      const bytes = (await bytesOf(id)).slice().buffer
      const out: GcodeExport = { fileName: `plate-${id}.gcode`, bytes: bytes.byteLength, sha256: await sha256Hex(bytes) }
      if (target.kind === 'blob') out.blob = new Blob([bytes], { type: 'text/x-gcode' })
      else out.path = target.path
      return out
    },
    gcodeLineStarts: async (id) => lineStarts(await bytesOf(id)),
    gcodeBytes: async (id, start, end) => (await bytesOf(id)).slice(start, end),
    release(id) {
      if (id.startsWith('native-slice-')) {
        gcode.delete(id)
        void fetch(`${base}/slices/${id}`, { method: 'DELETE' }).catch(() => undefined)
        return
      }
      meshes.release(id)
      sent.delete(id)
      raw.delete(id)
    },
  }
}
