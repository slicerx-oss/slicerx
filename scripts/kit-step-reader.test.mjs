// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The kit's optional STEP reader, the way an app gets it: the packed kit has slicerx-step-reader.tgz beside the MCP
// tarball (in kit-manifest.json and SHA256SUMS.txt, with its license texts, NOTICE, SOURCE.md and the wasm), the MCP
// tarball holds none of the reader, an app with only the MCP installed is told to install the reader's tarball, and
// once both tarballs are installed with npm the server reads a STEP file.
//   node --test scripts/kit-step-reader.test.mjs (pnpm test:kit-step)
// Packs the kit by default; SX_KIT_DIR selects a folder packed already. npm installs the MCP's dependencies from the
// registry.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { parseSums } from './pack-integrator-kit.mjs'

const repo = resolve(import.meta.dirname, '..')
const win = process.platform === 'win32'
const npm = win ? 'npm.cmd' : 'npm'
const fixture = join(repo, 'packages', 'step-reader', 'test', 'fixtures', 'bracket-inch.stp')
const work = mkdtempSync(join(tmpdir(), 'sx-kit-step-'))
const kit = process.env.SX_KIT_DIR ? resolve(process.env.SX_KIT_DIR) : join(work, 'kit')
const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]))

/** The files in a tarball, as paths inside its package/ folder, and the folder it was unpacked to. */
function unpack(tarball) {
  const into = mkdtempSync(join(work, 'unpack-'))
  execFileSync('tar', ['-xzf', tarball, '-C', into])
  const root = join(into, 'package')
  return { root, names: files(root).map((f) => relative(root, f).split('\\').join('/')) }
}

before(() => {
  if (!process.env.SX_KIT_DIR) execFileSync(process.execPath, [join(repo, 'scripts', 'pack-integrator-kit.mjs'), kit], { cwd: repo, stdio: 'pipe', timeout: 280_000 })
})
after(() => rmSync(work, { recursive: true, force: true }))

test('the kit has the STEP reader as its own tarball, in the manifest and SHA256SUMS.txt, and the MCP tarball holds none of it', () => {
  const manifest = JSON.parse(readFileSync(join(kit, 'kit-manifest.json'), 'utf8'))
  const step = manifest.packages.find((p) => p.name === '@slicerx/step-reader')
  assert.ok(step, 'kit-manifest.json lists @slicerx/step-reader')
  assert.equal(step.file, 'slicerx-step-reader.tgz')
  assert.equal(step.optional, true)
  const mcp = manifest.packages.find((p) => p.name === '@slicerx/mcp')
  assert.equal(step.version, mcp.version, 'the reader is on the kit version line')
  const bytes = readFileSync(join(kit, step.file))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), step.sha256)
  assert.deepEqual(readFileSync(join(kit, step.archive)), bytes)
  const sums = parseSums(readFileSync(join(kit, 'SHA256SUMS.txt'), 'utf8'))
  assert.equal(sums.get(step.file), step.sha256)
  assert.equal(sums.get(step.archive), step.sha256)
  console.log(`kit: ${step.file} ${bytes.length} bytes, ${mcp.file} ${statSync(join(kit, mcp.file)).size} bytes`)

  const reader = unpack(join(kit, step.file))
  for (const f of ['NOTICE', 'SOURCE.md', 'README.md', 'LICENSE-APACHE', 'LICENSE-occt-import-js.txt', 'LICENSE-occt.txt', 'OCCT_LGPL_EXCEPTION.txt', 'LICENSE-emscripten.txt', 'LICENSE-musl.txt', 'LICENSE-libcxx.txt', 'build.sh', 'source-archive.sh', 'patches/0001-mesh-kind.patch', 'dist/node.js', 'dist/node-worker.js', 'dist/occt-import-js.mjs', 'dist/occt-import-js.wasm']) {
    assert.ok(reader.names.includes(f), `the reader tarball has ${f}`)
  }
  assert.equal(JSON.parse(readFileSync(join(reader.root, 'package.json'), 'utf8')).version, step.version)

  const server = unpack(join(kit, mcp.file))
  // no wasm, no OpenCASCADE glue or license texts, and nothing of the reader but the type declarations its tool's types name
  assert.deepEqual(server.names.filter((n) => /occt|\.wasm$/i.test(n) || (/step-reader/.test(n) && !n.endsWith('.d.ts'))), [])
  const cli = readFileSync(join(server.root, 'dist', 'cli.js'), 'utf8')
  assert.ok(cli.includes('@slicerx/step-reader/node'), 'the server imports the reader by package name')
  assert.ok(!cli.includes('occt-import-js'), 'the server does not inline the reader')
  const meta = JSON.parse(readFileSync(join(server.root, 'package.json'), 'utf8'))
  assert.equal(meta.dependencies?.['@slicerx/step-reader'], undefined)
  assert.equal(meta.peerDependenciesMeta?.['@slicerx/step-reader']?.optional, true)
})

test('an app with the MCP tarball is told to install the reader tarball, and reads a STEP file once it is installed', () => {
  const app = join(work, 'app')
  mkdirSync(app)
  writeFileSync(join(app, 'package.json'), `${JSON.stringify({ name: 'kit-step-app', private: true, type: 'module' }, null, 2)}\n`)
  copyFileSync(fixture, join(app, 'bracket-inch.stp'))
  const install = (...tarballs) => {
    const r = spawnSync(npm, ['install', '--no-audit', '--no-fund', ...tarballs.map((t) => join(kit, t))], { cwd: app, encoding: 'utf8', shell: win, timeout: 240_000 })
    assert.equal(r.status, 0, `npm install failed:\n${r.stdout}\n${r.stderr}`)
    // npm accepts the reader as the server's optional peer: no conflict and no invalid peer
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /ERESOLVE|invalid|peer dep/i)
  }
  const call = () => {
    const r = spawnSync(process.execPath, [join(app, 'node_modules', '@slicerx', 'mcp', 'dist', 'cli.js'), '--printers', 'off', '--engine', 'stub', '--allow-dir', app, '--out-dir', join(app, 'out'), 'call', 'step_read', JSON.stringify({ model: join(app, 'bracket-inch.stp') })], { cwd: app, encoding: 'utf8', timeout: 120_000 })
    const line = r.stdout.trim().split('\n').filter(Boolean).pop()
    assert.ok(line, `no output (exit ${r.status}):\n${r.stderr}`)
    return { status: r.status, out: JSON.parse(line) }
  }

  install('slicerx-mcp.tgz')
  const refused = call()
  assert.equal(refused.status, 1)
  assert.equal(refused.out.ok, false)
  assert.match(refused.out.text, /not_supported/)
  assert.match(refused.out.text, /slicerx-step-reader\.tgz/)

  install('slicerx-step-reader.tgz')
  const { status, out } = call()
  assert.equal(status, 0, JSON.stringify(out))
  assert.equal(out.ok, true)
  const info = out.output
  assert.equal(info.unit, 'inch')
  assert.equal(info.triangles, 464)
  const round = (v) => Math.round(v * 1000) / 1000
  assert.deepEqual(info.bounds.max.map(round), [25.4, 12.7, 3.175])
  assert.deepEqual(info.bounds.min.map(round), [-25.4, -12.7, -3.175])
})
