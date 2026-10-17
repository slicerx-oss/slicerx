// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// walls: make an existing part's walls (or floor) thicker or thinner. The inside face of each flat wall is pushed or
// pulled with sx-geom's face push, so the outside stays where it is, and the part is swapped in as one step.
import type { Cell, MeshPart } from '@slicerx/contracts'
import { z } from 'zod'
import { defineSkill } from '../../src/tool'
import { pickObject } from '../common'
import { flatFaces, partTriangles } from '../geom_common/faces'
import { NO_MESH_NOTE, cm3, geomRun, meshInfo, needsGeometry, objectGeometry, partFromGeom, replaceGeometry, toGeomMesh } from '../geom_common/index'
import { findTarget, planWalls, type WallTarget } from './plan'

const WHICH = { walls: 'walls', floor: 'floor', both: 'walls and floor' } as const

const thick = (ts: readonly WallTarget[]): string => {
  const v = [...new Set(ts.map((t) => t.thicknessMm))].sort((a, b) => a - b)
  return v.length === 1 ? `${v[0]} mm` : `${v[0]} to ${v[v.length - 1]} mm`
}

export function createWalls() {
  return defineSkill({
    name: 'walls',
    version: '1.0.0',
    permission: 'slice',
    description:
      'Make the walls (or the floor) of a part already in the project thicker or thinner, such as a case, box or tray: give the new thickness (wallMm) or the change (byMm). The inside of each flat wall moves and the outside stays, so the part keeps its size. Reports each wall before and after and the volume. Works on flat, square-on walls; needs geometry on the host.',
    input: z
      .object({
        objectId: z.string().optional().describe('Object id or name; defaults to the first object in the project'),
        wallMm: z.number().min(0.4).max(50).optional().describe('The new wall thickness, mm'),
        byMm: z.number().min(-20).max(20).optional().describe('Or how much thicker (negative: thinner), mm'),
        which: z.enum(['walls', 'floor', 'both']).default('walls'),
      })
      .refine((i) => (i.wallMm === undefined) !== (i.byMm === undefined), 'give wallMm or byMm, not both'),
    args: (i) => [i.objectId ?? null, i.wallMm !== undefined ? `--wall ${i.wallMm}` : `--by ${i.byMm}`, i.which !== 'walls' ? `--${i.which}` : null].filter(Boolean).join(' '),
    async approval(i, ctx) {
      const obj = pickObject(ctx, i.objectId)
      const what = i.wallMm !== undefined ? `to ${i.wallMm} mm` : `${(i.byMm ?? 0) > 0 ? 'thicker' : 'thinner'} by ${Math.abs(i.byMm ?? 0)} mm`
      return { title: `Change the ${WHICH[i.which]} of ${obj?.name ?? 'the part'} ${what}?`, lines: ['The outside stays where it is; the inside moves.'], actions: [] }
    },
    async run(i, ctx) {
      if (!ctx.host.geom) return needsGeometry('Changing walls')
      const obj = pickObject(ctx, i.objectId)
      if (!obj) return { ok: false, summary: 'No object in the project' }
      const g = await objectGeometry(obj)
      if (!g) return { ok: false, summary: `No mesh for ${obj.name}`, output: { note: NO_MESH_NOTE } }
      const before = await meshInfo(ctx, g.mesh)
      const plan = planWalls(flatFaces(partTriangles(g.mesh)), before, { which: i.which, ...(i.wallMm !== undefined ? { wallMm: i.wallMm } : { byMm: i.byMm ?? 0 }) })
      if ('error' in plan) return { ok: false, summary: `${obj.name} unchanged: ${plan.error}` }
      let mesh = g.mesh
      for (const [k, t] of plan.targets.entries()) {
        ctx.progress(`moving ${t.kind === 'floor' ? 'the floor' : `wall ${k + 1}`}`, k / plan.targets.length)
        const f = findTarget(flatFaces(partTriangles(mesh)), t)
        if (!f) return { ok: false, summary: `${obj.name} unchanged: a wall moved out of reach after the others` }
        const res = await geomRun(ctx, 'face.push', { mesh, triangle: f.triangle, at: f.at, distanceMm: t.deltaMm })
        const next = res['mesh'] as { positions?: number[]; indices?: number[] } | undefined
        if (!next?.positions || !next.indices) return { ok: false, summary: `${obj.name} unchanged: the push returned no mesh` }
        mesh = { positions: next.positions, indices: next.indices }
      }
      const after = await meshInfo(ctx, mesh)
      if (!after.watertight) return { ok: false, summary: `${obj.name} unchanged: the new walls did not close` }
      const part: MeshPart | null = partFromGeom(mesh, g.parts[0]?.name ?? obj.name, g.parts[0]?.slot ?? 1)
      if (!part) return { ok: false, summary: `${obj.name} unchanged: no mesh came back` }
      const replaced = await replaceGeometry(ctx.project, obj, [part])
      const moved = plan.targets.map((t) => ({ kind: t.kind, normal: t.normal, beforeMm: t.thicknessMm, afterMm: Math.round((t.thicknessMm + t.deltaMm) * 1000) / 1000 }))
      const rows: Cell[][] = [
        [plan.targets.some((t) => t.kind === 'floor') && plan.targets.some((t) => t.kind === 'wall') ? 'walls and floor' : plan.targets[0]?.kind === 'floor' ? 'floor' : 'walls', thick(plan.targets), thick(plan.targets.map((t) => ({ ...t, thicknessMm: t.thicknessMm + t.deltaMm })))],
        ['size', before.sizeMm.join(' x ') + ' mm', after.sizeMm.join(' x ') + ' mm'],
        ['volume', `${cm3(before.volumeMm3)} cm3`, `${cm3(after.volumeMm3)} cm3`],
      ]
      return {
        summary: `${obj.name}: ${moved.length} face${moved.length === 1 ? '' : 's'} moved, ${rows[0]?.[0]} ${thick(plan.targets)} to ${rows[0]?.[2]}${replaced ? '' : ' (this project cannot swap geometry, so it was not applied)'}`,
        output: { objectId: obj.id, replaced, faces: moved, before: { sizeMm: before.sizeMm, volumeCm3: cm3(before.volumeMm3) }, after: { sizeMm: after.sizeMm, volumeCm3: cm3(after.volumeMm3), watertight: after.watertight } },
        display: [{ kind: 'table', head: ['', 'before', 'after'], rows }],
      }
    },
  })
}
