// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The kit's self-contained MCP server, the way an app ships it: slicerx-mcp-standalone.zip unpacked on its own into a
// folder with no node_modules anywhere above it and started with plain node over stdio. It lists its tools, answers a
// knowledge tool (which loads the YAML parser and parses the knowledge base on first use), and without the optional
// STEP reader refuses slicerx_step_read with not_supported. The folder carries the license texts it needs: every npm
// package the build inlines (from esbuild's metafile) has its name, version and license text in
// THIRD-PARTY-LICENSES.txt, and NOTICE and README.txt name only files that are there. The zip's bytes do not depend on
// the folder the pack runs from.
//   node --test scripts/kit-standalone-mcp.test.mjs (pnpm test:kit-standalone)
// Builds the server with the pack's own step by default; SX_KIT_DIR selects a kit packed already, whose
// kit-manifest.json and SHA256SUMS.txt are checked too, and whose STEP reader tarball the server reads a file with.
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as pack from './pack-integrator-kit.mjs'

const repo = resolve(import.meta.dirname, '..')
const version = JSON.parse(readFileSync(join(repo, 'packages', 'mcp', 'package.json'), 'utf8')).version
const work = mkdtempSync(join(tmpdir(), 'sx-kit-standalone-'))
const kit = process.env.SX_KIT_DIR ? resolve(process.env.SX_KIT_DIR) : join(work, 'kit')
const NAME = 'slicerx-mcp-standalone'
const metafile = join(work, 'metafile.json')
// A home folder with nothing in it, so no ~/.node_modules or ~/.node_libraries can stand in for a missing package.
const home = mkdtempSync(join(work, 'home-'))
let entry

/** The environment the server runs with: no NODE_PATH, NODE_OPTIONS or SLICERX_ settings, and an empty home. */
const cleanEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SLICERX_') && k !== 'NODE_PATH' && k !== 'NODE_OPTIONS')),
  HOME: home,
  USERPROFILE: home,
  ...extra,
})

/** Unpacks `archive` into `into` with the system's tools, from the archive's folder with relative paths (GNU tar on
 * Windows reads C:\ in a path as a remote host). bsdtar reads zips; GNU tar does not, so unzip is the fallback. */
function unpack(archive, into) {
  const cwd = dirname(archive)
  const args = ['-xf', relative(cwd, archive), '-C', relative(cwd, into)]
  if (spawnSync('tar', args, { cwd, stdio: 'ignore' }).status === 0) return
  execFileSync('unzip', ['-q', archive, '-d', into], { stdio: 'inherit' })
}

/** Every path under `dir`, relative with `/`, folders ending in `/`. */
const tree = (dir, prefix = '') => readdirSync(dir).flatMap((n) =>
  statSync(join(dir, n)).isDirectory() ? [`${prefix}${n}/`, ...tree(join(dir, n), `${prefix}${n}/`)] : [`${prefix}${n}`])

before(() => {
  assert.equal(typeof pack.writeStandalone, 'function', 'the kit pack has a step that writes the self-contained MCP server')
  if (!process.env.SX_KIT_DIR) {
    mkdirSync(kit, { recursive: true })
    pack.writeStandalone(kit, { metafile })
  }
  // An empty folder in the system temp folder, with no node_modules in it or in any folder above it.
  const app = realpathSync(mkdtempSync(join(work, 'app-')))
  for (let d = app; ; d = dirname(d)) {
    assert.ok(!existsSync(join(d, 'node_modules')), `${d} has a node_modules folder`)
    if (dirname(d) === d) break
  }
  // unpack with the system's tools, as an integrator would
  unpack(join(kit, `${NAME}.zip`), app)
  assert.deepEqual(readdirSync(app), [NAME])
  assert.deepEqual(tree(join(app, NAME)).sort(), tree(join(kit, NAME)).sort(), 'the zip holds the kit folder as it is')
  entry = join(app, NAME, 'slicerx-mcp.mjs')
})
after(() => rmSync(work, { recursive: true, force: true }))

/** Starts `file` with node over stdio in the clean environment (plus `extraEnv`) and returns a JSON-RPC client. */
function start(file, args = [], extraEnv = {}) {
  const child = spawn(process.execPath, [file, '--printers', 'off', ...args], { cwd: dirname(file), env: cleanEnv(extraEnv), stdio: ['pipe', 'pipe', 'pipe'] })
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
  assert.equal(execFileSync(process.execPath, [entry, '--version'], { cwd: dirname(entry), env: cleanEnv(), encoding: 'utf8' }).trim(), version)
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

test('a packed kit\'s STEP reader tarball works with the self-contained server through SLICERX_STEP_READER_DIR', { skip: !process.env.SX_KIT_DIR && 'set SX_KIT_DIR to a full pack' }, async () => {
  const reader = mkdtempSync(join(work, 'reader-'))
  unpack(join(kit, 'slicerx-step-reader.tgz'), reader)
  const models = mkdtempSync(join(work, 'models-'))
  const model = join(models, 'bracket-inch.stp')
  copyFileSync(join(repo, 'packages', 'step-reader', 'test', 'fixtures', 'bracket-inch.stp'), model)
  const server = start(entry, ['--allow-dir', models], { SLICERX_STEP_READER_DIR: join(reader, 'package', 'dist') })
  try {
    await server.initialize()
    const r = await server.call('slicerx_step_read', { model })
    assert.notEqual(r.result?.isError, true, JSON.stringify(r))
    const info = JSON.parse(r.result.content[0].text)
    assert.equal(info.unit, 'inch')
    assert.equal(info.triangles, 464)
  } finally {
    await server.stop()
  }
})

/** The npm packages (`name version` and folder) of every node_modules input in an esbuild metafile. */
function inlinedPackages(meta) {
  const out = new Map()
  for (const input of Object.keys(meta.inputs)) {
    const path = resolve(repo, input.replace(/^[a-z-]+:/, ''))
    const parts = path.split(/[\\/]/)
    const at = parts.lastIndexOf('node_modules')
    if (at < 0) continue
    const name = parts[at + 1].startsWith('@') ? `${parts[at + 1]}/${parts[at + 2]}` : parts[at + 1]
    const dir = parts.slice(0, at + 1 + name.split('/').length).join('/')
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    assert.equal(pkg.name, name, dir)
    out.set(`${name} ${pkg.version}`, dir)
  }
  return out
}

test('every npm package the build inlines has its name, version and license text in THIRD-PARTY-LICENSES.txt', () => {
  if (process.env.SX_KIT_DIR) pack.writeStandalone(join(work, 'meta-kit'), { metafile })
  const meta = JSON.parse(readFileSync(metafile, 'utf8'))
  const packages = inlinedPackages(meta)
  const names = [...packages.keys()].map((k) => k.split(' ')[0])
  for (const n of ['@modelcontextprotocol/sdk', 'zod', 'yaml', 'ajv', 'zod-to-json-schema', '@noble/hashes']) assert.ok(names.includes(n), `the build inlines ${n}`)
  const notices = readFileSync(join(dirname(entry), 'THIRD-PARTY-LICENSES.txt'), 'utf8').replace(/\r\n/g, '\n')
  const squash = (t) => t.replace(/\s+/g, ' ').trim()
  const flat = squash(notices)
  for (const [key, dir] of packages) {
    assert.ok(notices.split('\n').includes(key), `THIRD-PARTY-LICENSES.txt names ${key}`)
    const texts = readdirSync(dir).filter((f) => /^(licen[cs]e|copying)([-.].*)?$/i.test(f))
    assert.ok(texts.length > 0, `${key} has a license file`)
    for (const f of texts) assert.ok(flat.includes(squash(readFileSync(join(dir, f), 'utf8'))), `THIRD-PARTY-LICENSES.txt has ${key}'s ${f}`)
  }
  console.log(`THIRD-PARTY-LICENSES.txt: ${packages.size} packages`)
})

test('the zip carries the license texts, and NOTICE and README.txt name only files that are in it', () => {
  const dir = dirname(entry)
  for (const f of ['LICENSE-APACHE', 'NOTICE', 'README.txt', 'THIRD-PARTY-LICENSES.txt', 'LICENSE-AGPL-profiles.txt', 'LICENSE-GPL-3.0.txt']) {
    assert.ok(existsSync(join(dir, f)), `the zip has ${f}`)
  }
  assert.equal(readdirSync(dir).filter((f) => /^LICENSE-LGPL-.+-profiles\.txt$/.test(f)).length, 1, 'the zip has the LGPL text of the profiles')
  assert.match(readFileSync(join(dir, 'LICENSE-GPL-3.0.txt'), 'utf8'), /^\s*GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/)
  assert.match(readFileSync(join(dir, 'LICENSE-APACHE'), 'utf8'), /Apache License\s+Version 2\.0/)
  for (const doc of ['NOTICE', 'README.txt']) {
    const text = readFileSync(join(dir, doc), 'utf8')
    assert.doesNotMatch(text, /THIRD-PARTY\.md|THIRD_PARTY_LICENSES|LICENSES\/|packages\//, `${doc} names a file outside the folder`)
    for (const [f] of text.matchAll(/\b(?:LICENSE-[\w.*-]*\w|THIRD-PARTY-[\w.-]*\w|slicerx-mcp[\w.-]*\.mjs)/g)) {
      if (f.includes('*')) continue
      assert.ok(existsSync(join(dir, f)), `${doc} names ${f}, which is not in the folder`)
    }
    assert.match(text, /THIRD-PARTY-LICENSES\.txt/)
  }
})

test('the zip has the same bytes whichever folder the pack runs from', () => {
  const shas = []
  for (const [i, cwd] of [tmpdir(), join(repo, 'scripts')].entries()) {
    const out = join(work, `cwd-${i}`)
    mkdirSync(out)
    const script = `import(${JSON.stringify(pathToFileURL(join(repo, 'scripts', 'pack-integrator-kit.mjs')).href)}).then((m) => m.writeStandalone(${JSON.stringify(out)}))`
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd, stdio: ['ignore', 'ignore', 'inherit'], timeout: 240_000 })
    shas.push(createHash('sha256').update(readFileSync(join(out, `${NAME}.zip`))).digest('hex'))
  }
  assert.equal(shas[0], shas[1], 'the zip built from the temp folder and from scripts/ differ')
  console.log(`${NAME}.zip sha256 ${shas[0]} from both folders`)
})
