// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Streamable HTTP transport with MCP sessions. Every request needs the bearer
// token, including on loopback, since any local process or local user can reach
// 127.0.0.1. Each session gets its own server instance, and with it its own
// pending approvals, so one client cannot list or approve another's requests.
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

export interface HttpOptions {
  host: string
  port: number
  /** Required on every request, loopback included. At least 32 characters. */
  token: string
  /** Sessions kept at once; the least recently used is closed past this. Default 16. */
  maxSessions?: number
  /** A session idle this long is closed. Default 1 hour. */
  idleMs?: number
  /** Extra Host header values to accept, for a reverse proxy. */
  allowedHosts?: string[]
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host)
}

function hostName(header: string): string {
  if (header.startsWith('[')) return header.slice(0, header.indexOf(']') + 1)
  return header.split(':')[0] ?? header
}

function reject(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

function originAllowed(origin: string, allowed: Set<string>): boolean {
  if (!URL.canParse(origin)) return false
  const host = new URL(origin).hostname
  return allowed.has(host) || allowed.has(`[${host}]`)
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '')
  const want = Buffer.from(token)
  return given.length === want.length && timingSafeEqual(given, want)
}

/**
 * Starts the HTTP server on `/mcp`. `makeServer` runs once per MCP session.
 * Host and Origin checks block DNS rebinding from web pages; the bearer token
 * keeps out every other caller.
 */
export async function startHttp(makeServer: () => McpServer, opts: HttpOptions): Promise<Server> {
  if (!opts.token || opts.token.length < 32) throw new Error('Refusing to serve HTTP without a bearer token of at least 32 characters.')
  const token = opts.token
  const allowedHosts = new Set([...LOOPBACK, ...(opts.allowedHosts ?? [])])
  const maxSessions = opts.maxSessions ?? 16
  const idleMs = opts.idleMs ?? 60 * 60 * 1000
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport; lastMs: number }>()

  const close = (id: string): void => {
    const s = sessions.get(id)
    if (!s) return
    sessions.delete(id)
    void s.transport.close()
    void s.server.close()
  }
  const sweep = (): void => {
    const now = Date.now()
    for (const [id, s] of sessions) if (now - s.lastMs > idleMs) close(id)
    while (sessions.size >= maxSessions) {
      const oldest = [...sessions.entries()].sort((x, y) => x[1].lastMs - y[1].lastMs)[0]
      if (!oldest) break
      close(oldest[0])
    }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/mcp') return reject(res, 404, 'Not found. The MCP endpoint is /mcp.')
    if (!allowedHosts.has(hostName(req.headers.host ?? ''))) return reject(res, 403, 'Host not allowed.')
    if (req.headers.origin !== undefined && !originAllowed(req.headers.origin, allowedHosts)) return reject(res, 403, 'Origin not allowed.')
    if (!tokenMatches(req.headers.authorization, token)) return reject(res, 401, 'Missing or wrong bearer token.')

    const header = req.headers['mcp-session-id']
    const sessionId = Array.isArray(header) ? header[0] : header
    if (sessionId !== undefined) {
      const s = sessions.get(sessionId)
      if (!s) return reject(res, 404, 'Unknown or expired session. Start a new one.')
      s.lastMs = Date.now()
      await s.transport.handleRequest(req, res)
      return
    }
    if (req.method !== 'POST') return reject(res, 400, 'Start a session with an initialize request.')

    // A request without a session id must be initialize; the transport refuses anything else.
    sweep()
    const server = makeServer()
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // JSON responses instead of SSE, since no tool streams.
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport, lastMs: Date.now() })
      },
    })
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId)
    }
    // The SDK declares optional callbacks without `| undefined`, which exactOptionalPropertyTypes rejects.
    await server.connect(transport as unknown as Transport)
    await transport.handleRequest(req, res)
    if (!transport.sessionId || !sessions.has(transport.sessionId)) {
      void transport.close()
      void server.close()
    }
  }

  const http = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) reject(res, 500, e instanceof Error ? e.message : 'Internal error')
    })
  })
  http.on('close', () => {
    for (const id of [...sessions.keys()]) close(id)
  })
  await new Promise<void>((resolve, rejectListen) => {
    http.once('error', rejectListen)
    http.listen(opts.port, opts.host, () => resolve())
  })
  return http
}
