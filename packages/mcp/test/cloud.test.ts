// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloudFromEnv, type CloudOptions } from '../src/cloud'
import { connect, data, text } from './helpers'

afterEach(() => vi.restoreAllMocks())

describe('cloud slicing when no cloud is configured', () => {
  it('both tools say it is not configured and how to enable it, without any network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const h = await connect()
    const s = await h.call('slicerx_cloud_slice', { model: 'sample:cube-20' })
    expect(s.isError).toBe(true)
    expect(text(s)).toMatch(/Cloud slicing is not configured/)
    expect(text(s)).toMatch(/features\.cloudSlicing/)
    expect(text(s)).toMatch(/--cloud-api/)
    const j = await h.call('slicerx_cloud_jobs', {})
    expect(j.isError).toBe(true)
    expect(text(j)).toMatch(/Cloud slicing is not configured/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('validates requests before anything else', async () => {
    const h = await connect()
    for (const [tool, args] of [
      ['slicerx_cloud_slice', {}],
      ['slicerx_cloud_slice', { model: '' }],
      ['slicerx_cloud_slice', { model: 'sample:cube-20', name: 'x'.repeat(121) }],
      ['slicerx_cloud_slice', { model: 'sample:cube-20', profiles: Array(9).fill('a') }],
      ['slicerx_cloud_jobs', { job_id: '../../etc' }],
      ['slicerx_cloud_jobs', { limit: 0 }],
    ] as const) {
      const r = await h.call(tool, args)
      expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true)
      expect(text(r)).not.toMatch(/not configured/)
    }
  })
})

describe('cloud configuration', () => {
  it('is off unless a cloud API is named', () => {
    expect(cloudFromEnv({})).toBeUndefined()
    expect(cloudFromEnv({ SLICERX_CLOUD_API_URL: 'https://cloud.example.com/' })?.apiUrl).toBe('https://cloud.example.com')
    expect(cloudFromEnv({}, 'http://127.0.0.1:8787')?.apiUrl).toBe('http://127.0.0.1:8787')
    expect(() => cloudFromEnv({}, 'http://cloud.example.com')).toThrow(/https/)
    expect(cloudFromEnv({ SLICERX_MCP_CLOUD_API: 'https://a.example', SLICERX_MCP_CLOUD_TOKEN: 'sxk_1' })?.token).toBe('sxk_1')
  })

  it('reads a resolved edition config only when cloudSlicing is on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slicerx-cloud-'))
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify({ features: { cloudSlicing: false }, backend: { cloudApi: 'https://cloud.example.com' } }))
    expect(cloudFromEnv({ SLICERX_CONFIG: file })).toBeUndefined()
    writeFileSync(file, JSON.stringify({ features: { cloudSlicing: true }, backend: { cloudApi: 'https://cloud.example.com' } }))
    expect(cloudFromEnv({ SLICERX_CONFIG: file })?.apiUrl).toBe('https://cloud.example.com')
  })
})

describe('cloud slicing against the API contract', () => {
  type Override = (method: string, path: string) => Response | undefined
  function fakeCloud(
    access: Record<string, unknown> = { invited: true, jobsPerDay: 20, jobsToday: 3, maxUploadBytes: 25 * 1_048_576 },
    override?: Override,
  ): { cloud: CloudOptions; calls: { method: string; url: string; body: unknown; auth: string | null }[] } {
    const calls: { method: string; url: string; body: unknown; auth: string | null }[] = []
    const job = { id: 'job-1', name: 'cube.stl', status: 'queued', progress: 0, stage: null, result: null, error: null, createdAt: '2026-10-03T00:00:00Z', finishedAt: null }
    const fetch = (async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET'
      const auth = new Headers(init.headers).get('authorization')
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body instanceof Blob ? 'bytes' : undefined
      calls.push({ method, url, body, auth })
      const path = new URL(url).pathname
      const o = override?.(method, path)
      if (o) return o
      if (path === '/v1/access') return Response.json(access)
      if (method === 'GET' && path.startsWith('/v1/meshes/')) return new Response(null, { status: 404 })
      if (method === 'PUT') return new Response(null, { status: 201 })
      if (method === 'POST' && path === '/v1/jobs') return Response.json(job, { status: 201 })
      if (path === '/v1/jobs/job-1') return Response.json({ ...job, status: 'succeeded', progress: 1, result: { timeS: 600 }, gcodeUrl: '/v1/jobs/job-1/gcode', previewUrl: '/v1/jobs/job-1/preview' })
      if (path === '/v1/jobs/job-old') return Response.json({ ...job, id: 'job-old', status: 'succeeded', progress: 1 })
      if (path === '/v1/jobs') return Response.json([job])
      return Response.json({ error: { code: 'not_found', message: 'no such job' } }, { status: 404 })
    }) as typeof globalThis.fetch
    return { cloud: { apiUrl: 'https://cloud.example.com', token: 'sxk_test', fetch }, calls }
  }

  it('uploads the mesh by its hash, queues a job with no printer, and reads it back', async () => {
    const { cloud, calls } = fakeCloud()
    const h = await connect({ cloud })
    const r = await h.call('slicerx_cloud_slice', { model: join(h.dir, 'cube.stl'), overrides: { layer_height: 0.16 } })
    expect(r.isError, text(r)).toBeFalsy()
    const sha = createHash('sha256').update(readFileSync(join(h.dir, 'cube.stl'))).digest('hex')
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /v1/access', `GET /v1/meshes/${sha}`, `PUT /v1/meshes/${sha}`, 'POST /v1/jobs'])
    expect(calls.every((c) => c.auth === 'Bearer sxk_test')).toBe(true)
    const submitted = calls[3]?.body as { name: string; targetPrinterId?: string; request: { plate: { objects: { mesh: string }[] }; config: Record<string, unknown>; options: { engine: string } } }
    expect(submitted.targetPrinterId).toBeUndefined()
    expect(submitted.request.plate.objects[0]?.mesh).toBe(sha)
    expect(submitted.request.config['layer_height']).toBe(0.16)
    expect(data<{ output: { jobId: string } }>(r).output.jobId).toBe('job-1')

    const got = data<{ output: { status: string; links?: { gcode: string }; linksNote: string } }>(await h.call('slicerx_cloud_jobs', { job_id: 'job-1' })).output
    expect(got.status).toBe('succeeded')
    expect(got.links?.gcode).toBe('https://cloud.example.com/v1/jobs/job-1/gcode')
    expect(got.linksNote).toMatch(/expire 7 days/)
    const old = data<{ output: { links?: unknown; linksNote: string } }>(await h.call('slicerx_cloud_jobs', { job_id: 'job-old' })).output
    expect(old.links).toBeUndefined()
    expect(old.linksNote).toMatch(/expired/)
    const list = data<{ output: { jobs: unknown[] } }>(await h.call('slicerx_cloud_jobs', {})).output
    expect(list.jobs).toHaveLength(1)
    const missing = await h.call('slicerx_cloud_jobs', { job_id: 'nope' })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toMatch(/no such job/)
  })

  const err = (status: number, code: string, message: string, headers?: Record<string, string>): Response => Response.json({ error: { code, message } }, { status, ...(headers ? { headers } : {}) })
  const sliceWith = async (cloud: CloudOptions): Promise<string> => {
    const h = await connect({ cloud })
    const r = await h.call('slicerx_cloud_slice', { model: 'sample:cube-20' })
    expect(r.isError).toBe(true)
    return text(r)
  }

  it('checks access first: an uninvited account, a used up day and a large model stop before any upload', async () => {
    let f = fakeCloud({ invited: false })
    expect(await sliceWith(f.cloud)).toMatch(/not invited to cloud slicing/)
    expect(f.calls).toHaveLength(1)
    f = fakeCloud({ invited: true, jobsPerDay: 20, jobsToday: 20, maxUploadBytes: 1e9 })
    expect(await sliceWith(f.cloud)).toMatch(/used all 20 cloud jobs/)
    expect(f.calls).toHaveLength(1)
    f = fakeCloud({ invited: true, jobsPerDay: 20, jobsToday: 0, maxUploadBytes: 100 })
    expect(await sliceWith(f.cloud)).toMatch(/over this account's cloud upload limit/)
    expect(f.calls).toHaveLength(1)
  })

  // Five servers in a row: about 2 s alone on Windows, over 5 s beside other heavy work.
  it('maps not_invited, upload too large, the daily job limit and the rate limit to clear errors', async () => {
    expect(await sliceWith(fakeCloud(undefined, (m, p) => (p.startsWith('/v1/meshes/') ? err(403, 'not_invited', 'not invited') : undefined)).cloud)).toMatch(/not invited to cloud slicing/)
    expect(await sliceWith(fakeCloud(undefined, (m) => (m === 'PUT' ? err(413, 'limit', 'the mesh is over 25 MB') : undefined)).cloud)).toMatch(/larger than this account's cloud upload limit \(the mesh is over 25 MB\)/)
    expect(await sliceWith(fakeCloud(undefined, (m, p) => (m === 'POST' && p === '/v1/jobs' ? err(429, 'limit', '20 jobs a day') : undefined)).cloud)).toMatch(/reached its cloud job limit/)
    expect(await sliceWith(fakeCloud(undefined, (m, p) => (p === '/v1/access' ? err(429, 'limit', 'slow down', { 'retry-after': '12' }) : undefined)).cloud)).toMatch(/rate limiting this token; try again in 12 s/)
    expect(await sliceWith(fakeCloud(undefined, (_m, p) => (p === '/v1/access' ? err(403, 'forbidden', 'missing scope') : undefined)).cloud)).toMatch(/cloud_slice scope/)
  }, 30_000)

  it('follows the permission policy before sending anything', async () => {
    const { cloud, calls } = fakeCloud()
    const h = await connect({ cloud, policy: { classes: { slice: 'off', queue: 'off', start: 'off', profile: 'off' } } })
    const r = await h.call('slicerx_cloud_slice', { model: 'sample:cube-20' })
    expect(r.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })
})
