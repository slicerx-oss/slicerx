// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { createCloudClient } from '../src/client'
import { sha256Hex } from '../src/hash'
import { memoryStore } from '../src/kv'
import { createJobOutbox } from '../src/outbox'

type Handler = (method: string, path: string, init: RequestInit) => Response | Promise<Response>

function fakeFetch(handler: Handler) {
  const calls: { method: string; path: string; auth: string | null }[] = []
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    calls.push({ method, path: url.pathname + url.search, auth: headers.get('authorization') })
    return handler(method, url.pathname + url.search, init)
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const ID = '00000000-0000-4000-8000-000000000001'
const USER = '00000000-0000-4000-8000-0000000000a1'

function job(extra: Record<string, unknown> = {}) {
  return {
    id: ID,
    userId: USER,
    name: 'Cube',
    status: 'queued',
    progress: 0,
    stage: null,
    request: {},
    targetPrinterId: null,
    result: null,
    error: null,
    attempts: 0,
    createdAt: '2026-01-01T00:00:00Z',
    startedAt: null,
    finishedAt: null,
    ...extra,
  }
}

describe('cloud client', () => {
  it('sends the credential and maps service errors to codes', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(429, { error: { code: 'limit', message: 'five jobs are already queued or running' } }),
    )
    const c = createCloudClient({ baseUrl: 'http://cloud.test/', credential: () => 'sxk_abc', fetch })
    const r = await c.submitJob({ request: { plate: { objects: [] } } })
    expect(r).toEqual({ ok: false, code: 'limit', message: 'five jobs are already queued or running' })
    expect(calls[0]).toEqual({ method: 'POST', path: '/v1/jobs', auth: 'Bearer sxk_abc' })
  })

  it('reports whether the account is invited and passes not_invited through', async () => {
    let invited = false
    const { fetch } = fakeFetch((_method, path) => {
      if (path === '/v1/access') {
        return json(200, invited ? { invited: true, jobsPerDay: 20, jobsToday: 3, maxUploadBytes: 26214400 } : { invited: false })
      }
      return json(403, { error: { code: 'not_invited', message: 'cloud slicing is invite only, and this account is not on the list' } })
    })
    const c = createCloudClient({ baseUrl: 'http://cloud.test', credential: () => 't', fetch })
    expect(await c.access()).toEqual({ ok: true, value: { invited: false } })
    const r = await c.jobs()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_invited')
    invited = true
    expect(await c.access()).toEqual({ ok: true, value: { invited: true, jobsPerDay: 20, jobsToday: 3, maxUploadBytes: 26214400 } })
  })

  it('reports offline instead of throwing when the network is down', async () => {
    const fetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof globalThis.fetch
    const c = createCloudClient({ baseUrl: 'http://cloud.test', credential: () => 'sxk_abc', fetch })
    const r = await c.jobs()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('offline')
  })

  it('asks for sign-in without calling the service when there is no credential', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, []))
    const c = createCloudClient({ baseUrl: 'http://cloud.test', credential: () => null, fetch })
    const r = await c.jobs()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('unauthorized')
    expect(calls).toHaveLength(0)
  })

  it('rejects a response that does not match the schema', async () => {
    const { fetch } = fakeFetch(() => json(200, { id: 'not a uuid' }))
    const c = createCloudClient({ baseUrl: 'http://cloud.test', credential: () => 't', fetch })
    const r = await c.job(ID)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid_response')
  })

  it('uploads a mesh only when the service does not have it', async () => {
    const mesh = new TextEncoder().encode('solid cube')
    const sha = await sha256Hex(mesh)
    let stored = false
    const { fetch, calls } = fakeFetch((method, path) => {
      if (method === 'GET') return stored ? json(200, { sha256: sha }) : json(404, { error: { code: 'not_found', message: 'mesh not found' } })
      stored = true
      expect(path).toBe(`/v1/meshes/${sha}`)
      return json(201, { sha256: sha, bytes: mesh.length })
    })
    const c = createCloudClient({ baseUrl: 'http://cloud.test', credential: () => 't', fetch })
    expect(await c.uploadMesh(mesh)).toEqual({ ok: true, value: sha })
    expect(await c.uploadMesh(mesh)).toEqual({ ok: true, value: sha })
    expect(calls.map((x) => x.method)).toEqual(['GET', 'PUT', 'GET'])
  })

  it('refuses a G-code download that does not match the reported hash', async () => {
    const gcode = new TextEncoder().encode('G28\n')
    const result = {
      schemaVersion: 1,
      engine: 'sx',
      layerCount: 1,
      layerZ: [0.2],
      layerTimeS: [1],
      stats: { timeS: 1, filamentMm: [1], filamentG: [0.1], cost: 0, toolChanges: 0 },
      stageMicros: {},
      wallMs: 1,
      warnings: [],
      gcodeBytes: 4,
      gcodeSha256: '0'.repeat(64),
      previewBytes: 0,
    }
    const { fetch } = fakeFetch(() => new Response(gcode))
    const c = createCloudClient({ baseUrl: 'http://cloud.test', credential: () => 't', fetch })
    const done = job({ status: 'succeeded', progress: 1, result })
    const r = await c.downloadGcode(done as never)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('hash_mismatch')
  })
})

describe('job outbox', () => {
  it('queues plates while offline and sends them in order later', async () => {
    let online = false
    const submitted: string[] = []
    const { fetch } = fakeFetch((method, path, init) => {
      if (!online) throw new TypeError('fetch failed')
      if (method === 'GET' && path.startsWith('/v1/meshes/')) return json(200, { sha256: path.slice(11) })
      const body = JSON.parse(String(init.body)) as { name: string }
      submitted.push(body.name)
      return json(202, job({ name: body.name }))
    })
    const client = createCloudClient({ baseUrl: 'http://cloud.test', credential: () => 't', fetch })
    const store = memoryStore()
    const outbox = createJobOutbox({ client, store, now: () => new Date('2026-01-01T00:00:00Z') })
    const plate = (name: string) => ({
      name,
      meshes: { m: new Uint8Array([1, 2, 3]) },
      request: { plate: { objects: [{ id: 'o', mesh: 'm' }] } },
    })
    expect((await outbox.submit(plate('First'))).kind).toBe('queued')
    online = true
    // A later plate queues behind the waiting one instead of jumping ahead.
    expect((await outbox.submit(plate('Second'))).kind).toBe('queued')
    const report = await outbox.flush()
    expect(report.sent).toHaveLength(2)
    expect(submitted).toEqual(['First', 'Second'])
    expect(await outbox.entries()).toEqual([])
  })

  it('keeps a refused plate for the user and does not retry it', async () => {
    const { fetch } = fakeFetch((method) =>
      method === 'GET'
        ? json(200, { sha256: '0'.repeat(64) })
        : json(400, { error: { code: 'bad_request', message: 'the plate has no objects' } }),
    )
    const client = createCloudClient({ baseUrl: 'http://cloud.test', credential: () => 't', fetch })
    const outbox = createJobOutbox({ client, store: memoryStore() })
    const r = await outbox.submit({ meshes: {}, request: { plate: { objects: [] } } })
    expect(r.kind).toBe('refused')
    expect(await outbox.entries()).toEqual([])
  })
})
