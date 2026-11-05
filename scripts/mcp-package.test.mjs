// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Packs the kit by default; SX_MCP_TARBALL selects an existing kit tarball. Also builds the self-contained server to
// check that both built servers serve --http.
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const pkg = resolve(import.meta.dirname, '../packages/mcp')
const require = createRequire(join(pkg, 'package.json'))
const tarball = process.env.SX_MCP_TARBALL

test('packed CLI, library and MCP handshake report the package version', async () => {
  const work = mkdtempSync(join(tmpdir(), 'sx-mcp-package-'))
  let client
  try {
    const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version
    if (!tarball) execFileSync(process.execPath, [resolve(import.meta.dirname, 'pack-integrator-kit.mjs'), join(work, 'kit')], { cwd: resolve(pkg, '../..'), stdio: 'pipe', timeout: 240_000 })
    const archive = tarball ? resolve(tarball) : join(work, 'kit', `slicerx-mcp-${version}.tgz`)
    execFileSync('tar', ['-xzf', basename(archive), '-C', work], { cwd: dirname(archive) })
    const packed = join(work, 'package')
    symlinkSync(join(pkg, 'node_modules'), join(packed, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    const expected = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8')).version
    assert.equal(expected, JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version)
    const cli = join(packed, 'dist/cli.js')
    assert.equal(execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim(), expected)
    // The packed server loads Ajv and the YAML parser on first use, not as it starts (packages/mcp/src/deferred.ts).
    const listLoaded = "import{registerHooks}from'node:module';const u=[];registerHooks({load(url,c,n){u.push(url);return n(url,c)}});process.on('exit',()=>process.stderr.write(JSON.stringify(u)))"
    const started = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(listLoaded)}`, cli, '--version'], { encoding: 'utf8' })
    assert.equal(started.stdout.trim(), expected)
    const loaded = JSON.parse(started.stderr)
    assert.ok(loaded.some((url) => url.includes('/@modelcontextprotocol/sdk/dist/esm/server/')), 'the start loads the SDK server')
    assert.deepEqual(loaded.filter((url) => /\/node_modules\/(?:ajv|ajv-formats|yaml)\//.test(url)), [])
    const library = await import(pathToFileURL(join(packed, 'dist/index.js')).href)
    assert.equal(library.SERVER_VERSION, expected)
    // A host that bundles the library (here with esbuild, as ES module and as CommonJS) and ships the bundle without
    // node_modules still reads the knowledge base: the library imports yaml statically, so the bundler takes it in.
    const { build } = await import(pathToFileURL(require.resolve('esbuild')).href)
    const hostEntry = join(work, 'host-entry.mjs')
    writeFileSync(hostEntry, `import { DataStore, resolveDataPaths } from ${JSON.stringify(join(packed, 'dist/index.js').replace(/\\/g, '/'))}\nprocess.stdout.write(String(new DataStore(resolveDataPaths(process.argv[2])).knowledge().length))\n`)
    for (const [format, file] of [['esm', 'host.mjs'], ['cjs', 'host.cjs']]) {
      const out = join(work, `host-${format}`, file)
      // An ES module bundle for Node needs a require() for the CommonJS packages it takes in; hosts add one this way.
      const banner = format === 'esm' ? { js: "import { createRequire as __hostCreateRequire } from 'node:module'; const require = __hostCreateRequire(import.meta.url);" } : undefined
      await build({ entryPoints: [hostEntry], outfile: out, bundle: true, platform: 'node', format, target: 'node24', external: ['@slicerx/step-reader'], banner, logLevel: 'error' })
      const read = spawnSync(process.execPath, [out, join(packed, 'data')], { cwd: dirname(out), encoding: 'utf8' })
      assert.equal(read.status, 0, `${format} host bundle: ${read.stderr}`)
      assert.ok(Number(read.stdout) > 10, `${format} host bundle read ${read.stdout} knowledge files`)
    }
    const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
    const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)
    client = new Client({ name: 'package-version-test', version: '1.0.0' })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, '--printers', 'off'], stderr: 'pipe' }))
    assert.equal(client.getServerVersion().version, expected)
    // Both built servers, the packed npm one and the self-contained one, serve streamable HTTP with --http.
    const standalone = join(work, 'standalone')
    execFileSync(process.execPath, [join(pkg, 'scripts/build.mjs'), '--standalone', standalone], { stdio: 'pipe', timeout: 240_000 })
    for (const entry of [cli, join(standalone, 'slicerx-mcp.mjs')]) await httpSmoke(entry)
  } finally {
    await client?.close()
    rmSync(work, { recursive: true, force: true })
  }
})

/** Starts `entry` with --http on a free loopback port and a token, checks initialize, tools/list and a wrong token,
 * then stops that server. */
async function httpSmoke(entry) {
  const port = await new Promise((ok, fail) => {
    const probe = createServer().once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => ok(port))
    })
  })
  const token = randomBytes(32).toString('hex')
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SLICERX_')))
  const server = spawn(process.execPath, [entry, '--http', '--port', String(port), '--printers', 'off', '--no-urls'], { env: { ...env, SLICERX_MCP_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'] })
  try {
    await new Promise((ok, fail) => {
      let err = ''
      server.stderr.setEncoding('utf8').on('data', (d) => {
        err += d
        if (err.includes('listening on')) ok()
      })
      server.once('exit', (code) => fail(new Error(`${entry} exited with ${code} before listening: ${err}`)))
    })
    const url = `http://127.0.0.1:${port}/mcp`
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }
    const post = (body, extra = {}) => fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
    // A reply comes as JSON or as one server-sent event.
    const reply = async (res) => {
      const text = await res.text()
      const data = text.split('\n').find((line) => line.startsWith('data: '))
      return JSON.parse(data ? data.slice(6) : text)
    }
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'package-http-test', version: '1.0.0' } } })
    assert.equal(init.status, 200, `${entry} initialize`)
    assert.equal((await reply(init)).result?.serverInfo?.name, 'slicerx-mcp-server')
    const session = { 'mcp-session-id': init.headers.get('mcp-session-id'), 'mcp-protocol-version': '2025-06-18' }
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session)
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, session)
    assert.equal(list.status, 200, `${entry} tools/list`)
    assert.ok((await reply(list)).result?.tools?.length > 100, `${entry} lists its tools`)
    const refused = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, { ...session, authorization: 'Bearer wrong' })
    assert.equal(refused.status, 401, `${entry} refuses a wrong token`)
  } finally {
    server.kill()
  }
}
