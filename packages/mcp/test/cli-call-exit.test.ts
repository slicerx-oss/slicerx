// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// `slicerx-mcp --printers link` run the way a client runs it: as its own process, against a hub on a loopback port.
// `call ...` has to print its result and exit by itself, 0 when every call worked and 1 when a call failed or the hub
// can't be reached. The stdio server has to answer what it read and exit when the client closes stdin. The open link
// to the hub used to keep the process running in both.
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/** How long the process may take to end after its last result line. A hang never ends, so the test fails here. */
const EXIT_WITHIN_MS = 10_000
/** The whole run, cold start included, before the test gives up and stops the process it started. */
const RUN_LIMIT_MS = 45_000
const PARTNER_KEY = `sxp_${'ab'.repeat(32)}`

/**
 * A stand-in for sx-link on a loopback port: it signs the hello the way the hub does, takes a partner key, and answers
 * the printer and plugin lists with none. Every other method gets an error. It answers a close frame with its own close, as
 * the real hub does, but never closes a connection first, so only the client can end one.
 */
async function startFakeHub(): Promise<{ port: number; hubKey: string; methods: string[]; open: () => number; stop: () => Promise<void> }> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const hubKey = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url').toString('base64')
  const methods: string[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((_, res) => res.writeHead(426).end())
  let port = 0
  server.on('upgrade', (req, sock: Socket) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => undefined)
    const accept = createHash('sha1').update(`${String(req.headers['sec-websocket-key'] ?? '')}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const send = (op: number, body: Buffer): boolean => sock.write(Buffer.concat([Buffer.from(body.length < 126 ? [0x80 | op, body.length] : [0x80 | op, 126, body.length >> 8, body.length & 255]), body]))
    const answer = (msg: { id: number; method: string; params?: Record<string, unknown> }): unknown => {
      if (msg.method === 'hello') {
        const clientNonce = Buffer.from(String(msg.params?.['nonce'] ?? ''), 'base64')
        const hubNonce = Buffer.alloc(32, 7)
        const signed = Buffer.concat([Buffer.from('sx-link hello v2\n'), clientNonce, hubNonce, Buffer.from([(port >> 8) & 255, port & 255])])
        return { hubKey, hubNonce: hubNonce.toString('base64'), port, sig: sign(null, signed, privateKey).toString('base64') }
      }
      if (msg.method === 'pair') return { paired: msg.params?.['clientKey'] === PARTNER_KEY, partner: true }
      if (msg.method === 'list' || msg.method === 'plugins') return []
      return undefined
    }
    let buf = Buffer.alloc(0)
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      for (;;) {
        if (buf.length < 2) return
        const op = buf[0]! & 0x0f
        let len = buf[1]! & 0x7f
        let at = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          at = 4
        }
        if (buf.length < at + 4 + len) return
        const mask = buf.subarray(at, at + 4)
        const body = Buffer.from(buf.subarray(at + 4, at + 4 + len)).map((b, i) => b ^ mask[i % 4]!)
        buf = buf.subarray(at + 4 + len)
        if (op === 8) {
          send(8, Buffer.from(body.subarray(0, 2)))
          sock.end()
          return
        }
        if (op !== 1) continue
        const msg = JSON.parse(Buffer.from(body).toString()) as { id: number; method: string; params?: Record<string, unknown> }
        methods.push(msg.method)
        const result = answer(msg)
        send(1, Buffer.from(JSON.stringify(result === undefined ? { id: msg.id, error: { code: 'not_found', message: `no ${msg.method} here` } } : { id: msg.id, result })))
      }
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  port = (server.address() as AddressInfo).port
  return {
    port,
    hubKey,
    methods,
    open: () => sockets.size,
    stop: async () => {
      for (const s of sockets) s.destroy()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

interface Run {
  code: number | null
  stdout: string
  stderr: string
  /** Milliseconds from the last result line (or the start, with none) to the exit; undefined when it never exited. */
  exitedAfterMs: number | undefined
}

/** The CLI's environment and arguments for a link run against the hub on `port`, then `extra` (such as `call ...`). */
function cliSetup(port: number, hubKey: string, dir: string, extra: string[]): { env: Record<string, string>; args: string[] } {
  const env: Record<string, string> = {}
  // Nothing from the caller's own setup (a hub port, a link code or key) reaches the run.
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('SLICERX_MCP_') && k !== 'SX_TEST_HUB_PORT') env[k] = v
  // A saved key goes only to a hub that proves the pinned key.
  env['SLICERX_MCP_LINK_KEY'] = PARTNER_KEY
  env['SLICERX_MCP_LINK_HUB_KEY'] = hubKey
  const args = ['--import', 'tsx', 'src/cli.ts', '--engine', 'stub', '--printers', 'link', '--link-url', `ws://127.0.0.1:${port}`, '--out-dir', join(dir, 'out'), '--profiles-dir', join(dir, 'profiles'), ...extra]
  return { env, args }
}

/** Runs the CLI as a client would, and stops it (by its own pid) when it outlives a bounded wait. */
function runCli(port: number, hubKey: string, dir: string, calls: string[]): Promise<Run> {
  const { env, args } = cliSetup(port, hubKey, dir, ['call', ...calls])
  const child = spawn(process.execPath, args, { cwd: resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let lastLine = Date.now()
  child.stdout.on('data', (d: Buffer) => {
    stdout += d.toString()
    lastLine = Date.now()
  })
  child.stderr.on('data', (d: Buffer) => void (stderr += d.toString()))
  return new Promise((done) => {
    const started = Date.now()
    const check = setInterval(() => {
      const now = Date.now()
      if ((stdout && now - lastLine > EXIT_WITHIN_MS) || now - started > RUN_LIMIT_MS) {
        clearInterval(check)
        child.kill()
        done({ code: null, stdout, stderr, exitedAfterMs: undefined })
      }
    }, 100)
    child.on('exit', (code) => {
      clearInterval(check)
      done({ code, stdout, stderr, exitedAfterMs: Date.now() - (stdout ? lastLine : started) })
    })
  })
}

/**
 * Runs the stdio server as a client would: once it has started (its first stderr line), writes `messages` to stdin as
 * JSON lines and closes stdin at once. Stops it (by its own pid) when it is still running a bounded wait after that.
 */
function runStdio(port: number, hubKey: string, dir: string, messages: object[]): Promise<Run> {
  const { env, args } = cliSetup(port, hubKey, dir, [])
  const child = spawn(process.execPath, args, { cwd: resolve(__dirname, '..'), env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let endedAt: number | undefined
  child.stdout.on('data', (d: Buffer) => void (stdout += d.toString()))
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString()
    if (endedAt === undefined && stderr.includes('\n')) {
      endedAt = Date.now()
      child.stdin.end(messages.map((m) => `${JSON.stringify(m)}\n`).join(''))
    }
  })
  return new Promise((done) => {
    const started = Date.now()
    const check = setInterval(() => {
      const now = Date.now()
      if ((endedAt !== undefined && now - endedAt > EXIT_WITHIN_MS) || now - started > RUN_LIMIT_MS) {
        clearInterval(check)
        child.kill()
        done({ code: null, stdout, stderr, exitedAfterMs: undefined })
      }
    }, 100)
    child.on('exit', (code) => {
      clearInterval(check)
      done({ code, stdout, stderr, exitedAfterMs: Date.now() - (endedAt ?? started) })
    })
  })
}

const lines = (out: string) => out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { tool: string; ok: boolean; text: string })

describe('slicerx-mcp --printers link call, as its own process', () => {
  let hub: Awaited<ReturnType<typeof startFakeHub>>
  const dir = mkdtempSync(join(tmpdir(), 'slicerx-mcp-call-exit-'))

  beforeAll(async () => {
    hub = await startFakeHub()
  })

  afterAll(async () => {
    await hub?.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('prints the result, closes the link and exits 0', async () => {
    const r = await runCli(hub.port, hub.hubKey, dir, ['printer_list'])
    expect(r.exitedAfterMs, `still running ${EXIT_WITHIN_MS} ms after its last line; stderr: ${r.stderr}`).toBeDefined()
    expect(r.code, `${r.stderr}${r.stdout}`).toBe(0)
    expect(lines(r.stdout)).toEqual([expect.objectContaining({ tool: 'slicerx_printer_list', ok: true })])
    // The answer came from the hub, and the hub saw the client go.
    expect(hub.methods).toContain('list')
    expect(hub.open()).toBe(0)
  }, 60_000)

  it('exits 1 when a call fails, after printing the failure', async () => {
    const r = await runCli(hub.port, hub.hubKey, dir, ['printer_status', '{"printerId":"bay-9"}', 'printer_list'])
    expect(r.exitedAfterMs, `still running ${EXIT_WITHIN_MS} ms after its last line; stderr: ${r.stderr}`).toBeDefined()
    expect(r.code, r.stderr).toBe(1)
    // It stops at the first failure: the list after it never runs.
    expect(lines(r.stdout)).toEqual([expect.objectContaining({ tool: 'slicerx_printer_status', ok: false })])
  }, 60_000)

  it('exits 1 and says so when no hub is listening', async () => {
    const gone = createServer()
    await new Promise<void>((done) => gone.listen(0, '127.0.0.1', done))
    const port = (gone.address() as AddressInfo).port
    await new Promise<void>((done) => gone.close(() => done()))
    const r = await runCli(port, hub.hubKey, dir, ['printer_list'])
    expect(r.exitedAfterMs, 'did not exit').toBeDefined()
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toMatch(/Cannot reach sx-link/)
  }, 60_000)
})

describe('slicerx-mcp --printers link as a stdio server, as its own process', () => {
  let hub: Awaited<ReturnType<typeof startFakeHub>>
  const dir = mkdtempSync(join(tmpdir(), 'slicerx-mcp-stdio-exit-'))

  beforeAll(async () => {
    hub = await startFakeHub()
  })

  afterAll(async () => {
    await hub?.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('exits when the client closes stdin, and closes the link', async () => {
    const r = await runStdio(hub.port, hub.hubKey, dir, [])
    expect(r.exitedAfterMs, `still running ${EXIT_WITHIN_MS} ms after stdin closed; stderr: ${r.stderr}`).toBeDefined()
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toBe('')
    expect(hub.open()).toBe(0)
  }, 60_000)

  it('answers the requests it read before stdin closed, then exits', async () => {
    const before = hub.methods.length
    const r = await runStdio(hub.port, hub.hubKey, dir, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'exit-test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slicerx_printer_list', arguments: {} } },
    ])
    expect(r.exitedAfterMs, `still running ${EXIT_WITHIN_MS} ms after stdin closed; stderr: ${r.stderr}`).toBeDefined()
    expect(r.code, r.stderr).toBe(0)
    const replies = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: number; result?: { isError?: boolean } })
    expect(replies.map((m) => m.id)).toEqual([1, 2])
    expect(replies[1]?.result?.isError).not.toBe(true)
    // The printer list came from the hub, and the hub saw the client go.
    expect(hub.methods.slice(before)).toContain('list')
    expect(hub.open()).toBe(0)
  }, 60_000)
})
