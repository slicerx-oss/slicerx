// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A stand-in for the cloud service's slicing routes, in memory: access, mesh uploads, jobs that finish at once, and
// the finished G-code and preview. It records every call, upload and job request so tests can read them back.
import { gunzipSync } from 'node:zlib'
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_VERSION } from '@slicerx/contracts'
import { sha256Hex } from '../src/hash'

export const MOCK_GCODE = '; sliced in the cloud\nG28\nG1 X10 Y10 Z0.2 E1\n'

/** The G-code the stand-in gives plate `plate` of a job that names its plates. */
export function mockPlateGcode(plate: number): string {
  return `; sliced in the cloud, plate ${plate}\nG28\nG1 X${10 * plate} Y10 Z0.2 E1\n`
}
const USER = '00000000-0000-4000-8000-0000000000a1'

export interface MockCloudService {
  fetch: typeof globalThis.fetch
  calls: { method: string; path: string }[]
  /** Uploaded meshes by SHA-256, inflated. */
  uploads: Map<string, Uint8Array>
  /** Each upload as sent: its size on the wire and its Content-Encoding. */
  sent: { sha256: string; bytes: number; encoding: string | null }[]
  /** When set, what a mesh upload is answered with instead of storing it. */
  refuseUpload?: () => Response
  /** The `request` of each submitted job, in order. */
  requests: Record<string, unknown>[]
  /** The name of each submitted job, in order. */
  names: string[]
  /** What `GET /v1/access` answers; tests change it. */
  access: Record<string, unknown>
  /** The warnings a job's result carries; tests change it. */
  warnings: Record<string, unknown>[]
  /** Plates of a job that names its plates that fail, with the engine's words; tests change it. */
  failPlates: Map<number, string>
  /** Fields a report carries beyond the usual ones, by plate (null for a job that names no plates); tests set it. */
  extra?: (plate: number | null) => Record<string, unknown>
}

/** A preview of one layer, 0.2 mm, with no toolpaths: enough for the app to show a finished slice. */
function onePreview(): Uint8Array<ArrayBuffer> {
  const raw = new ArrayBuffer(SXPV_HEADER_BYTES + 2 * 4 + 8)
  const dv = new DataView(raw)
  dv.setUint32(0, SXPV_MAGIC, true)
  dv.setUint16(4, SXPV_VERSION, true)
  dv.setUint32(12, 1, true)
  dv.setUint32(20, 1, true)
  dv.setFloat32(24, 0.2, true)
  dv.setFloat32(SXPV_HEADER_BYTES + 8, 0.2, true)
  dv.setFloat32(SXPV_HEADER_BYTES + 12, 20, true)
  return new Uint8Array(raw)
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export function mockCloudService(): MockCloudService {
  const calls: MockCloudService['calls'] = []
  const uploads = new Map<string, Uint8Array>()
  const requests: Record<string, unknown>[] = []
  const jobs = new Map<string, Record<string, unknown>>()
  const names: string[] = []
  const sent: MockCloudService['sent'] = []
  const svc: MockCloudService = { fetch: undefined as never, calls, uploads, sent, requests, names, access: { invited: true, jobsPerDay: 50, jobsToday: 0, maxUploadBytes: 25 * 1024 * 1024 }, warnings: [], failPlates: new Map() }
  const enc = new TextEncoder()
  const gcode = enc.encode(MOCK_GCODE)
  const preview = onePreview()
  svc.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    const path = url.pathname
    calls.push({ method, path })
    if (method === 'GET' && path === '/v1/access') return json(200, svc.access)
    const mesh = /^\/v1\/meshes\/([0-9a-f]{64})$/.exec(path)
    if (mesh) {
      const sha = mesh[1]!
      if (method === 'GET') return uploads.has(sha) ? json(200, { sha256: sha }) : json(404, { error: { code: 'not_found', message: 'no such mesh' } })
      if (svc.refuseUpload) return svc.refuseUpload()
      const wire = init.body instanceof Blob ? new Uint8Array(await init.body.arrayBuffer()) : new Uint8Array(init.body as ArrayBuffer | Uint8Array)
      const encoding = new Headers(init.headers).get('content-encoding')
      sent.push({ sha256: sha, bytes: wire.length, encoding })
      const body = encoding === 'gzip' ? new Uint8Array(gunzipSync(wire)) : wire
      if ((await sha256Hex(body)) !== sha) return json(400, { error: { code: 'bad_request', message: 'the mesh does not match its hash' } })
      uploads.set(sha, body)
      return json(201, { sha256: sha, bytes: body.length })
    }
    if (method === 'POST' && path === '/v1/jobs') {
      const body = JSON.parse(String(init.body)) as { name?: string; request: Record<string, unknown> }
      requests.push(body.request)
      names.push(body.name ?? '')
      const id = `00000000-0000-4000-8000-${String(jobs.size + 1).padStart(12, '0')}`
      const report = async (text: Uint8Array, timeS: number, plate: number | null) => ({
        schemaVersion: 1,
        engine: 'sx',
        layerCount: 1,
        layerZ: [0.2],
        layerTimeS: [timeS],
        stats: { timeS, filamentMm: [100], filamentG: [0.3], cost: 0, toolChanges: 0 },
        stageMicros: {},
        wallMs: 5,
        warnings: svc.warnings,
        gcodeBytes: text.length,
        gcodeSha256: await sha256Hex(text),
        previewBytes: preview.length,
        ...svc.extra?.(plate),
      })
      // A job that names its plates: one report per plate, the first that sliced as the job's own.
      const named = (body.request['options'] as { plates?: number[] } | undefined)?.plates
      const plates: Record<string, unknown>[] | undefined = named
        ? await Promise.all(
            named.map(async (n) => {
              const error = svc.failPlates.get(n)
              return error ? { plate: n, status: 'failed', error } : { plate: n, status: 'succeeded', ...(await report(enc.encode(mockPlateGcode(n)), 20 * n, n)) }
            }),
          )
        : undefined
      const first = plates?.find((p) => p['status'] === 'succeeded')
      const times = { createdAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z' }
      if (plates && !first) {
        const error = `plate ${String(plates[0]!['plate'])}: ${String(plates[0]!['error'])}`
        const failed = { id, userId: USER, name: body.name ?? 'Cloud slice', status: 'failed', progress: 1, stage: null, request: body.request, targetPrinterId: null, result: null, error, attempts: 1, ...times, plateCount: plates.length }
        jobs.set(id, failed)
        return json(202, { ...failed, status: 'queued', progress: 0, error: null, finishedAt: null })
      }
      const own = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'plate' && k !== 'status'))
      const job = {
        id,
        userId: USER,
        name: body.name ?? 'Cloud slice',
        status: 'succeeded',
        progress: 1,
        stage: null,
        request: body.request,
        targetPrinterId: null,
        result: first ? { ...own(first), plates } : await report(gcode, 20, null),
        error: null,
        attempts: 1,
        createdAt: '2026-01-01T00:00:00Z',
        startedAt: '2026-01-01T00:00:00Z',
        finishedAt: '2026-01-01T00:00:01Z',
        gcodeUrl: `/v1/jobs/${id}/gcode`,
        previewUrl: `/v1/jobs/${id}/preview`,
        plateCount: plates?.length ?? 1,
        ...(plates
          ? {
              plates: plates
                .filter((p) => p['status'] === 'succeeded')
                .map((p) => ({ plate: p['plate'], gcodeUrl: `/v1/jobs/${id}/plates/${String(p['plate'])}/gcode`, previewUrl: `/v1/jobs/${id}/plates/${String(p['plate'])}/preview` })),
            }
          : {}),
      }
      jobs.set(id, job)
      return json(202, { ...job, status: 'queued', progress: 0, result: null, finishedAt: null })
    }
    const platePath = /^\/v1\/jobs\/([0-9a-f-]{36})\/plates\/(\d+)\/(gcode|preview)$/.exec(path)
    const plateJob = platePath ? jobs.get(platePath[1]!) : undefined
    if (platePath && plateJob) {
      const n = Number(platePath[2])
      const sliced = (plateJob['plates'] as { plate: number }[] | undefined)?.some((p) => p.plate === n)
      if (!sliced) return json(404, { error: { code: 'not_found', message: 'result not found' } })
      return new Response(platePath[3] === 'gcode' ? enc.encode(mockPlateGcode(n)) : preview, { status: 200 })
    }
    const jobPath = /^\/v1\/jobs\/([0-9a-f-]{36})(\/gcode|\/preview)?$/.exec(path)
    const job = jobPath ? jobs.get(jobPath[1]!) : undefined
    if (jobPath && job) {
      if (jobPath[2] === '/gcode') return new Response(gcode, { status: 200 })
      if (jobPath[2] === '/preview') return new Response(preview, { status: 200 })
      return json(200, job)
    }
    if (method === 'GET' && path === '/v1/jobs') return json(200, [...jobs.values()].reverse())
    return json(404, { error: { code: 'not_found', message: `${method} ${path}` } })
  }) as typeof globalThis.fetch
  return svc
}
