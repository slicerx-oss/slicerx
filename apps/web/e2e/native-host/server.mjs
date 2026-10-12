// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The browser suite's slicer: a small server on 127.0.0.1 that slices with the native `sx` (SX_CLI_BIN), the engine
// the desktop app links. playwright.config.ts starts it on a free port and builds the app against it
// (src/host/native-test.ts). Each page works under its own session: it uploads meshes in the raw parts format, then
// posts the desktop's slice request, and reads the G-code and the preview back.
//   node server.mjs --port <port> --origin <app origin>
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const port = Number(arg('--port'))
const origin = arg('--origin') ?? ''
const sx = process.env.SX_CLI_BIN ?? ''
if (!Number.isInteger(port) || port <= 0) throw new Error('native-host: --port is required')
if (!sx || !existsSync(sx)) throw new Error(`native-host: SX_CLI_BIN (${sx || 'unset'}) is not the sx binary; build it with cargo build --release -p sx-cli`)

const root = mkdtempSync(join(tmpdir(), 'sx-e2e-native-'))
/** Slices in flight, by session and job: the child process, so a cancel stops it. */
const running = new Map()
const safe = (s) => /^[A-Za-z0-9._-]{1,128}$/.test(s)

function read(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function run(args, key) {
  return new Promise((resolve) => {
    const child = spawn(sx, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    if (key) running.set(key, child)
    const out = []
    const err = []
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    child.on('close', (code, signal) => {
      if (key) running.delete(key)
      resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}

/** The engine's own message, without the CLI's prefix: the text the desktop shows for the same failure. */
const message = (stderr) => stderr.trim().split('\n').pop()?.replace(/^sx (slice|metadata): /, '') || 'the slice failed'

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/healthz') return send(res, 200, 'ok')
  const m = /^\/s\/([^/]+)\/(meshes|slices|metadata)(?:\/([^/]+))?(?:\/(gcode|preview))?$/.exec(url.pathname)
  if (!m || !safe(m[1]) || (m[3] && !safe(decodeURIComponent(m[3])))) return send(res, 404, 'not found')
  const [, session, kind, rawId, file] = m
  const id = rawId ? decodeURIComponent(rawId) : ''
  const dir = join(root, session)
  mkdirSync(dir, { recursive: true })
  if (kind === 'meshes' && req.method === 'PUT' && id) {
    writeFileSync(join(dir, `${id}.sxmp`), await read(req))
    return send(res, 204, '')
  }
  if (kind === 'metadata' && req.method === 'POST') {
    const name = url.searchParams.get('name') ?? 'project.3mf'
    const path = join(dir, `metadata-${Date.now()}${name.toLowerCase().endsWith('.3mf') ? '.3mf' : ''}`)
    writeFileSync(path, await read(req))
    const r = await run(['metadata', path])
    rmSync(path, { force: true })
    return r.code === 0 ? send(res, 200, r.stdout, 'application/json') : send(res, 422, message(r.stderr))
  }
  if (kind === 'slices' && id) {
    const out = join(dir, id)
    if (req.method === 'DELETE') {
      running.get(`${session}/${id}`)?.kill()
      rmSync(out, { recursive: true, force: true })
      return send(res, 204, '')
    }
    if (req.method === 'POST' && !file) {
      const body = JSON.parse((await read(req)).toString('utf8'))
      const ids = new Set(body.plate.objects.flatMap((o) => [o.mesh, ...(o.volumes ?? []).map((v) => v.mesh)]))
      body.meshes = Object.fromEntries([...ids].map((m) => [m, join(dir, `${m}.sxmp`)]))
      // the app sends a whole resolved profile, as the desktop does, so leave out the unused-key list the command line adds
      body.options = { ...body.options, configReport: false }
      mkdirSync(out, { recursive: true })
      const request = join(out, 'request.json')
      writeFileSync(request, JSON.stringify(body))
      // the app reports collisions itself, as the desktop does; the CLI would refuse the plate
      const r = await run(['slice', '--request', request, '--out-dir', out, '--allow-collisions'], `${session}/${id}`)
      if (r.signal) return send(res, 499, 'canceled')
      return r.code === 0 ? send(res, 200, r.stdout, 'application/json') : send(res, 422, message(r.stderr))
    }
    if (req.method === 'GET' && file) {
      const name = file === 'preview' ? 'slice.sxpv' : existsSync(join(out, 'slice.bgcode')) ? 'slice.bgcode' : 'slice.gcode'
      const path = join(out, name)
      return existsSync(path) ? send(res, 200, readFileSync(path), 'application/octet-stream') : send(res, 404, 'no such slice')
    }
  }
  return send(res, 405, 'not allowed')
}

function send(res, status, body, type = 'text/plain') {
  res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, PUT, DELETE', 'access-control-allow-headers': 'content-type' })
  res.end(body)
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '')
  handle(req, res).catch((e) => send(res, 500, e instanceof Error ? e.message : String(e)))
})
// loopback only: nothing else on the machine or the network can reach it
server.listen(port, '127.0.0.1', () => console.log(`native-host: sx ${sx} on 127.0.0.1:${port}`))
const stop = () => {
  for (const child of running.values()) child.kill()
  rmSync(root, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
