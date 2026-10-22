// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A SlicerHost that slices in the cloud, for `EditionHost.cloud`. Models load
// through the local slicer (for handles and bounds) and their bytes are kept
// so the plate can be uploaded when it is sliced. `cloudRoutedSlicer` puts it
// in front of the app's slicer, so every model the app loads is kept.
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
import type { CloudClient, CloudSliceObject, CloudSliceOptions, CloudSliceRequest } from './client'
import type { CloudJob } from './schemas'

export interface CloudSlicerOptions {
  client: CloudClient
  /** The host's own slicer; used to load models and build handles. */
  local: Pick<SlicerHost, 'loadModel' | 'loadParts' | 'release'>
  /**
   * The local slicer's parts encoder, so the uploaded copy is the mesh the local engine loads, paint included.
   * Default: `encodeParts` here, which writes the geometry without paint.
   */
  encodeParts?: (parts: MeshPart[]) => Uint8Array
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

const MB = 1024 * 1024
const mb = (n: number): string => `${Math.round((n / MB) * 10) / 10} MB`

/** Raw bytes as base64, for the thumbnail the service reads as text. */
function base64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** The request's options as the service reads them: everything the local engine gets, the thumbnail as base64. */
function cloudOptions(o: SliceRequest['options']): CloudSliceOptions {
  const { thumbnail, engine: _engine, ...rest } = o ?? {}
  return {
    ...rest,
    engine: 'sx',
    ...(thumbnail ? { thumbnail: { width: thumbnail.width, height: thumbnail.height, rgba: base64(thumbnail.rgba) } } : {}),
  }
}

/** An object as the service reads it: placement, slots, volumes, object and part settings and brim ears. */
function cloudObject(obj: SliceRequest['plate']['objects'][number]): CloudSliceObject {
  return {
    id: obj.id,
    name: obj.name,
    mesh: obj.mesh,
    transform: obj.transform,
    ...(obj.slotOverrides ? { slotOverrides: obj.slotOverrides } : {}),
    ...(obj.volumes?.length ? { volumes: obj.volumes.map((v) => ({ ...v })) } : {}),
    ...(obj.settings && Object.keys(obj.settings).length ? { settings: { ...obj.settings } } : {}),
    ...(obj.partSettings && Object.keys(obj.partSettings).length ? { partSettings: obj.partSettings } : {}),
    ...(obj.brimPoints?.length ? { brimPoints: obj.brimPoints } : {}),
  }
}

export function createCloudSlicer(opts: CloudSlicerOptions): SlicerHost {
  // Bytes of each loaded model; parts are kept as given and encoded on the first cloud slice that needs them, so a
  // person who slices on this device pays nothing for the copy.
  const sources = new Map<string, Uint8Array | MeshPart[]>()
  const jobs = new Map<string, CloudJob>()
  const encode = opts.encodeParts ?? encodeParts

  const unwrap = <T>(res: { ok: true; value: T } | { ok: false; message: string }): T => {
    if (!res.ok) throw new Error(res.message)
    return res.value
  }

  const bytesOf = (id: string): Uint8Array | undefined => {
    const src = sources.get(id)
    if (!src || src instanceof Uint8Array) return src
    const bytes = encode(src)
    sources.set(id, bytes)
    return bytes
  }

  return {
    async loadModel(data: ArrayBuffer, fileName: string): Promise<MeshHandle> {
      // Copy first: the local slicer may transfer the buffer to a worker.
      const copy = new Uint8Array(data.slice(0))
      const handle = await opts.local.loadModel(data, fileName)
      sources.set(handle.id, copy)
      return handle
    },

    async loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> {
      const handle = await opts.local.loadParts(name, parts)
      sources.set(handle.id, parts)
      return handle
    },

    async slice(req: SliceRequest, o = {}): Promise<SliceResult> {
      // Every mesh the plate names: each object's own and its volumes'.
      const meshes: Record<string, Uint8Array> = {}
      const need = (id: string, what: string) => {
        if (meshes[id]) return
        const bytes = bytesOf(id)
        if (!bytes) throw new Error(`${what} was not loaded through this slicer`)
        meshes[id] = bytes
      }
      for (const obj of req.plate.objects) {
        need(obj.mesh, `model ${obj.name}`)
        for (const v of obj.volumes ?? []) need(v.mesh, `volume ${v.name ?? v.role} of ${obj.name}`)
      }
      // Ask first, as the service expects: an account that is not invited, out of jobs or over its upload size
      // hears why before anything is uploaded.
      const access = unwrap(await opts.client.access())
      if (!access.invited) throw new Error('This account is not invited to cloud slicing yet. Slice on this device instead.')
      if (access.jobsToday >= access.jobsPerDay)
        throw new Error(`This account has used all ${access.jobsPerDay} cloud slices for the last 24 hours. Slice on this device instead.`)
      const biggest = Object.values(meshes).reduce((n, b) => Math.max(n, b.byteLength), 0)
      if (biggest > access.maxUploadBytes)
        throw new Error(`A model on this plate is ${mb(biggest)}, over this account's cloud upload limit of ${mb(access.maxUploadBytes)}. Slice on this device instead.`)
      const request: CloudSliceRequest = {
        schemaVersion: 1,
        plate: { bed: req.plate.bed, objects: req.plate.objects.map(cloudObject) },
        config: req.config as unknown as Record<string, unknown>,
        options: cloudOptions(req.options),
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
      // A cloud slice has nothing in the local slicer.
      if (jobs.delete(id)) return
      sources.delete(id)
      opts.local.release(id)
    },
  }
}

export interface CloudRouteOptions {
  /** The app's own slicer. */
  local: SlicerHost
  /** A cloud slicer made with `createCloudSlicer` over the same local slicer. */
  cloud: SlicerHost
  /** Whether the person chose cloud slicing; read on every slice. */
  enabled: () => boolean
  /** Turns a request into the one the cloud slices, such as resolving the settings the local engine resolves itself. */
  prepare?: (req: SliceRequest) => SliceRequest | Promise<SliceRequest>
}

/**
 * The app's slicer with cloud slicing behind a switch. Models load through the cloud slicer, which loads each one in
 * the local slicer too and keeps its bytes: handles are the local ones either way, and a cloud slice has every mesh
 * the plate names to upload. Slices go to the cloud while `enabled()`; previews and G-code come from where the slice ran.
 */
export function cloudRoutedSlicer(o: CloudRouteOptions): SlicerHost {
  const { local, cloud } = o
  const clouded = new Set<string>()
  return {
    ...local,
    loadModel: (data, fileName) => cloud.loadModel(data, fileName),
    loadParts: (name, parts) => cloud.loadParts(name, parts),
    slice: async (req, opts) => {
      if (!o.enabled()) return local.slice(req, opts)
      const r = await cloud.slice(o.prepare ? await o.prepare(req) : req, opts)
      clouded.add(r.id)
      return r
    },
    getPreview: (id) => (clouded.has(id) ? cloud.getPreview(id) : local.getPreview(id)),
    exportGcode: (id, target) => (clouded.has(id) ? cloud.exportGcode(id, target) : local.exportGcode(id, target)),
    release: (id) => {
      clouded.delete(id)
      cloud.release(id)
    },
  }
}
