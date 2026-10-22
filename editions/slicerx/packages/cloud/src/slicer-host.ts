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
import { type CloudClient, type CloudSliceObject, type CloudSliceOptions, type CloudSliceRequest, type PackedMesh, packedSize } from './client'
import { sizeText } from './compress'
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

/**
 * The job's name, which also names its G-code file: the project's name, with the plate's after a first plate, else
 * the plate's name. Never the objects' names joined.
 */
function jobName(o: SliceRequest['options']): string {
  const model = o?.modelName?.trim() ?? ''
  const plate = o?.plateName?.trim() ?? ''
  const name = model ? (plate && (o?.plateNumber ?? 1) > 1 ? `${model} ${plate}` : model) : plate
  return name.slice(0, 200) || 'Cloud slice'
}

/** Where each line starts in a text, then one past its end (a final line break opens no empty line). */
export function lineStarts(bytes: Uint8Array): Uint32Array {
  const out: number[] = [0]
  for (let i = bytes.indexOf(10); i >= 0; i = bytes.indexOf(10, i + 1)) out.push(i + 1)
  if (out[out.length - 1] !== bytes.length) out.push(bytes.length)
  return Uint32Array.from(bytes.length === 0 ? [0] : out)
}

export function createCloudSlicer(opts: CloudSlicerOptions): SlicerHost {
  // Bytes of each loaded model; parts are kept as given and encoded on the first cloud slice that needs them, so a
  // person who slices on this device pays nothing for the copy.
  const sources = new Map<string, Uint8Array | MeshPart[]>()
  const jobs = new Map<string, CloudJob>()
  // A slice's G-code, downloaded once and kept while the line view or an export reads it.
  const texts = new Map<string, Promise<Uint8Array>>()
  // Each model as uploaded: hashed and compressed once, on the first cloud slice that needs it.
  const packed = new Map<string, Promise<PackedMesh>>()
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

  const gcodeOf = (sliceId: string): Promise<Uint8Array> => {
    let hit = texts.get(sliceId)
    if (!hit) {
      const job = jobs.get(sliceId)
      if (!job?.result) return Promise.reject(new Error(`no cloud slice ${sliceId}`))
      hit = opts.client.downloadGcode(job).then(unwrap)
      texts.set(sliceId, hit)
      // A failed download is not kept: the next read tries again.
      hit.catch(() => texts.get(sliceId) === hit && texts.delete(sliceId))
    }
    return hit
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
      // The limit reads the upload as sent, so compressed where the runtime can compress.
      const uploads: Record<string, PackedMesh> = {}
      for (const [id, bytes] of Object.entries(meshes)) {
        let hit = packed.get(id)
        if (!hit) {
          const next = opts.client.packMesh(bytes)
          packed.set(id, next)
          next.catch(() => packed.get(id) === next && packed.delete(id))
          hit = next
        }
        uploads[id] = await hit
      }
      const biggest = Object.values(uploads).reduce<PackedMesh | null>((a, b) => (!a || b.body.length > a.body.length ? b : a), null)
      if (biggest && biggest.body.length > access.maxUploadBytes)
        throw new Error(`A model on this plate is ${packedSize(biggest)}, over this account's cloud upload limit of ${sizeText(access.maxUploadBytes)}. Slice on this device instead.`)
      const request: CloudSliceRequest = {
        schemaVersion: 1,
        plate: { bed: req.plate.bed, objects: req.plate.objects.map(cloudObject) },
        config: req.config as unknown as Record<string, unknown>,
        options: cloudOptions(req.options),
      }
      const name = jobName(req.options)
      const sent = await opts.client.slicePlate({ name, meshes: uploads, request })
      // A size or daily limit the service enforced: say what to do, as the checks above do.
      if (!sent.ok && sent.code === 'limit') throw new Error(`${sent.message.replace(/[^.!?]$/, '$&.')} Slice on this device instead.`)
      const submitted = unwrap(sent)
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
      const data = await gcodeOf(sliceId)
      return {
        fileName: `${job.name.replace(/[^A-Za-z0-9 ._-]/g, '_')}.gcode`,
        bytes: data.length,
        sha256: job.result.gcodeSha256,
        blob: new Blob([data.slice().buffer], { type: 'text/x-gcode' }),
      }
    },

    async gcodeLineStarts(sliceId: string): Promise<Uint32Array> {
      return lineStarts(await gcodeOf(sliceId))
    },

    async gcodeBytes(sliceId: string, start: number, end: number): Promise<Uint8Array> {
      return (await gcodeOf(sliceId)).slice(start, end)
    },

    release(id: string) {
      // A cloud slice has nothing in the local slicer.
      texts.delete(id)
      if (jobs.delete(id)) return
      sources.delete(id)
      packed.delete(id)
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
/** The whole G-code of a slice, for a slicer that cannot read it a range at a time. */
async function gcodeText(slicer: SlicerHost, id: string): Promise<Uint8Array> {
  const out = await slicer.exportGcode(id, { kind: 'blob' })
  if (!out.blob) throw new Error('The slicer returned no G-code')
  return new Uint8Array(await out.blob.arrayBuffer())
}

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
    // The G-code line view reads a cloud slice's text from the cloud result; the local slicer has never seen its id.
    gcodeLineStarts: async (id) => {
      if (clouded.has(id) && cloud.gcodeLineStarts) return cloud.gcodeLineStarts(id)
      if (local.gcodeLineStarts) return local.gcodeLineStarts(id)
      return lineStarts(await gcodeText(local, id))
    },
    gcodeBytes: async (id, start, end) => {
      if (clouded.has(id) && cloud.gcodeBytes) return cloud.gcodeBytes(id, start, end)
      if (local.gcodeBytes) return local.gcodeBytes(id, start, end)
      return (await gcodeText(local, id)).slice(start, end)
    },
    // A .gcode.3mf of a cloud slice is made from its G-code by whoever packs it (the app, mimir), never by the local
    // slicer, which has no such slice; so only local slices reach the local packer.
    ...(local.exportGcode3mf
      ? { exportGcode3mf: (id: string, opts?: { plate?: number }) => (clouded.has(id) ? Promise.reject(new Error('A cloud slice is packed as .gcode.3mf from its G-code, not by this slicer')) : local.exportGcode3mf!(id, opts)) }
      : {}),
    release: (id) => {
      clouded.delete(id)
      cloud.release(id)
    },
  }
}
