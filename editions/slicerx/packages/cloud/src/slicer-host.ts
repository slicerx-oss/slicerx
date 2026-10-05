// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A SlicerHost that slices in the cloud, for `EditionHost.cloud`. Models load
// through the local slicer (for handles and bounds) and their bytes are kept
// so the plate can be uploaded when it is sliced.
import {
  type GcodeExport,
  type GcodeTarget,
  type MeshHandle,
  type MeshPart,
  SLICE_STAGES,
  type SliceProgress,
  type SliceRequest,
  type SliceResult,
  type SliceStage,
  type SliceWarning,
  type SliceWarningCode,
  type SlicerHost,
} from '@slicerx/contracts'
import type { CloudClient, CloudSliceRequest } from './client'
import type { CloudJob } from './schemas'

export interface CloudSlicerOptions {
  client: CloudClient
  /** The host's own slicer; used to load models and build handles. */
  local: Pick<SlicerHost, 'loadModel' | 'loadParts' | 'release'>
  /** Job poll interval, default 1000 ms. */
  pollMs?: number
}

const WARNING_CODES: readonly SliceWarningCode[] = [
  'open_edges',
  'thin_wall',
  'floating_region',
  'outside_bed',
  'unsupported_setting',
]

/** Encodes parts in the raw `SXMP` format `sx-core` reads (`Mesh::from_raw`). */
export function encodeParts(parts: MeshPart[]): Uint8Array {
  const enc = new TextEncoder()
  const names = parts.map((p) => enc.encode(p.name).slice(0, 0xffff))
  let size = 8
  parts.forEach((p, i) => {
    size += 1 + 2 + (names[i]?.length ?? 0) + 4 + p.positions.length * 4 + 4 + p.indices.length * 4
  })
  const out = new Uint8Array(size)
  const dv = new DataView(out.buffer)
  out.set(enc.encode('SXMP'), 0)
  let at = 4
  dv.setUint32(at, parts.length, true)
  at += 4
  parts.forEach((p, i) => {
    const name = names[i] ?? new Uint8Array()
    dv.setUint8(at, Math.max(1, Math.min(255, p.slot)))
    dv.setUint16(at + 1, name.length, true)
    out.set(name, at + 3)
    at += 3 + name.length
    dv.setUint32(at, p.positions.length / 3, true)
    at += 4
    for (const v of p.positions) {
      dv.setFloat32(at, v, true)
      at += 4
    }
    dv.setUint32(at, p.indices.length / 3, true)
    at += 4
    for (const v of p.indices) {
      dv.setUint32(at, v, true)
      at += 4
    }
  })
  return out
}

function progressFor(job: CloudJob): SliceProgress {
  const stage: SliceStage = job.stage === 'uploading' ? 'gcode' : job.stage === 'slicing' ? 'paths' : 'layers'
  return { stage, fraction: job.progress }
}

function toResult(job: CloudJob): SliceResult {
  const r = job.result
  if (!r) throw new Error('the cloud job finished without a result')
  const stageMicros: Partial<Record<SliceStage, number>> = {}
  for (const s of SLICE_STAGES) {
    const v = r.stageMicros[s]
    if (typeof v === 'number') stageMicros[s] = v
  }
  const warnings: SliceWarning[] = r.warnings.flatMap((w) => {
    const code = WARNING_CODES.find((c) => c === w.code)
    if (!code) return []
    return [w.layer === undefined ? { code, message: w.message } : { code, message: w.message, layer: w.layer }]
  })
  return {
    id: job.id,
    engine: 'sx',
    layerCount: r.layerCount,
    layerZ: Float32Array.from(r.layerZ),
    layerTimeS: Float32Array.from(r.layerTimeS),
    stats: r.stats,
    stageMicros,
    wallMs: r.wallMs,
    warnings,
  }
}

export function createCloudSlicer(opts: CloudSlicerOptions): SlicerHost {
  const meshBytes = new Map<string, Uint8Array>()
  const jobs = new Map<string, CloudJob>()

  const unwrap = <T>(res: { ok: true; value: T } | { ok: false; message: string }): T => {
    if (!res.ok) throw new Error(res.message)
    return res.value
  }

  return {
    async loadModel(data: ArrayBuffer, fileName: string): Promise<MeshHandle> {
      // Copy first: the local slicer may transfer the buffer to a worker.
      const copy = new Uint8Array(data.slice(0))
      const handle = await opts.local.loadModel(data, fileName)
      meshBytes.set(handle.id, copy)
      return handle
    },

    async loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> {
      const encoded = encodeParts(parts)
      const handle = await opts.local.loadParts(name, parts)
      meshBytes.set(handle.id, encoded)
      return handle
    },

    async slice(req: SliceRequest, o = {}): Promise<SliceResult> {
      const meshes: Record<string, Uint8Array> = {}
      for (const obj of req.plate.objects) {
        const bytes = meshBytes.get(obj.mesh)
        if (!bytes) throw new Error(`model ${obj.name} was not loaded through this slicer`)
        meshes[obj.mesh] = bytes
      }
      const options: NonNullable<CloudSliceRequest['options']> = { engine: 'sx' }
      if (req.options?.flavor) options.flavor = req.options.flavor
      if (req.options?.emitGcode !== undefined) options.emitGcode = req.options.emitGcode
      if (req.options?.emitPreview !== undefined) options.emitPreview = req.options.emitPreview
      const request: CloudSliceRequest = {
        schemaVersion: 1,
        plate: {
          bed: req.plate.bed,
          objects: req.plate.objects.map((obj) => ({
            id: obj.id,
            name: obj.name,
            mesh: obj.mesh,
            transform: obj.transform,
            ...(obj.slotOverrides ? { slotOverrides: obj.slotOverrides } : {}),
          })),
        },
        config: req.config as unknown as Record<string, unknown>,
        options,
      }
      const name = req.plate.objects.map((obj) => obj.name).join(', ').slice(0, 200) || 'Cloud slice'
      const submitted = unwrap(await opts.client.slicePlate({ name, meshes, request }))
      const onAbort = () => void opts.client.cancelJob(submitted.id)
      o.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const done = unwrap(
          await opts.client.waitForJob(submitted.id, {
            intervalMs: opts.pollMs ?? 1000,
            ...(o.signal ? { signal: o.signal } : {}),
            onUpdate: (job) => o.onProgress?.(progressFor(job)),
          }),
        )
        if (done.status !== 'succeeded') throw new Error(done.error ?? `the cloud job was ${done.status}`)
        jobs.set(done.id, done)
        return toResult(done)
      } finally {
        o.signal?.removeEventListener('abort', onAbort)
      }
    },

    async getPreview(sliceId: string): Promise<ArrayBuffer> {
      const job = jobs.get(sliceId)
      if (!job) throw new Error(`no cloud slice ${sliceId}`)
      return unwrap(await opts.client.downloadPreview(job)).slice().buffer
    },

    async exportGcode(sliceId: string, target: GcodeTarget): Promise<GcodeExport> {
      const job = jobs.get(sliceId)
      if (!job?.result) throw new Error(`no cloud slice ${sliceId}`)
      if (target.kind !== 'blob') throw new Error('cloud slices export as a download; save the blob with the file host')
      const data = unwrap(await opts.client.downloadGcode(job))
      return {
        fileName: `${job.name.replace(/[^A-Za-z0-9 ._-]/g, '_')}.gcode`,
        bytes: data.length,
        sha256: job.result.gcodeSha256,
        blob: new Blob([data.slice().buffer], { type: 'text/x-gcode' }),
      }
    },

    release(id: string) {
      meshBytes.delete(id)
      jobs.delete(id)
      opts.local.release(id)
    },
  }
}
