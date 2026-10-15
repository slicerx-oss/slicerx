// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout } from './helpers'

type Row = { object?: string; engine_object: string; name: string; features: Record<string, number[]> }
function project(path: string) {
  const vertices = Array.from({ length: 8 }, (_, i) => `<vertex x="${i & 1 ? 5 : 0}" y="${i & 2 ? 5 : 0}" z="${i & 4 ? 2 : 0}"/>`).join('')
  const faces = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]
  const triangles = faces.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')
  const names = ['Bracket', 'Bracket', 'Cap']
  const resources = names.map((name, i) => `<object id="${i + 1}" name="${name}" type="model"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object>`).join('')
  const items = names.map((_, i) => `<item objectid="${i + 1}" transform="1 0 0 0 1 0 0 0 1 ${20 + i * 20} 30 0"/>`).join('')
  writeFileSync(path, writeZip([{ name: '3D/3dmodel.model', data: `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${resources}</resources><build>${items}</build></model>` }]))
}
const check = (rows: Row[]) => {
  expect(rows).toHaveLength(3)
  expect(rows.map((r) => r.engine_object)).toEqual(['o0-1', 'o0-2', 'o0-3'])
  expect(rows.map((r) => r.name)).toEqual(['Bracket', 'Bracket', 'Cap'])
  for (const row of rows) expect(row.features).toMatchObject({ outerWall: [1] })
}

describe.skipIf(noSx())('split project feature filaments', () => {
  it('keeps all native objects, including repeated names, through the SDK and native CLI', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const path = join(h.dir, 'three-objects.3mf')
      project(path)
      const args = { model: path, overrides: { smart_layer: 'off', layer_height: 0.2 } }
      await h.client.listTools()
      const response = CallToolResultSchema.parse(await h.client.callTool({ name: 'slicerx_slice_file', arguments: args }))
      expect(response.isError, JSON.stringify(response)).not.toBe(true)
      check(data<{ feature_filaments: Row[] }>(response).feature_filaments)
      // Use the source runtime so a clean checkout does not need a previous package build.
      const env = { ...process.env, NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --import tsx`, SLICERX_MCP_CLI: resolve(__dirname, '../src/cli.ts'), SLICERX_NODE_BIN: process.execPath }
      const { stdout } = await promisify(execFile)(sxBin, ['call', '--no-app', '--engine', 'sx', '--sx-bin', sxBin, '--printers', 'off', '--allow-dir', h.dir, '--out-dir', join(h.dir, 'cli'), '--profiles-dir', join(h.dir, 'profiles'), 'slice_file', JSON.stringify(args)], { cwd: resolve(__dirname, '..'), env, windowsHide: true, timeout: sxTimeout })
      const row = JSON.parse(stdout.trim())
      expect(row.ok, stdout).toBe(true)
      check(row.output.feature_filaments)
    } finally { await h.client.close() }
  }, sxTimeout)
})
