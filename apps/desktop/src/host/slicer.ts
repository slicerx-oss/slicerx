// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// SlicerHost over the native `slice` commands. Geometry and results cross as
// raw bytes; only the small request and info objects are JSON.
import type { Collision, CollisionFix, GcodeExport, MeshHandle, SliceRequest, SliceResult, SliceStage, SliceWarning, SlicerHost } from '@slicerx/contracts'
import { encodeParts, sliceClock } from '@slicerx/slicer'
import { Channel, invoke } from '@tauri-apps/api/core'

// Small hand-written guards for the two info objects the Rust side returns. No schema library: the
// desktop entry stays small, and a wrong shape here is a build bug, not user input.
type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === 'object'
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number) : [])
function bad(what: string): never {
  throw new Error(`The slicer returned an unexpected ${what}`)
}

interface MeshInfo {
  id: number
  name: string
  triangles: number
  hash: string
  bboxMm: [number, number, number]
  parts: { name: string; slot: number; color?: string | null; triangles: number }[]
}

function parseMeshInfo(v: unknown): MeshInfo {
  if (!isRec(v) || typeof v['id'] !== 'number' || typeof v['hash'] !== 'string' || !Array.isArray(v['bboxMm']) || !Array.isArray(v['parts'])) bad('mesh result')
  const bb = nums(v['bboxMm'])
  return {
    id: v['id'] as number,
    name: typeof v['name'] === 'string' ? v['name'] : '',
    triangles: Number(v['triangles']) || 0,
    hash: v['hash'] as string,
    bboxMm: [bb[0] ?? 0, bb[1] ?? 0, bb[2] ?? 0],
    parts: (v['parts'] as unknown[]).map((p) => {
      if (!isRec(p) || typeof p['name'] !== 'string') bad('mesh part')
      return { name: p['name'] as string, slot: Number(p['slot']) || 1, triangles: Number(p['triangles']) || 0, ...(typeof p['color'] === 'string' ? { color: p['color'] } : {}) }
    }),
  }
}

interface SliceInfo {
  id: number
  layerCount: number
  layerZ: number[]
  layerTimeS: number[]
  stats: { timeS: number; prepareS?: number; filamentMm: number[]; filamentG: number[]; cost: number; toolChanges: number }
  stageMicros: Record<string, number>
  warnings: { code: string; message: string; layer?: number }[]
  gcodeFormat?: 'bgcode'
  fileName?: string
  filamentMap?: { extruders: number[]; nozzles: number[]; auto: boolean }
  collisions?: Collision[]
  collisionFixes?: CollisionFix[]
}

function parseSliceInfo(v: unknown): SliceInfo {
  if (!isRec(v) || typeof v['id'] !== 'number' || !isRec(v['stats']) || !Array.isArray(v['warnings'])) bad('slice result')
  const st = v['stats'] as Rec
  const stageMicros: Record<string, number> = {}
  if (isRec(v['stageMicros'])) for (const [k, x] of Object.entries(v['stageMicros'] as Rec)) stageMicros[k] = Number(x) || 0
  return {
    id: v['id'] as number,
    layerCount: Number(v['layerCount']) || 0,
    layerZ: nums(v['layerZ']),
    layerTimeS: nums(v['layerTimeS']),
    stats: { timeS: Number(st['timeS']) || 0, ...(Number(st['prepareS']) > 0 ? { prepareS: Number(st['prepareS']) } : {}), filamentMm: nums(st['filamentMm']), filamentG: nums(st['filamentG']), cost: Number(st['cost']) || 0, toolChanges: Number(st['toolChanges']) || 0 },
    stageMicros,
    warnings: (v['warnings'] as unknown[]).flatMap((w) => (isRec(w) && typeof w['code'] === 'string' && typeof w['message'] === 'string' ? [{ code: w['code'], message: w['message'], ...(typeof w['layer'] === 'number' ? { layer: w['layer'] } : {}) }] : [])),
    ...(v['gcodeFormat'] === 'bgcode' ? { gcodeFormat: 'bgcode' as const } : {}),
    ...(typeof v['fileName'] === 'string' && v['fileName'] ? { fileName: v['fileName'] } : {}),
    ...(isRec(v['filamentMap']) ? { filamentMap: { extruders: nums((v['filamentMap'] as Rec)['extruders']), nozzles: nums((v['filamentMap'] as Rec)['nozzles']), auto: (v['filamentMap'] as Rec)['auto'] === true } } : {}),
    // The engine's own report of collisions and fixes, passed through as it wrote them.
    ...(Array.isArray(v['collisions']) && v['collisions'].length ? { collisions: v['collisions'] as Collision[], collisionFixes: Array.isArray(v['collisionFixes']) ? (v['collisionFixes'] as CollisionFix[]) : [] } : {}),
  }
}

const WARNING_CODES = new Set<SliceWarning['code']>(['open_edges', 'thin_wall', 'floating_region', 'long_bridge', 'outside_bed', 'unsupported_setting', 'manual_step', 'collision', 'safety_limit'])

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function load(bytes: Uint8Array, name: string): Promise<MeshHandle> {
  // Header values take only Latin-1, so the name goes percent-encoded; the shell decodes it.
  const info = parseMeshInfo(await invoke('load_mesh', bytes, { headers: { 'x-sx-name': encodeURIComponent(name) } }))
  return {
    id: String(info.id),
    hash: info.hash,
    name: info.name || name,
    triangles: info.triangles,
    bboxMm: info.bboxMm,
    openEdges: 0,
    parts: info.parts.map((p) => ({ name: p.name, slot: p.slot, triangles: p.triangles, ...(p.color ? { color: p.color } : {}) })),
  }
}

let nextJob = 1

/**
 * Where each engine stage sits in the whole slice, from and to, roughly as the time goes on a big model: cutting the
 * layers, working out each layer's walls and surfaces, the paths, then the G-code and the preview. A stage the engine
 * does not report is passed over; the bar never goes back.
 */
const STAGE_SPAN: Partial<Record<SliceStage, [number, number]>> = {
  layers: [0, 0.02],
  contours: [0.02, 0.25],
  perimeters: [0.25, 0.55],
  surfaces: [0.25, 0.55],
  infill: [0.25, 0.55],
  paths: [0.55, 0.9],
  gcode: [0.9, 0.97],
  preview: [0.97, 1],
}

/** The engine's (stage, fraction within it) as one fraction of the whole slice that only grows. */
export function overallProgress(): (stage: SliceStage, fraction: number) => number {
  let best = 0
  return (stage, fraction) => {
    const [a, b] = STAGE_SPAN[stage] ?? [best, best]
    best = Math.max(best, a + (b - a) * Math.min(1, Math.max(0, fraction)))
    return best
  }
}

export function createTauriSlicer(): SlicerHost {
  return {
    loadModel: (data, fileName) => load(new Uint8Array(data), fileName),
    loadParts: (name, parts) => load(encodeParts(parts), `${name}.sxmp`),
    async slice(req: SliceRequest, opts): Promise<SliceResult> {
      const started = performance.now()
      const request = JSON.stringify({ plate: { ...req.plate, objects: req.plate.objects.map((o) => ({ ...o, mesh: Number(o.mesh), ...(o.volumes ? { volumes: o.volumes.map((v) => ({ ...v, mesh: Number(v.mesh) })) } : {}) })) }, config: req.config, options: { ...sliceClock(), ...(req.options ?? {}) } })
      opts?.onProgress?.({ stage: 'layers', fraction: 0 })
      // A cancel stops the engine between stages; a result that lands anyway is let go at once.
      const job = nextJob++
      const signal = opts?.signal
      const cancel = () => void invoke('cancel_slice', { job }).catch(() => undefined)
      if (signal?.aborted) throw new DOMException('Slice canceled', 'AbortError')
      signal?.addEventListener('abort', cancel, { once: true })
      // The engine's progress, a few times a second, as one fraction of the whole slice.
      const onProgress = new Channel<{ stage: SliceStage; fraction: number }>()
      const overall = overallProgress()
      onProgress.onmessage = (p) => opts?.onProgress?.({ stage: p.stage, fraction: overall(p.stage, p.fraction) })
      let raw: unknown
      try {
        raw = await invoke('slice', { request, job, onProgress })
      } catch (e) {
        if (signal?.aborted) throw new DOMException('Slice canceled', 'AbortError')
        throw e
      } finally {
        signal?.removeEventListener('abort', cancel)
      }
      const info = parseSliceInfo(raw)
      if (signal?.aborted) {
        void invoke('release', { id: info.id }).catch(() => undefined)
        throw new DOMException('Slice canceled', 'AbortError')
      }
      const stageMicros: SliceResult['stageMicros'] = {}
      for (const [k, v] of Object.entries(info.stageMicros)) stageMicros[k as SliceStage] = v
      return {
        id: String(info.id),
        engine: 'sx',
        layerCount: info.layerCount,
        layerZ: Float32Array.from(info.layerZ),
        layerTimeS: Float32Array.from(info.layerTimeS),
        stats: info.stats,
        stageMicros,
        wallMs: performance.now() - started,
        warnings: info.warnings.map((w) => ({ code: WARNING_CODES.has(w.code as SliceWarning['code']) ? (w.code as SliceWarning['code']) : 'unsupported_setting', message: w.message, ...(w.layer !== undefined ? { layer: w.layer } : {}) })),
        ...(info.gcodeFormat ? { gcodeFormat: info.gcodeFormat } : {}),
        ...(info.fileName ? { fileName: info.fileName } : {}),
        ...(info.filamentMap ? { filamentMap: info.filamentMap } : {}),
        ...(info.collisions ? { collisions: info.collisions, collisionFixes: info.collisionFixes ?? [] } : {}),
      }
    },
    getPreview: (id) => invoke<ArrayBuffer>('get_preview', { id: Number(id) }),
    async exportGcode(id, target): Promise<GcodeExport> {
      const bytes = await invoke<ArrayBuffer>('get_gcode', { id: Number(id) })
      const out: GcodeExport = { fileName: `plate-${id}.gcode`, bytes: bytes.byteLength, sha256: await sha256Hex(bytes) }
      if (target.kind === 'blob') out.blob = new Blob([bytes], { type: 'text/x-gcode' })
      else out.path = target.path
      return out
    },
    gcodeLineStarts: async (id) => new Uint32Array(await invoke<ArrayBuffer>('get_gcode_line_starts', { id: Number(id) })),
    gcodeBytes: async (id, start, end) => new Uint8Array(await invoke<ArrayBuffer>('get_gcode_bytes', { id: Number(id), start, end })),
    release: (id) => void invoke('release', { id: Number(id) }),
  }
}
