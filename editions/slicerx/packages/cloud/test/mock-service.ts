// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A stand-in for the cloud service's slicing routes, in memory: access, mesh uploads, jobs that finish at once, and
// the finished G-code and preview. It records every call, upload and job request so tests can read them back.
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_VERSION } from '@slicerx/contracts'
import { sha256Hex } from '../src/hash'

export const MOCK_GCODE = '; sliced in the cloud\nG28\nG1 X10 Y10 Z0.2 E1\n'
const USER = '00000000-0000-4000-8000-0000000000a1'

export interface MockCloudService {
  fetch: typeof globalThis.fetch
  calls: { method: string; path: string }[]
  /** Uploaded meshes by SHA-256. */
  uploads: Map<string, Uint8Array>
  /** The `request` of each submitted job, in order. */
  requests: Record<string, unknown>[]
  /** What `GET /v1/access` answers; tests change it. */
  access: Record<string, unknown>
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
  const svc: MockCloudService = { fetch: undefined as never, calls, uploads, requests, access: { invited: true, jobsPerDay: 50, jobsToday: 0, maxUploadBytes: 25 * 1024 * 1024 } }
  const gcode = new TextEncoder().encode(MOCK_GCODE)
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
      const body = new Uint8Array(init.body as ArrayBuffer | Uint8Array)
      if ((await sha256Hex(body)) !== sha) return json(400, { error: { code: 'bad_request', message: 'the mesh does not match its hash' } })
      uploads.set(sha, body)
      return json(201, { sha256: sha, bytes: body.length })
    }
    if (method === 'POST' && path === '/v1/jobs') {
      const body = JSON.parse(String(init.body)) as { name?: string; request: Record<string, unknown> }
      requests.push(body.request)
      const id = `00000000-0000-4000-8000-${String(jobs.size + 1).padStart(12, '0')}`
      const job = {
        id,
        userId: USER,
        name: body.name ?? 'Cloud slice',
        status: 'succeeded',
        progress: 1,
        stage: null,
        request: body.request,
        targetPrinterId: null,
        result: {
          schemaVersion: 1,
          engine: 'sx',
          layerCount: 1,
          layerZ: [0.2],
          layerTimeS: [20],
          stats: { timeS: 20, filamentMm: [100], filamentG: [0.3], cost: 0, toolChanges: 0 },
          stageMicros: {},
          wallMs: 5,
          warnings: [],
          gcodeBytes: gcode.length,
          gcodeSha256: await sha256Hex(gcode),
          previewBytes: preview.length,
        },
        error: null,
        attempts: 1,
        createdAt: '2026-01-01T00:00:00Z',
        startedAt: '2026-01-01T00:00:00Z',
        finishedAt: '2026-01-01T00:00:01Z',
        gcodeUrl: `/v1/jobs/${id}/gcode`,
        previewUrl: `/v1/jobs/${id}/preview`,
      }
      jobs.set(id, job)
      return json(202, { ...job, status: 'queued', progress: 0, result: null, finishedAt: null })
    }
    const jobPath = /^\/v1\/jobs\/([0-9a-f-]{36})(\/gcode|\/preview)?$/.exec(path)
    const job = jobPath ? jobs.get(jobPath[1]!) : undefined
    if (jobPath && job) {
      if (jobPath[2] === '/gcode') return new Response(gcode, { status: 200 })
      if (jobPath[2] === '/preview') return new Response(preview, { status: 200 })
      return json(200, job)
    }
    return json(404, { error: { code: 'not_found', message: `${method} ${path}` } })
  }) as typeof globalThis.fetch
  return svc
}
