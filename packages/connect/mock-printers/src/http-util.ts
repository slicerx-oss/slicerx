// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { MockError } from './machine.ts'

export interface Req {
  method: string
  path: string
  query: URLSearchParams
  headers: IncomingMessage['headers']
  body: Buffer
  json(): unknown
  form(): Promise<FormData>
}

export interface Reply {
  status?: number
  json?: unknown
  body?: Buffer | string
  type?: string
  headers?: Record<string, string>
  /** Keeps the response open. `start` writes chunks and returns a function that stops it. */
  stream?: { type: string; start(write: (b: Buffer) => void): () => void }
}

/** A multipart MJPEG stream of one frame, repeated: what ustreamer and mjpg-streamer send. `frame` may be a
 * function, asked for each frame, so the picture follows `POST /camera`. */
export function mjpeg(frame: Buffer | (() => Buffer), everyMs = 100): NonNullable<Reply['stream']> {
  const pic = typeof frame === 'function' ? frame : () => frame
  return {
    type: 'multipart/x-mixed-replace;boundary=frame',
    start(write) {
      const send = () => {
        const f = pic()
        write(Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`), f, Buffer.from('\r\n')]))
      }
      send()
      const t = setInterval(send, everyMs)
      return () => clearInterval(t)
    },
  }
}

export type Handler = (req: Req) => Reply | Promise<Reply>

export async function listen(handler: Handler): Promise<{ server: Server; port: number }> {
  const server = createServer(async (rq: IncomingMessage, rs: ServerResponse) => {
    // A connection the offline gate closed has no request left to answer.
    if (rq.socket.destroyed) return
    const chunks: Buffer[] = []
    try {
      for await (const c of rq) chunks.push(c as Buffer)
    } catch {
      return
    }
    const body = Buffer.concat(chunks)
    const url = new URL(rq.url ?? '/', 'http://mock')
    const req: Req = {
      method: rq.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: rq.headers,
      body,
      json: () => JSON.parse(body.toString('utf8') || '{}') as unknown,
      form: () => new Response(body, { headers: { 'content-type': String(rq.headers['content-type'] ?? '') } }).formData(),
    }
    try {
      const r = await handler(req)
      const status = r.status ?? 200
      if (r.stream) {
        rs.writeHead(status, { 'content-type': r.stream.type, ...r.headers })
        const stop = r.stream.start((b) => void rs.write(b))
        rs.on('close', stop)
        return
      }
      if (r.json !== undefined) {
        rs.writeHead(status, { 'content-type': 'application/json', ...r.headers })
        rs.end(JSON.stringify(r.json))
      } else {
        rs.writeHead(status, { ...(r.type ? { 'content-type': r.type } : {}), ...r.headers })
        rs.end(r.body ?? '')
      }
    } catch (e) {
      const status = e instanceof MockError ? e.status : 500
      rs.writeHead(status, { 'content-type': 'application/json' })
      rs.end(JSON.stringify({ error: e instanceof Error ? e.message : 'error' }))
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as AddressInfo).port }
}

/** Reads the `file` part of a multipart upload. */
export async function readFilePart(req: Req): Promise<{ name: string; data: Uint8Array }> {
  const form = await req.form()
  const f = form.get('file')
  if (!(f instanceof File)) throw new MockError(400, 'no file part')
  return { name: f.name, data: new Uint8Array(await f.arrayBuffer()) }
}

/**
 * A printer that has dropped off the network, for the offline fault: while `blocked()` holds, a new TCP connection
 * is reset as soon as it opens and a request on an open one closes its connection. The port stays bound, so the
 * printer comes back on the same port when the fault clears. `dropAll` closes every open connection at once.
 */
export function offlineGate(server: Server, blocked: () => boolean): { dropAll(): void } {
  const open = new Set<Socket>()
  const kill = (s: Socket) => { if (typeof s.resetAndDestroy === 'function') s.resetAndDestroy(); else s.destroy() }
  server.on('connection', (s: Socket) => {
    if (blocked()) return kill(s)
    open.add(s)
    s.on('close', () => open.delete(s))
  })
  server.prependListener('request', (rq: IncomingMessage) => { if (blocked()) kill(rq.socket) })
  return { dropAll: () => { for (const s of open) kill(s) } }
}
