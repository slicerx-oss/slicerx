// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One tool list: what MCP clients see is exactly serverTools(), the toolbox index lists every tool file, and
// TOOLS.md is written from the same list.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mcpName } from '../src/gate'
import { serverTools } from '../src/server'
import { toolsDoc } from '../src/tooldocs'
import { connect } from './helpers'
// @ts-expect-error a plain script, no types
import { toolIndex } from '../scripts/tool-index.mjs'

// A stand-in sx-geom so the geometry tools are listed wherever the test runs; none of them is called.
function fakeGeom(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'sx-geom-')), process.platform === 'win32' ? 'sx-geom.exe' : 'sx-geom')
  writeFileSync(path, '')
  chmodSync(path, 0o755)
  return path
}

describe('the tool registry', () => {
  it('lists every file in src/toolbox in its index', () => {
    expect(readFileSync(join(__dirname, '../src/toolbox/index.ts'), 'utf8')).toBe((toolIndex as () => string)())
  })

  it('serves exactly the registry over MCP, each tool once, with a description', async () => {
    const h = await connect({ sxGeomBin: fakeGeom(), printers: 'demo' })
    const listed = (await h.client.listTools()).tools.map((t) => t.name).sort()
    const registry = serverTools(h.ctx).map((t) => mcpName(t.name))
    expect(new Set(registry).size).toBe(registry.length)
    expect(listed).toEqual([...registry].sort())
    for (const t of serverTools(h.ctx)) expect(t.description.length, t.name).toBeGreaterThan(20)
  })

  it('keeps TOOLS.md in step with the registry', async () => {
    const h = await connect({ sxGeomBin: fakeGeom(), printers: 'demo' })
    const want = toolsDoc(serverTools(h.ctx))
    const path = join(__dirname, '../TOOLS.md')
    if (process.env['SLICERX_WRITE_TOOLS_DOC'] === '1') writeFileSync(path, want)
    expect(readFileSync(path, 'utf8')).toBe(want)
  })
})
