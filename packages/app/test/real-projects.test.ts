// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Round trips real Bambu Studio projects from a local folder named by SX_REAL_PROJECTS (every .3mf in it).
// The files are never part of the repo; with no folder the suite skips.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { readProject, unzipEntries } from '../src/export/import3mf'
import { writeProjectCompressed } from '../src/export/threemf'
import type { PlateEntry, PlateMeta } from '../src/state/store'

const DIR = process.env.SX_REAL_PROJECTS ?? ''
const bed = { widthMm: 256, depthMm: 256 }
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 0, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const file = (name: string) => join(DIR, name)

function tris(objs: { parts: { indices: Uint32Array }[] }[]): number {
  return objs.reduce((n, o) => n + o.parts.reduce((m, p) => m + p.indices.length / 3, 0), 0)
}

function toPlates(p: Awaited<ReturnType<typeof readProject>>): PlateMeta[] {
  return p.plates.map((pl, i) => ({
    id: `p${i}`,
    name: pl.name,
    settings: pl.sequence ? { sequence: pl.sequence } : {},
    objects: pl.objects.map((o, j): PlateEntry => ({
      id: `o${i}-${j}`,
      name: o.name,
      handle: handle(`o${i}-${j}`),
      parts: o.parts,
      colors: o.parts.map((x) => p.colors[x.slot - 1] ?? '#bd93f9'),
      transform: o.transform,
      ...(o.volumes.length ? { volumes: o.volumes.map((v, k) => ({ id: `v${k}`, name: v.name, role: v.role, handle: handle(`v${k}`), part: v.part, local: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })) } : {}),
    })),
  }))
}

const names = DIR && existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.3mf')) : []
if (!names.length) describe.skip('real projects (set SX_REAL_PROJECTS)', () => it('skips', () => {}))
for (const name of names) {
  describe(name, () => {
    it('opens, keeps its objects, parts, colors and plates, and reopens as .sx3mf', async () => {
      const bytes = new Uint8Array(readFileSync(file(name)))
      const first = await readProject(bytes, bed)
      const objects = first.plates.flatMap((p) => p.objects)
      expect(objects.length).toBeGreaterThan(0)
      expect(tris(objects)).toBeGreaterThan(100)
      const summary = { plates: first.plates.map((p) => ({ name: p.name, objects: p.objects.map((o) => `${o.name}: ${o.parts.length} parts, ${o.volumes.length} volumes`) })), colors: first.colors, settings: Object.keys(first.settings).length }
      console.log(name, JSON.stringify(summary))
      // Filament slots come through: a multi-color project has parts beyond slot 1, all within its colors.
      const slots = objects.flatMap((o) => o.parts.map((x) => x.slot))
      if (first.colors.length > 1) {
        expect(Math.max(...slots)).toBeGreaterThan(1)
        expect(Math.max(...slots)).toBeLessThanOrEqual(first.colors.length)
      }
      const saved = await writeProjectCompressed({ plates: toPlates(first), bed, settings: first.settings, sx: { exportedBy: 'test' } })
      const again = await readProject(saved, bed)
      expect(again.plates.map((p) => p.name)).toEqual(first.plates.map((p) => p.name))
      expect(again.plates.map((p) => p.objects.length)).toEqual(first.plates.map((p) => p.objects.length))
      expect(tris(again.plates.flatMap((p) => p.objects))).toBe(tris(objects))
      expect(again.plates.flatMap((p) => p.objects).map((o) => o.parts.length)).toEqual(objects.map((o) => o.parts.length))
      expect(again.plates.flatMap((p) => p.objects).map((o) => o.volumes.length)).toEqual(objects.map((o) => o.volumes.length))
      expect(again.colors).toEqual(first.colors)
      const entries = await unzipEntries(saved)
      expect(entries.has('Metadata/project_settings.config')).toBe(true)
    }, 300_000)
  })
}
