// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx_remap_toolheads, called the way an integrating app calls it: a sliced four-filament U1 file remapped with no
// printer, read back from the file it wrote, an identity map that changes nothing, and each refusal as remap_refused.
import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

const FIXTURE = resolve(__dirname, '../../connect/tests/fixtures/u1-four-filament.gcode')

type Remap = { gcode_path: string; sha256: string; source_sha256: string; tools_used: number[]; counts: { changedLines: number; toolChanges: number; preextrudeIndexes: number } }
type Err = { error: { code: string; message: string; details?: { line?: number; reason?: string } } }

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const code = (line: string) => line.split(';')[0]!.trim()

describe('slicerx_remap_toolheads without the engine', () => {
  it('says the engine is needed, and checks the path and the map first', async () => {
    const h = await connect()
    try {
      const gcode = join(h.dir, 'u1.gcode')
      copyFileSync(FIXTURE, gcode)
      const stub = await h.call('slicerx_remap_toolheads', { gcode, map: { 0: 1 } })
      expect(data<Err>(stub).error.code).toBe('engine_unavailable')
      const bad = await h.call('slicerx_remap_toolheads', { gcode, map: { 0: 4 } })
      // The input schema refuses a toolhead past the U1's four before the tool runs.
      expect(bad.isError).toBe(true)
      expect(text(bad)).toMatch(/map/)
    } finally { await h.client.close() }
  })
})

describe.skipIf(noSx())('slicerx_remap_toolheads', { timeout: sxTimeout }, () => {
  it('moves every reference of a tool together on a four-filament U1 slice and keeps comments', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const gcode = join(h.dir, 'u1.gcode')
      copyFileSync(FIXTURE, gcode)
      const r = await h.call('slicerx_remap_toolheads', { gcode, map: { 0: 2, 1: 3, 2: 0, 3: 1 } })
      expect(r.isError, text(r)).toBeFalsy()
      const out = data<Remap>(r)
      const source = readFileSync(gcode, 'utf8')
      const result = readFileSync(out.gcode_path, 'utf8')
      expect(out.gcode_path).not.toBe(gcode)
      expect(readFileSync(gcode, 'utf8')).toBe(readFileSync(FIXTURE, 'utf8'))
      expect(out.sha256).toBe(sha256(result))
      expect(out.source_sha256).toBe(sha256(source))
      expect(out.tools_used).toEqual([0, 1, 2, 3])
      const before = source.split('\n')
      const after = result.split('\n')
      expect(after).toHaveLength(before.length)
      let tool: string | undefined
      let preextrude = 0
      after.forEach((line, n) => {
        expect(line.split(';').slice(1)).toEqual(before[n]!.split(';').slice(1))
        const words = code(line).split(/\s+/)
        if (/^T\d+$/.test(words[0]!)) tool = words[0]!.slice(1)
        if (words[0] === 'SM_PRINT_PREEXTRUDE_FILAMENT') {
          expect(words[1], `line ${n + 1}`).toBe(`INDEX=${tool}`)
          preextrude++
        }
      })
      expect(preextrude).toBeGreaterThanOrEqual(3)
      expect(out.counts.preextrudeIndexes).toBe(preextrude)
      expect(text(r)).toContain(out.sha256)
    } finally { await h.client.close() }
  })

  it('leaves the file byte for byte with an identity map', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const gcode = join(h.dir, 'u1.gcode')
      copyFileSync(FIXTURE, gcode)
      const r = await h.call('slicerx_remap_toolheads', { gcode, map: { 0: 0, 1: 1, 2: 2, 3: 3 } })
      expect(r.isError, text(r)).toBeFalsy()
      const out = data<Remap>(r)
      expect(readFileSync(out.gcode_path).equals(readFileSync(FIXTURE))).toBe(true)
      expect(out.sha256).toBe(out.source_sha256)
      expect(out.counts.changedLines).toBe(0)
    } finally { await h.client.close() }
  })

  it('refuses what the rewrite cannot read safely with remap_refused and the line', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const cases: [string, number | undefined, string][] = [
        ['T0\nt1\n', 2, 'Use uppercase tool commands'],
        ['T0\nM104S220T0\n', 2, 'Separate indexed temperature commands'],
        ['T0\nSM_PRINT_PREEXTRUDE_FILAMENT index=0\n', 2, 'Use uppercase tool parameter names'],
        ['T0\nCUSTOM T0\n', 2, 'Indexed tool parameter in CUSTOM'],
        ['T0 A2\n', 1, 'Use A0 or A1'],
        ['T0\nSET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=0 MAP_EXTRUDER=1\n', 2, 'Embedded firmware mapping'],
        ['T0\nT5\n', 2, 'Tool 5 has no selected loaded toolhead'],
        ['; slicerx_toolhead_map = {}\nT0\n', undefined, 'This file is already mapped'],
      ]
      for (const [body, line, reason] of cases) {
        const gcode = join(h.dir, 'bad.gcode')
        writeFileSync(gcode, body)
        const r = await h.call('slicerx_remap_toolheads', { gcode, map: { 0: 1, 1: 0 } })
        expect(r.isError, body).toBe(true)
        const e = data<Err>(r).error
        expect(e.code, body).toBe('remap_refused')
        expect(e.details?.line, body).toBe(line)
        expect(e.details?.reason, body).toMatch(new RegExp(`^${reason}`))
        expect(e.message).toBe(line === undefined ? e.details?.reason : `Line ${line}: ${e.details?.reason}`)
      }
      const outside = await h.call('slicerx_remap_toolheads', { gcode: FIXTURE, map: { 0: 1 } })
      expect(data<Err>(outside).error.code).toBe('path_not_allowed')
      const stl = await h.call('slicerx_remap_toolheads', { gcode: join(h.dir, 'cube.stl'), map: { 0: 1 } })
      expect(data<Err>(stl).error.code).toBe('unsupported_format')
    } finally { await h.client.close() }
  })
})
