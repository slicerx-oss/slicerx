// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// hollow: shell a solid part to a wall thickness with sx-geom, cut drain holes
// through the face on the bed, swap the result into the project and report the
// volume and grams saved.
import type { Cell, MeshPart } from '@slicerx/contracts'
import { z } from 'zod'
import { defineSkill } from '../../src/tool'
import { pickObject } from '../common'
import { eachTri, transformParts, currentRotation, type Vec3 } from '../orientation_search/geometry'
import { NO_MESH_NOTE, cm3, densityOf, geomRun, meshInfo, modelDirection, needsGeometry, num, objectGeometry, partFromGeom, printNumbers, rec, replaceGeometry, round, unrotate } from '../geom_common/index'

/**
 * Drain hole points: centers of triangles on the face resting on the bed, as
 * placed, spread across that face and returned in model coordinates.
 */
export function drainPoints(parts: MeshPart[], rotate: [number, number, number], count: number): Vec3[] {
  if (count <= 0) return []
  const placed = transformParts(parts, rotate)
  let minZ = Infinity
  eachTri(placed, (t) => {
    minZ = Math.min(minZ, t.a[2], t.b[2], t.c[2])
  })
  const cands: { p: Vec3; area: number; k: number }[] = []
  let k = 0
  eachTri(placed, (t) => {
    const idx = k++
    if (t.n[2] > -0.99 || Math.max(t.a[2], t.b[2], t.c[2]) - minZ > 0.05 || t.area < 1) return
    cands.push({ p: [(t.a[0] + t.b[0] + t.c[0]) / 3, (t.a[1] + t.b[1] + t.c[1]) / 3, minZ], area: t.area, k: idx })
  })
  if (cands.length === 0) return []
  // Area-weighted center of the bed face, then the candidates nearest to it and farthest apart.
  const tot = cands.reduce((a, c) => a + c.area, 0)
  const cx = cands.reduce((a, c) => a + c.p[0] * c.area, 0) / tot
  const cy = cands.reduce((a, c) => a + c.p[1] * c.area, 0) / tot
  const d2 = (a: Vec3, x: number, y: number): number => (a[0] - x) ** 2 + (a[1] - y) ** 2
  const picked: Vec3[] = []
  const first = [...cands].sort((a, b) => d2(a.p, cx, cy) - d2(b.p, cx, cy))[0]
  if (first) picked.push(first.p)
  while (picked.length < count && picked.length < cands.length) {
    const next = [...cands].sort((a, b) => Math.min(...picked.map((q) => d2(b.p, q[0], q[1]))) - Math.min(...picked.map((q) => d2(a.p, q[0], q[1]))))[0]
    if (!next || picked.some((q) => d2(next.p, q[0], q[1]) < 1)) break
    picked.push(next.p)
  }
  // Back to model coordinates.
  return picked.map((p) => {
    const x = unrotate(rotate, p)
    return [round(x[0], 4), round(x[1], 4), round(x[2], 4)] as Vec3
  })
}

export interface HollowSaving {
  removedMm3: number
  solidGrams: number
  atInfillGrams: number
}

/**
 * Grams saved. Printed solid, the whole removed volume is saved; printed with
 * sparse infill, only the infill share of it was ever going to be plastic.
 */
export function hollowSaving(beforeMm3: number, afterMm3: number, density: number, infillPct: number): HollowSaving {
  const removed = Math.max(0, beforeMm3 - afterMm3)
  return { removedMm3: removed, solidGrams: round((removed / 1000) * density, 1), atInfillGrams: round((removed / 1000) * density * (infillPct / 100), 1) }
}

export function createHollow() {
  return defineSkill({
    name: 'hollow',
    version: '1.0.0',
    permission: 'slice',
    description:
      'Hollow a solid part to a wall thickness and cut drain holes through the face that rests on the bed, for light parts, resin export or filling. Replaces the object geometry in the project and reports volume and grams saved, both printed solid and at the current infill. Needs geometry on the host.',
    input: z.object({
      objectId: z.string().optional().describe('Object id or name; defaults to the first object in the project'),
      wallMm: z.number().min(0.8).max(20).default(2).describe('Wall thickness in mm'),
      drainHoles: z.number().int().min(0).max(6).default(1).describe('Drain holes through the bottom face'),
      holeDiameterMm: z.number().min(1).max(20).default(3).describe('Drain hole diameter in mm'),
    }),
    args: (i) => [i.objectId ?? null, `--wall ${i.wallMm}`, `--drain-holes ${i.drainHoles}`, i.drainHoles ? `--hole ${i.holeDiameterMm}` : null].filter(Boolean).join(' '),
    async approval(i, ctx) {
      const obj = pickObject(ctx, i.objectId)
      return { title: `Hollow ${obj?.name ?? 'the model'} to ${i.wallMm} mm walls?`, lines: [i.drainHoles ? `${i.drainHoles} drain hole${i.drainHoles === 1 ? '' : 's'} of ${i.holeDiameterMm} mm in the bottom face` : 'No drain holes: the cavity is closed'], actions: [] }
    },
    async run(i, ctx) {
      if (!ctx.host.geom) return needsGeometry('Hollowing')
      const obj = pickObject(ctx, i.objectId)
      if (!obj) return { ok: false, summary: 'No object in the project' }
      const g = await objectGeometry(obj)
      if (!g) return { ok: false, summary: `No mesh for ${obj.name}`, output: { note: NO_MESH_NOTE } }
      const nums = printNumbers(ctx, obj.id)
      const rotate = ctx.project ? currentRotation(ctx.project, obj.id) : ([0, 0, 0] as [number, number, number])
      const up = modelDirection(ctx.project, obj.id, [0, 0, 1])
      const points = drainPoints(g.parts, rotate, i.drainHoles)
      const drainHoles = points.map((point) => ({ point, direction: up, diameterMm: i.holeDiameterMm }))
      ctx.progress('hollowing')
      const res = await geomRun(ctx, 'hollow', { mesh: g.mesh, options: { wallMm: i.wallMm, drainHoles } })
      const first = g.parts[0]
      const part = partFromGeom(res['mesh'], first?.name ?? obj.name, first?.slot ?? 1)
      if (!part) return { ok: false, summary: 'Hollowing returned no mesh' }
      const report = rec(res['report'])
      const after = await meshInfo(ctx, { positions: Array.from(part.positions), indices: Array.from(part.indices) })
      const before = num(report['volumeBeforeMm3'])
      const dens = densityOf(ctx.kb, nums.material)
      const saving = hollowSaving(before, num(report['volumeAfterMm3'], after.volumeMm3), dens.gPerCm3, nums.infillPct)
      const holesCut = num(report['drainHoles'])
      if (saving.removedMm3 < 1) return { ok: false, summary: `${obj.name} is too thin to hollow with ${i.wallMm} mm walls`, output: { wallMm: i.wallMm, volumeCm3: cm3(before) } }
      const replaced = await replaceGeometry(ctx.project, obj, [part])
      const notes: string[] = []
      if (g.parts.length > 1) notes.push(`The ${g.parts.length} parts were hollowed as one body on the first part's filament slot.`)
      if (i.drainHoles > 0 && holesCut < i.drainHoles) notes.push(`Only ${holesCut} of ${i.drainHoles} drain holes could be placed on the bottom face.`)
      if (i.drainHoles === 0) notes.push('The cavity is sealed. For resin prints add a drain hole; for FDM the slicer fills the cavity with nothing, so the part is only walls.')
      if (!after.watertight) notes.push(`The result has ${after.openEdges} open edges; repair the mesh before slicing.`)
      if (!replaced) notes.push('This project cannot swap geometry, so the hollowed mesh was not applied.')
      if (!dens.fromKb) notes.push(`No density for ${nums.material} in the knowledge base; grams use 1.24 g/cm3.`)
      const rows: [string, Cell][] = [
        ['wall', `${i.wallMm} mm`],
        ['volume', `${cm3(before)} to ${cm3(before - saving.removedMm3)} cm3 (${round(num(report['materialSavedPercent']), 0)}% less)`],
        ['saved if printed solid', `${saving.solidGrams} g`],
        [`saved at ${nums.infillPct}% infill`, `${saving.atInfillGrams} g`],
        ['drain holes', holesCut ? `${holesCut} x ${i.holeDiameterMm} mm in the bottom face` : 'none'],
        ['watertight', after.watertight ? { text: 'yes', tone: 'ok' } : { text: 'no', tone: 'warn' }],
      ]
      return {
        summary: `${obj.name} hollowed to ${i.wallMm} mm walls, ${cm3(saving.removedMm3)} cm3 less, up to ${saving.solidGrams} g saved`,
        output: {
          objectId: obj.id,
          replaced,
          wallMm: i.wallMm,
          volumeBeforeCm3: cm3(before),
          volumeAfterCm3: cm3(before - saving.removedMm3),
          removedCm3: cm3(saving.removedMm3),
          gramsSavedSolid: saving.solidGrams,
          gramsSavedAtInfill: saving.atInfillGrams,
          infillPct: nums.infillPct,
          densityGPerCm3: dens.gPerCm3,
          drainHoles: holesCut,
          watertight: after.watertight,
          ...(notes.length ? { notes } : {}),
        },
        display: [{ kind: 'kv', rows }, ...(notes.length ? [{ kind: 'text' as const, text: notes.join(' ') }] : [])],
        ...(dens.fromKb ? { citations: ctx.kb.cite(dens.sources) } : {}),
      }
    },
  })
}
