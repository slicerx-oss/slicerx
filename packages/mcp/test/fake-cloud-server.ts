// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A fake cloud slicing service over real HTTP on 127.0.0.1, for the MCP tests: the token rules of the real service
// (an unknown or revoked token is 401, a token without cloud_slice is 403, a partner app token sees only the jobs it
// queued and cannot name a printer) and jobs that finish at once. It records every request so a test can check that
// no token ever appears in a URL.
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeToken {
  user: string
  scopes: string[]
  partnerApp?: string
  revoked?: boolean
}

interface FakeJob {
  id: string
  user: string
  token: string
  name: string
  status: 'succeeded'
  request: unknown
}

export interface FakeCloudServer {
  url: string
  tokens: Map<string, FakeToken>
  /** Slices per rolling day for each account. */
  limits: Map<string, number>
  jobs: FakeJob[]
  /** Every request: method, path with query, and the Authorization header. */
  requests: { method: string; url: string; auth: string | undefined }[]
  close(): Promise<void>
}

export const FAKE_GCODE = '; sliced by the fake cloud\nG28\n'

const body = async (req: IncomingMessage): Promise<Buffer> => {
  const parts: Buffer[] = []
  for await (const c of req) parts.push(c as Buffer)
  return Buffer.concat(parts)
}

export async function startFakeCloud(): Promise<FakeCloudServer> {
  const tokens = new Map<string, FakeToken>()
  const limits = new Map<string, number>()
  const meshes = new Set<string>()
  const jobs: FakeJob[] = []
  const requests: FakeCloudServer['requests'] = []
  let seq = 0

  const server: Server = createServer((req, res) => {
    void (async () => {
      const send = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(value))
      }
      const fail = (status: number, code: string, message: string) => send(status, { error: { code, message } })
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const auth = req.headers.authorization
      requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', auth })
      const raw = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : ''
      const tok = tokens.get(raw)
      if (!tok || tok.revoked) return fail(401, 'unauthorized', 'a valid credential is required')
      if (!tok.scopes.includes('cloud_slice')) return fail(403, 'forbidden', 'this token does not have the cloud_slice scope')
      const perDay = limits.get(tok.user)
      const used = jobs.filter((j) => j.user === tok.user).length
      const sees = (j: FakeJob) => j.user === tok.user && (!tok.partnerApp || j.token === raw)
      const path = url.pathname
      const method = req.method ?? 'GET'

      if (method === 'GET' && path === '/v1/access') {
        const a = perDay === undefined ? { invited: false } : { invited: true, jobsPerDay: perDay, jobsToday: used, maxUploadBytes: 25 * 1_048_576 }
        return send(200, tok.partnerApp ? { ...a, partnerApp: tok.partnerApp } : a)
      }
      if (perDay === undefined) return fail(403, 'not_invited', 'cloud slicing is invite only, and this account is not on the list')
      const mesh = /^\/v1\/meshes\/([0-9a-f]{64})$/.exec(path)
      if (mesh) {
        const key = `${tok.user}/${mesh[1]}`
        if (method === 'GET') return meshes.has(key) ? send(200, { sha256: mesh[1] }) : fail(404, 'not_found', 'mesh not found')
        if (method === 'PUT') {
          await body(req)
          meshes.add(key)
          return send(201, { sha256: mesh[1] })
        }
      }
      if (method === 'POST' && path === '/v1/jobs') {
        const b = JSON.parse((await body(req)).toString('utf8')) as { name?: string; request: unknown; targetPrinterId?: string }
        if (tok.partnerApp && b.targetPrinterId) return fail(403, 'forbidden', 'a partner app token slices only; it cannot send a job to a printer')
        if (used >= perDay) return fail(429, 'limit', `this account has used its ${perDay} cloud slices for the last 24 hours`)
        seq += 1
        const job: FakeJob = { id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, user: tok.user, token: raw, name: b.name ?? 'Cloud slice', status: 'succeeded', request: b.request }
        jobs.push(job)
        return send(202, view(job))
      }
      if (method === 'GET' && path === '/v1/jobs') return send(200, jobs.filter(sees).reverse().map(view))
      const one = /^\/v1\/jobs\/([0-9a-f-]{36})(\/gcode)?$/.exec(path)
      if (method === 'GET' && one) {
        const job = jobs.find((j) => j.id === one[1] && sees(j))
        if (!job) return fail(404, 'not_found', 'job not found')
        if (one[2]) {
          res.writeHead(200, { 'content-type': 'text/x-gcode' })
          return res.end(FAKE_GCODE)
        }
        return send(200, view(job))
      }
      return fail(404, 'not_found', 'no such route')
    })()
  })
  const view = (j: FakeJob) => ({
    id: j.id,
    name: j.name,
    status: j.status,
    progress: 1,
    stage: 'done',
    result: { schemaVersion: 1, layerCount: 10, stats: { timeS: 60, filamentG: [1.5] }, gcodeSha256: createHash('sha256').update(FAKE_GCODE).digest('hex'), collisions: [] },
    error: null,
    createdAt: '2026-11-05T00:00:00Z',
    finishedAt: '2026-11-05T00:00:01Z',
    gcodeUrl: `/v1/jobs/${j.id}/gcode`,
    previewUrl: `/v1/jobs/${j.id}/preview`,
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    tokens,
    limits,
    jobs,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
