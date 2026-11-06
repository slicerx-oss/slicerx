// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One tool list: what MCP clients see is exactly serverTools(), the toolbox index lists every tool file, and
// TOOLS.md is written from the same list (checked for form and content here, and written at each release).
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mcpName } from '../src/gate'
import { serverTools } from '../src/server'
import { parseToolsDoc, toolsDoc, toolsDocRows } from '../src/tooldocs'
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

  // Pull requests and merge groups leave TOOLS.md as main has it, so this checks the doc the registry writes, not the
  // committed bytes: well formed, every served tool once, each with its version. A release writes the file
  // (scripts/tools-doc.ts); SLICERX_TOOLS_DOC_STRICT=1 also compares it byte for byte.
  it('writes TOOLS.md from the registry, every tool once with its version', async () => {
    const h = await connect({ sxGeomBin: fakeGeom(), printers: 'demo' })
    const tools = serverTools(h.ctx)
    const want = toolsDoc(tools)
    const path = join(__dirname, '../TOOLS.md')
    if (process.env['SLICERX_WRITE_TOOLS_DOC'] === '1') writeFileSync(path, want)
    const { rows, problems } = parseToolsDoc(want)
    expect(problems).toEqual([])
    const listed = (await h.client.listTools()).tools.map((t) => t.name).sort((a, b) => a.localeCompare(b))
    expect(rows.map((r) => r.name)).toEqual(listed)
    expect(Object.fromEntries(rows.map((r) => [r.name, r.version]))).toEqual(Object.fromEntries(tools.map((t) => [mcpName(t.name), t.version])))
    expect(rows).toEqual(toolsDocRows(tools))
    if (process.env['SLICERX_TOOLS_DOC_STRICT'] === '1') expect(readFileSync(path, 'utf8')).toBe(want)
  })

  it('keeps the committed TOOLS.md well formed', () => {
    expect(parseToolsDoc(readFileSync(join(__dirname, '../TOOLS.md'), 'utf8')).problems).toEqual([])
  })

  it('reads a malformed TOOLS.md as malformed', () => {
    const good = ['# SlicerX MCP tools', '', '2 tools.', '', '| Tool | Version | Title | Set | Permission | What it does |', '| --- | --- | --- | --- | --- | --- |']
    const a = '| `slicerx_a` | 1.0.0 | A | core | read | Reads a \\| b. |'
    const b = '| `slicerx_b` | 1.2.0 |  |  | edit | Changes b. |'
    expect(parseToolsDoc([...good, a, b, ''].join('\n'))).toEqual({
      problems: [],
      rows: [
        { name: 'slicerx_a', version: '1.0.0', title: 'A', set: 'core', permission: 'read', about: 'Reads a \\| b.' },
        { name: 'slicerx_b', version: '1.2.0', title: '', set: '', permission: 'edit', about: 'Changes b.' },
      ],
    })
    expect(parseToolsDoc([...good, b, a, ''].join('\n')).problems).toEqual(['slicerx_a is out of order after slicerx_b'])
    expect(parseToolsDoc([...good, a, a, ''].join('\n')).problems).toEqual(['slicerx_a is listed twice'])
    expect(parseToolsDoc([...good, a, ''].join('\n')).problems).toEqual(['it says 2 tools but lists 1'])
    expect(parseToolsDoc([...good, a, '| `slicerx_b` | 1.2 | | | edit | Changes b. |', ''].join('\n')).problems).toEqual(['line 8: version "1.2" is not major.minor.patch'])
    expect(parseToolsDoc([...good, a, '| `slicerx_b` | 1.2.0 | edit | Changes b. |', ''].join('\n')).problems).toEqual(['line 8 has 4 cells, not 6', 'it says 2 tools but lists 1'])
    expect(parseToolsDoc(['# Tools', '', '| Tool | Title |', ''].join('\n')).problems).toEqual([
      'the first line is not "# SlicerX MCP tools"',
      'no "<n> tools." line',
      'no table header "| Tool | Version | Title | Set | Permission | What it does |" with its rule line',
    ])
  })

  it('lists the gating of the mimir and Vault tools', async () => {
    const h = await connect({ sxGeomBin: fakeGeom(), printers: 'demo' })
    const doc = toolsDoc(serverTools(h.ctx))
    // the read is gated as a read and adding a fact as a profile change
    expect(doc).toMatch(/\| `slicerx_mimir_memory` \| [\d.]+ \|  \|  \| read \|/)
    expect(doc).toMatch(/\| `slicerx_mimir_memory_remember` \| [\d.]+ \|  \|  \| profile \|/)
    // the print run read-back is a read; starting a print stays with printer.queue and the person
    expect(doc).toMatch(/\| `slicerx_mimir_run` \| [\d.]+ \|  \|  \| read \|/)
    // the Vault list reads with the app's own session and changes nothing
    expect(doc).toMatch(/\| `slicerx_vault_list` \| [\d.]+ \|  \|  \| read \|/)
  })
})
