// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The running-app MCP server against a stand-in for the app's bridge endpoint: the token on every call, tools forwarded
// with their arguments, errors in the @slicerx/mcp shape, the screenshot as an image, and opening a file waiting for
// the plate. The real endpoint's own rules are tested in Rust (apps/desktop/src-tauri/src/agent_bridge/http.rs).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'
import { appDataDir, connectionFiles, createAppBridgeServer, createAppClient, newestFile, readConnection, TOOL_NAMES } from '../src/index.ts'

const TOKEN = 'a'.repeat(64)
// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

interface Seen {
  tool: string
  args: Record<string, unknown>
  auth: string | undefined
  host: string | undefined
}

let server: Server | null = null
afterEach(() => {
  server?.close()
  server = null
})

/** A stand-in app: answers tools from `tools`, records every call, and checks the token like the real one. */
async function fakeApp(tools: Record<string, (args: Record<string, unknown>) => unknown>): Promise<{ file: string; seen: Seen[] }> {
  const seen: Seen[] = []
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { ok: false, error: { code: 'unauthorized', message: 'a valid bearer token is required' } })
      if (req.url === '/v1/health') return reply(200, { ok: true, result: { app: 'SlicerX', pageReady: true } })
      const { tool, args } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tool: string; args: Record<string, unknown> }
      seen.push({ tool, args, auth: req.headers.authorization, host: req.headers.host })
      const fn = tools[tool]
      if (!fn) return reply(404, { ok: false, error: { code: 'unknown_tool', message: `the bridge has no tool ${tool}` } })
      try {
        return reply(200, { ok: true, result: fn(args) })
      } catch (e) {
        return reply(403, { ok: false, error: { code: 'refused', message: (e as Error).message } })
      }
    })
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const port = (server!.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'sx-app-bridge-'))
  const file = join(dir, 'agent-bridge.json')
  writeFileSync(file, JSON.stringify({ port, token: TOKEN, pid: 4242, app: 'SlicerX', version: '0.2.2' }))
  return { file, seen }
}

async function connect(file: string): Promise<(name: string, args?: Record<string, unknown>) => Promise<CallToolResult>> {
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([createAppBridgeServer(createAppClient(file)).connect(a), client.connect(b)])
  return async (name, args = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult
}

const text = (r: CallToolResult) => (r.content[0] as { text: string }).text

describe('running-app MCP server', () => {
  it('lists the same tool set on every platform', async () => {
    const { file } = await fakeApp({})
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0' })
    await Promise.all([createAppBridgeServer(createAppClient(file)).connect(a), client.connect(b)])
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES])
    // Nothing that prints, sends to a printer or deletes.
    for (const t of tools) expect(t.name).not.toMatch(/print|send|delete|remove/)
    expect(tools.find((t) => t.name === 'app_state')?.annotations?.readOnlyHint).toBe(true)
  })

  it('forwards a tool with its arguments and the bearer token to the loopback endpoint', async () => {
    const { file, seen } = await fakeApp({ click: (a) => ({ clicked: a['testid'], matches: 1 }) })
    const call = await connect(file)
    const r = await call('app_click', { testid: 'vault-tab' })
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent).toEqual({ clicked: 'vault-tab', matches: 1 })
    expect(seen).toEqual([{ tool: 'click', args: { testid: 'vault-tab' }, auth: `Bearer ${TOKEN}`, host: expect.stringMatching(/^127\.0\.0\.1:\d+$/) }])
  })

  it('reports the app\'s refusals and a wrong token as errors', async () => {
    const { file } = await fakeApp({
      click: () => {
        throw new Error('The bridge does not use this control')
      },
    })
    const call = await connect(file)
    const refused = await call('app_click', { testid: 'danger-x' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toBe('Error: refused: The bridge does not use this control')
    writeFileSync(file, JSON.stringify({ ...readConnection(file), token: 'b'.repeat(64) }))
    const denied = await call('app_state')
    expect(denied.isError).toBe(true)
    expect(denied.structuredContent).toEqual({ error: { code: 'unauthorized', message: 'a valid bearer token is required' } })
  })

  it('says the app is not running when there is no connection file or nothing listens', async () => {
    const call = await connect(join(tmpdir(), 'sx-no-such-dir', 'agent-bridge.json'))
    const r = await call('app_state')
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/^Error: not_running: No running app/)
    const { file } = await fakeApp({})
    server!.close()
    await new Promise((r2) => setTimeout(r2, 50))
    const gone = await (await connect(file))('app_health')
    expect(text(gone)).toMatch(/^Error: not_running: Could not reach the app/)
  })

  it('refuses invalid arguments before calling the app', async () => {
    const { file, seen } = await fakeApp({})
    const call = await connect(file)
    const r = await call('app_click', { testid: 'bad id with spaces' })
    expect(r.isError).toBe(true)
    expect(seen).toEqual([])
  })

  it('returns the screenshot as an image and can save it', async () => {
    const { file } = await fakeApp({ screenshot: () => ({ mimeType: 'image/png', width: 1, height: 1, bytes: 70, data: PNG }) })
    const call = await connect(file)
    const out = join(mkdtempSync(join(tmpdir(), 'sx-shot-')), 'shot.png')
    const r = await call('app_screenshot', { path: out })
    expect(r.content[0]).toEqual({ type: 'image', data: PNG, mimeType: 'image/png' })
    expect(r.structuredContent).toMatchObject({ width: 1, height: 1, path: out })
    expect(readFileSync(out).subarray(1, 4).toString()).toBe('PNG')
    expect((await call('app_screenshot', { path: 'relative.png' })).isError).toBe(true)
  })

  it('opens a file and waits for it on the plate', async () => {
    let objects: { id: string }[] = []
    let calls = 0
    const { file, seen } = await fakeApp({
      state: () => {
        calls++
        // The object arrives on the second look after the file is handed over, still loading at first.
        return { tab: 'prepare', marker: 3, unsavedPrompt: null, plate: { loading: calls === 2, objects } }
      },
      toasts: () => ({ marker: 3, entries: [] }),
      open_file: (a) => {
        objects = [{ id: 'cube' }]
        return { handedOver: true, name: String(a['path']).split(/[\\/]/).pop() }
      },
    })
    const call = await connect(file)
    const r = await call('app_open_file', { path: 'C:\\models\\cube.sx3mf' })
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent).toMatchObject({ handed: { handedOver: true, name: 'cube.sx3mf' }, state: { plate: { loading: false, objects: [{ id: 'cube' }] } } })
    expect(seen.filter((s) => s.tool === 'open_file')).toHaveLength(1)
  })

  it('stops waiting on an error toast after the file is handed over', async () => {
    const { file } = await fakeApp({
      state: () => ({ tab: 'prepare', marker: 1, plate: { loading: false, objects: [] } }),
      toasts: (a) => ({ marker: 2, entries: a['since'] === 1 ? [{ text: 'Could not read broken.stl', tone: 'error' }] : [] }),
      open_file: () => ({ handedOver: true }),
    })
    const r = await (await connect(file))('app_open_file', { path: '/tmp/broken.stl', timeoutMs: 5000 })
    expect(text(r)).toBe('Error: open_failed: Could not read broken.stl')
  })
})

describe('connection file', () => {
  it('names the app data folder Tauri uses on each platform', () => {
    expect(appDataDir('app.slicerx.desktop', 'win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a')).toBe(join('C:\\Users\\a\\AppData\\Roaming', 'app.slicerx.desktop'))
    expect(appDataDir('app.slicerx.desktop', 'darwin', {}, '/Users/a')).toBe(join('/Users/a', 'Library', 'Application Support', 'app.slicerx.desktop'))
    expect(appDataDir('app.slicerx.desktop', 'linux', {}, '/home/a')).toBe(join('/home/a', '.local', 'share', 'app.slicerx.desktop'))
    expect(appDataDir('app.slicerx.desktop', 'linux', { XDG_DATA_HOME: '/data' }, '/home/a')).toBe(join('/data', 'app.slicerx.desktop'))
  })

  it('prefers an explicit file, then the environment, then the bridge build and the plain data folder', () => {
    expect(connectionFiles({ file: '/x.json' }, { SX_AGENT_BRIDGE_TOKEN_FILE: '/y.json' })).toEqual(['/x.json'])
    expect(connectionFiles({}, { SX_AGENT_BRIDGE_TOKEN_FILE: '/y.json' })).toEqual(['/y.json'])
    const share = join('/home/a', '.local', 'share')
    expect(connectionFiles({ identifier: 'com.example.slicer' }, {}, 'linux', '/home/a')).toEqual([join(share, 'com.example.slicer.agent-bridge', 'agent-bridge.json'), join(share, 'com.example.slicer', 'agent-bridge.json')])
    expect(connectionFiles({ identifier: 'com.example.slicer.agent-bridge' }, {}, 'linux', '/home/a')).toEqual([join(share, 'com.example.slicer.agent-bridge', 'agent-bridge.json')])
  })

  it('reads the connection file written last', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sx-newest-'))
    const [a, b] = [join(dir, 'a.json'), join(dir, 'b.json')]
    expect(newestFile([a, b])).toBe(a)
    writeFileSync(b, '{}')
    expect(newestFile([a, b])).toBe(b)
    await new Promise((r) => setTimeout(r, 30))
    writeFileSync(a, '{}')
    expect(newestFile([a, b])).toBe(a)
  })

  it('refuses a file without a port and a long token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sx-conn-'))
    const f = join(dir, 'c.json')
    writeFileSync(f, JSON.stringify({ port: 4000, token: 'short' }))
    expect(() => readConnection(f)).toThrow(/port and token/)
    writeFileSync(f, 'not json')
    expect(() => readConnection(f)).toThrow(/not the bridge/)
    writeFileSync(f, JSON.stringify({ port: 4000, token: TOKEN, pid: 1 }))
    expect(readConnection(f)).toEqual({ port: 4000, token: TOKEN, pid: 1 })
  })
})

describe('command line', () => {
  it('runs with plain node, which only strips types', () => {
    const out = execFileSync(process.execPath, [resolve(import.meta.dirname, '../src/cli.ts'), '--help'], { encoding: 'utf8' })
    expect(out).toMatch(/^slicerx-app-bridge /)
  })
})
