// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Packs the kit by default; SX_MCP_TARBALL selects an existing kit tarball.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
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
    const library = await import(pathToFileURL(join(packed, 'dist/index.js')).href)
    assert.equal(library.SERVER_VERSION, expected)
    const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
    const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)
    client = new Client({ name: 'package-version-test', version: '1.0.0' })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, '--printers', 'off'], stderr: 'pipe' }))
    assert.equal(client.getServerVersion().version, expected)
  } finally {
    await client?.close()
    rmSync(work, { recursive: true, force: true })
  }
})
