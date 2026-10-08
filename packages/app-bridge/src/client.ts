// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Calls the running app's bridge endpoint: POST /v1/call on 127.0.0.1 with the bearer token. The connection file is
// read again for every call, so a restarted app (new port, new token) is picked up without restarting this server.
// node:http, not fetch: a slice may take many minutes, longer than fetch waits for response headers.
import { request } from 'node:http'
import { newestFile, readConnection, type Connection } from './connection.ts'

// Plain fields, not parameter properties: Node runs this file by stripping types only.
export class BridgeCallError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 0) {
    super(message)
    this.code = code
    this.status = status
  }
}

export interface AppClient {
  call(tool: string, args?: Record<string, unknown>): Promise<unknown>
  health(): Promise<unknown>
  connection(): Connection
}

function send(conn: Connection, method: 'GET' | 'POST', path: string, body: string | null, timeoutMs: number): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: conn.port,
        method,
        path,
        headers: { authorization: `Bearer ${conn.token}`, ...(body !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) })
          } catch {
            reject(new BridgeCallError('bad_response', `The app answered ${res.statusCode} with something that is not JSON.`, res.statusCode ?? 0))
          }
        })
        res.on('error', reject)
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new BridgeCallError('timeout', `No answer from the app in ${Math.round(timeoutMs / 1000)} s.`)))
    req.on('error', (e) => reject(e instanceof BridgeCallError ? e : new BridgeCallError('not_running', `Could not reach the app on 127.0.0.1:${conn.port} (${e.message}). Is it still running?`)))
    if (body !== null) req.write(body)
    req.end()
  })
}

function unwrap(r: { status: number; json: unknown }): unknown {
  const j = r.json as { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } }
  if (j.ok === true) return j.result
  throw new BridgeCallError(j.error?.code ?? 'error', j.error?.message ?? `The app answered ${r.status}.`, r.status)
}

/** A client for the app whose connection file is `files` (or, of several places, the one written last). */
export function createAppClient(files: string | readonly string[]): AppClient {
  const conn = () => readConnection(newestFile(typeof files === 'string' ? [files] : files))
  return {
    connection: conn,
    async call(tool, args = {}) {
      // The app gives a call its own timeoutMs (30 s by default) and five seconds more; this waits a little longer still.
      const own = typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : 30_000
      return unwrap(await send(conn(), 'POST', '/v1/call', JSON.stringify({ tool, args }), Math.min(own, 900_000) + 15_000))
    },
    async health() {
      return unwrap(await send(conn(), 'GET', '/v1/health', null, 10_000))
    },
  }
}
