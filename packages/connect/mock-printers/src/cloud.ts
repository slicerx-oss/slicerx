// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A fake of the cloud delivery service that sx-link's inbox talks to: device registration, printer
// sync, a long polled delivery list, a download path and the delivery state machine.
import { createHash, randomBytes } from 'node:crypto'
import { MockError } from './machine.ts'
import { listen, type Handler } from './http-util.ts'

export const MOCK_CLOUD_TOKEN = 'sxk_mock_cloud_token'

// Allowed transitions, as the service enforces them (anything else is 409).
const NEXT: Record<string, string[]> = {
  offered: ['downloaded', 'declined', 'failed'],
  downloaded: ['awaiting_approval', 'declined', 'failed'],
  awaiting_approval: ['approved', 'declined', 'failed'],
  approved: ['uploaded', 'failed'],
  uploaded: ['printing', 'failed'],
  printing: [],
  declined: [],
  failed: [],
}

export interface OfferSpec {
  printerLocalId: string
  fileName: string
  content: Buffer
  /** Announced instead of the real values, to test the bridge's checks. */
  sha256?: string
  bytes?: number
  gcodePath?: string
}

interface Delivery { id: string; jobId: string; printerLocalId: string; state: string; message: string | null; fileName: string; sha256: string; bytes: number; gcodePath: string; content: Buffer; stats: { timeS: number; filamentG: number } }

export async function startCloud(log: string[]) {
  const deliveries: Delivery[] = []
  const devices: string[] = []
  const handler: Handler = async (req) => {
    if (req.headers.authorization !== `Bearer ${MOCK_CLOUD_TOKEN}`) return { status: 401, json: { error: 'unauthorized' } }
    const p = req.path
    if (p === '/v1/devices' && req.method === 'POST') {
      const body = req.json() as { name?: string; kind?: string }
      if (body.kind !== 'link') throw new MockError(400, 'kind')
      devices.push('dev-1')
      log.push('cloud device registered')
      return { status: 201, json: { id: 'dev-1', kind: 'link', name: body.name } }
    }
    const printers = /^\/v1\/devices\/([^/]+)\/printers$/.exec(p)
    if (printers && req.method === 'PUT') {
      const list = req.json() as unknown as { localId: string }[]
      log.push(`cloud printers ${list.map((x) => x.localId).sort().join(',')}`)
      return { json: list }
    }
    const poll = /^\/v1\/devices\/([^/]+)\/deliveries$/.exec(p)
    if (poll && req.method === 'GET') {
      // The real service holds the request up to `wait` seconds; the fake waits at most one.
      for (let i = 0; i < 10 && !deliveries.some((d) => d.state === 'offered'); i++) await new Promise((r) => setTimeout(r, 100))
      return { json: deliveries.map(({ content: _c, ...d }) => ({ ...d, printerId: 'p-1', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() })) }
    }
    const job = /^\/v1\/devices\/([^/]+)\/deliveries\/([^/]+)\/gcode$/.exec(p)
    if (job && req.method === 'GET') {
      const d = deliveries.find((x) => x.id === job[2])
      if (!d) throw new MockError(404, 'no delivery')
      return { body: d.content, type: 'application/octet-stream' }
    }
    const state = /^\/v1\/devices\/([^/]+)\/deliveries\/([^/]+)\/state$/.exec(p)
    if (state && req.method === 'POST') {
      const d = deliveries.find((x) => x.id === state[2])
      if (!d) throw new MockError(404, 'no delivery')
      const body = req.json() as { state?: string; message?: string }
      if (!body.state || !NEXT[d.state]?.includes(body.state)) throw new MockError(409, `${d.state} to ${String(body.state)}`)
      d.state = body.state
      d.message = body.message ?? null
      log.push(`cloud state ${d.fileName} ${d.state}${d.message ? ` (${d.message})` : ''}`)
      return { json: { id: d.id, state: d.state } }
    }
    throw new MockError(404, p)
  }
  const { server, port } = await listen(handler)
  const offer = (spec: OfferSpec): string => {
    const id = `del-${deliveries.length + 1}`
    const jobId = `job-${randomBytes(4).toString('hex')}`
    deliveries.push({
      id, jobId, printerLocalId: spec.printerLocalId, state: 'offered', message: null, fileName: spec.fileName,
      sha256: spec.sha256 ?? createHash('sha256').update(spec.content).digest('hex'),
      bytes: spec.bytes ?? spec.content.length, gcodePath: spec.gcodePath ?? `/v1/devices/dev-1/deliveries/${id}/gcode`, content: spec.content,
      stats: { timeS: 5400, filamentG: 21.5 },
    })
    return id
  }
  return { server, port, offer }
}
