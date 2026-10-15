// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Verify an installed tarball through the same SDK entry points integrators use.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [directory, binary] = process.argv.slice(2)
if (!directory || !binary) throw new Error('Usage: verify-packed.mjs <installed package directory> <sx binary>')
const root = resolve(directory)
const from = createRequire(join(root, 'package.json'))
const { Client } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
const { StdioClientTransport } = await import(pathToFileURL(from.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)
const pkg = JSON.parse(readFileSync(from.resolve('@slicerx/mcp/package.json'), 'utf8'))
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.toUpperCase().startsWith('SLICERX_MCP_')))
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [from.resolve('@slicerx/mcp/cli'), '--engine', 'sx', '--sx-bin', resolve(binary), '--printers', 'off', '--out-dir', join(root, 'out'), '--profiles-dir', join(root, 'profiles')],
  cwd: root, env, stderr: 'pipe',
})
let stderr = ''
transport.stderr?.on('data', chunk => { stderr += chunk.toString() })
const client = new Client({ name: 'packed-kit-verification', version: '1' })
const report = { packageVersion: pkg.version }
const failures = []
try {
  await client.connect(transport)
  report.serverVersion = client.getServerVersion()?.version
  await client.listTools()
  try {
    const result = await client.callTool({ name: 'slicerx_slice_file', arguments: { model: 'missing-relative.stl' } })
    report.refusal = result
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent?.error?.code, 'file_not_found')
    assert.match(result.content.find(c => c.type === 'text')?.text ?? '', /^Error: file_not_found: /)
  } catch (error) { report.refusalException = String(error); failures.push(error) }
  try {
    const result = await client.callTool({ name: 'slicerx_estimate_file', arguments: { model: 'sample:cube-20' } })
    assert.notEqual(result.isError, true)
    assert.equal(result.structuredContent?.engine, 'sx')
    assert.ok(result.structuredContent?.layer_count > 0)
    report.success = { engine: result.structuredContent.engine, layers: result.structuredContent.layer_count }
  } catch (error) { report.successException = String(error); failures.push(error) }
  try { assert.equal(report.serverVersion, pkg.version) } catch (error) { failures.push(error) }
} finally { await client.close() }
report.banner = stderr.split(/\r?\n/).find(line => line.startsWith('slicerx-mcp '))
try { assert.ok(report.banner?.startsWith(`slicerx-mcp ${pkg.version}:`)) } catch (error) { failures.push(error) }
console.log(JSON.stringify(report, null, 2))
if (failures.length) throw new AggregateError(failures, 'Packed client verification failed')
