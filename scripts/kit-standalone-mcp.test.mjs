// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The kit's self-contained MCP server, the way an app ships it: slicerx-mcp-standalone.zip unpacked on its own into a
// folder with no node_modules anywhere above it and started with plain node over stdio. It lists its tools, answers a
// knowledge tool (which loads the YAML parser and parses the knowledge base on first use), and without the optional
// STEP reader refuses slicerx_step_read with not_supported.
//   node --test scripts/kit-standalone-mcp.test.mjs (pnpm test:kit-standalone)
// Builds the server with the pack's own step by default; SX_KIT_DIR selects a kit packed already, whose
// kit-manifest.json and SHA256SUMS.txt are checked too.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import * as pack from './pack-integrator-kit.mjs'

const repo = resolve(import.meta.dirname, '..')
const version = JSON.parse(readFileSync(join(repo, 'packages', 'mcp', 'package.json'), 'utf8')).version
const work = mkdtempSync(join(tmpdir(), 'sx-kit-standalone-'))
const kit = process.env.SX_KIT_DIR ? resolve(process.env.SX_KIT_DIR) : join(work, 'kit')
const NAME = 'slicerx-mcp-standalone'
let entry

/** Every path under `dir`, relative with `/`, folders ending in `/`. */
const tree = (dir, prefix = '') => readdirSync(dir).flatMap((n) =>
  statSync(join(dir, n)).isDirectory() ? [`${prefix}${n}/`, ...tree(join(dir, n), `${prefix}${n}/`)] : [`${prefix}${n}`])

before(() => {
  assert.equal(typeof pack.writeStandalone, 'function', 'the kit pack has a step that writes the self-contained MCP server')
  if (!process.env.SX_KIT_DIR) {
    mkdirSync(kit, { recursive: true })
    pack.writeStandalone(kit)
  }
  // An empty folder in the system temp folder, with no node_modules in it or in any folder above it.
  const app = realpathSync(mkdtempSync(join(work, 'app-')))
  for (let d = app; ; d = dirname(d)) {
    assert.ok(!existsSync(join(d, 'node_modules')), `${d} has a node_modules folder`)
    if (dirname(d) === d) break
  }
  // unpack with the system's tools, as an integrator would: bsdtar reads zips, GNU tar does not
  const zip = join(kit, `${NAME}.zip`)
  try {
    execFileSync('tar', ['-xf', zip, '-C', app], { stdio: 'ignore' })
  } catch {
    execFileSync('unzip', ['-q', zip, '-d', app], { stdio: 'inherit' })
  }
  assert.deepEqual(readdirSync(app), [NAME])
  assert.deepEqual(tree(join(app, NAME)).sort(), tree(join(kit, NAME)).sort(), 'the zip holds the kit folder as it is')
  entry = join(app, NAME, 'slicerx-mcp.mjs')
})
after(() => rmSync(work, { recursive: true, force: true }))

/** Starts `file` with node over stdio, with no NODE_PATH and no SLICERX_ settings, and returns a JSON-RPC client. */
function start(file, args = []) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SLICERX_') && k !== 'NODE_PATH' && k !== 'NODE_OPTIONS'))
  const child = spawn(process.execPath, [file, '--printers', 'off', ...args], { cwd: dirname(file), env, stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map()
  let buf = ''
  let err = ''
  let next = 1
  child.stderr.setEncoding('utf8').on('data', (d) => (err += d))
  child.stdout.setEncoding('utf8').on('data', (d) => {
    buf += d
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      if (msg.id != null && waiting.has(msg.id)) {
        waiting.get(msg.id).ok(msg)
        waiting.delete(msg.id)
      }
    }
  })
  child.once('exit', (code) => {
    for (const w of waiting.values()) w.fail(new Error(`the server exited with ${code}:\n${err}`))
    waiting.clear()
  })
  const request = (method, params = {}) => new Promise((ok, fail) => {
    const id = next++
    const timer = setTimeout(() => fail(new Error(`${method}: no answer in 60 s\n${err}`)), 60_000)
    waiting.set(id, { ok: (m) => (clearTimeout(timer), ok(m)), fail: (e) => (clearTimeout(timer), fail(e)) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  return {
    request,
    async initialize() {
      const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kit-standalone-test', version: '1.0.0' } })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      return init
    },
    call: (name, args) => request('tools/call', { name, arguments: args }),
    stop: () => new Promise((ok) => {
      if (child.exitCode !== null) return ok()
      child.once('exit', ok)
      child.kill()
    }),
  }
}

test('the self-contained server reports its version with plain node', () => {
  assert.equal(execFileSync(process.execPath, [entry, '--version'], { cwd: dirname(entry), encoding: 'utf8' }).trim(), version)
})

test('the self-contained server lists its tools and answers a knowledge tool with no node_modules', async () => {
  const server = start(entry)
  try {
    const init = await server.initialize()
    assert.equal(init.result?.serverInfo?.name, 'slicerx-mcp-server')
    assert.equal(init.result?.serverInfo?.version, version)
    const list = await server.request('tools/list')
    const names = list.result?.tools?.map((t) => t.name) ?? []
    assert.ok(names.length > 100, `lists ${names.length} tools`)
    for (const n of ['slicerx_kb_troubleshoot', 'slicerx_step_read']) assert.ok(names.includes(n), n)
    // the knowledge base is YAML, parsed on first use
    const kb = await server.call('slicerx_kb_troubleshoot', { symptom: 'stringing' })
    assert.equal(kb.error, undefined, JSON.stringify(kb.error))
    assert.notEqual(kb.result?.isError, true, JSON.stringify(kb.result))
    const text = kb.result.content.map((c) => c.text ?? '').join('\n')
    assert.match(text, /stringing/i)
    assert.doesNotMatch(text, /Cannot find module|ERR_MODULE_NOT_FOUND/)
  } finally {
    await server.stop()
  }
})

test('without the STEP reader the self-contained server starts and refuses slicerx_step_read with not_supported', async () => {
  assert.ok(!existsSync(join(dirname(entry), 'step-reader')), 'the kit ships the STEP reader only as its own optional tarball')
  const models = mkdtempSync(join(work, 'models-'))
  const model = join(models, 'bracket-inch.stp')
  copyFileSync(join(repo, 'packages', 'step-reader', 'test', 'fixtures', 'bracket-inch.stp'), model)
  const server = start(entry, ['--allow-dir', models])
  try {
    await server.initialize()
    const r = await server.call('slicerx_step_read', { model })
    assert.equal(r.result?.isError, true)
    const text = JSON.stringify(r)
    assert.match(text, /not_supported/)
    assert.match(text, /SLICERX_STEP_READER_DIR/)
  } finally {
    await server.stop()
  }
})

test('a packed kit lists the self-contained server in kit-manifest.json and SHA256SUMS.txt', { skip: !process.env.SX_KIT_DIR && 'set SX_KIT_DIR to a full pack' }, () => {
  const manifest = JSON.parse(readFileSync(join(kit, 'kit-manifest.json'), 'utf8'))
  const e = manifest.files.find((f) => f.name === `${NAME}.zip`)
  assert.ok(e, `kit-manifest.json lists ${NAME}.zip`)
  const sha = createHash('sha256').update(readFileSync(join(kit, e.name))).digest('hex')
  assert.equal(e.sha256, sha)
  assert.equal(e.entry, `${NAME}/slicerx-mcp.mjs`)
  assert.equal(e.version, version)
  assert.equal(pack.parseSums(readFileSync(join(kit, 'SHA256SUMS.txt'), 'utf8')).get(e.name), sha)
  // optional stays the STEP reader's alone
  assert.deepEqual(manifest.packages.filter((p) => p.optional).map((p) => p.name), ['@slicerx/step-reader'])
})
