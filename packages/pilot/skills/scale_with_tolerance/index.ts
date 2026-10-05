// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// scale_with_tolerance: scale a part but keep its fastener holes and fits at
// their real sizes. Scaling down shrinks the holes, so they are opened back up
// with sx-geom `subtract`. Scaling up grows them, which needs material added
// back, so that case (and a host without subtract) returns the plan only.
import type { Cell, MeshPart } from '@slicerx/contracts'
import { z } from 'zod'
import { defineSkill } from '../../src/tool'
import { pickObject } from '../common'
import type { Vec3 } from '../orientation_search/geometry'
import { NO_GEOMETRY_NOTE, NO_MESH_NOTE, fmtSize, geomRun, objectGeometry, parseInfo, partFromGeom, placedBox, plateConfig, replaceGeometry, round, toGeomMesh } from '../geom_common/index'
import { HoleFeature, NO_SUBTRACT_NOTE, basisFor, cutHoles, fitCitations, placeHoles } from '../threads_and_fits/index'
import { holeFor, type HoleSpec } from '../threads_and_fits/sizes'

/** A copy of the parts scaled about the model origin. */
export function scaleParts(parts: MeshPart[], s: number): MeshPart[] {
  return parts.map((p) => ({ ...p, positions: Float32Array.from(p.positions, (v) => v * s) }))
}

export type ScaleCase = 'no_holes' | 'open_up' | 'grows'

/** What holding the holes takes at this scale. */
export function scaleCase(factor: number, holds: number): ScaleCase {
  if (holds === 0) return 'no_holes'
  return factor <= 1 ? 'open_up' : 'grows'
}

export const GROW_NOTE = 'Scaling up makes every hole larger than the fastener. Holding them needs material added back and the hole recut, and the geometry engine cannot add material yet, so nothing was changed. Scale the part, then fill and redrill the holes in a CAD tool, or print inserts sized for the larger holes.'

export function createScaleWithTolerance() {
  return defineSkill({
    name: 'scale_with_tolerance',
    version: '1.0.0',
    permission: 'slice',
    description:
      'Scale a part uniformly while holding its fastener holes and fits at their real sizes (heat-set inserts, tap holes, clearance holes, pin fits), then report the hole and contour compensation the printer needs. Give each hole to hold with its kind, size and the point where it starts on the surface as modeled before scaling. Scaling down reopens the holes by cutting them at full size again (needs a geometry build that can subtract); scaling up with holes to hold returns the plan only. Replaces the object geometry in the project when it applies the scale.',
    input: z.object({
      objectId: z.string().optional().describe('Object id or name; defaults to the first object in the project'),
      scalePct: z.number().min(10).max(1000).describe('Uniform scale in percent, such as 120'),
      hold: z.array(HoleFeature).max(24).default([]).describe('Holes to keep at their real size; positions as modeled before scaling'),
      material: z.string().optional().describe('Filament; default the loaded material'),
    }),
    args: (i) => [`--scale ${i.scalePct}%`, ...i.hold.map((h) => `--hold ${h.size ?? h.diameterMm ?? ''}`)].join(' '),
    async approval(i, ctx) {
      const obj = pickObject(ctx, i.objectId)
      return { title: `Scale ${obj?.name ?? 'the model'} to ${i.scalePct}%?`, lines: i.hold.length ? [`Hold ${i.hold.length} hole${i.hold.length === 1 ? '' : 's'} at real size`] : ['No holes held'], actions: [] }
    },
    async run(i, ctx) {
      const obj = pickObject(ctx, i.objectId)
      if (!obj) return { ok: false, summary: 'No object in the project' }
      const factor = i.scalePct / 100
      const basis = basisFor(ctx, obj.id, i.material)
      const specs = i.hold.map((f) => holeFor(f.kind, basis, { size: f.size, diameterMm: f.diameterMm, depthMm: f.depthMm }))
      const errors = specs.filter((s): s is { error: string } => 'error' in s).map((s) => s.error)
      const good = specs.filter((s): s is HoleSpec => !('error' in s))
      const kase = scaleCase(factor, good.length)
      const cite = fitCitations(ctx.kb)
      const cfg = plateConfig(ctx, obj.id)
      const comp = { hole: Number(cfg['xy_hole_compensation'] ?? 0) || 0, contour: Number(cfg['xy_contour_compensation'] ?? 0) || 0 }
      const compNote = comp.hole || comp.contour ? `The plate already uses hole compensation ${comp.hole} mm and contour compensation ${comp.contour} mm; they apply at any scale.` : 'No measured hole or contour compensation is set. Print the tolerance test once for this printer and spool and set xy_hole_compensation and xy_contour_compensation from it.'
      const notes: string[] = [...errors]
      const g = await objectGeometry(obj)
      let applied = false
      let size: [number, number, number] | null = null
      const plan = (why: string) => {
        notes.push(why)
      }
      if (!g) plan(NO_MESH_NOTE)
      else if (kase === 'grows') plan(GROW_NOTE)
      else if (kase === 'open_up' && !ctx.host.geom) plan(NO_GEOMETRY_NOTE)
      else {
        const scaled = scaleParts(g.parts, factor)
        let result: MeshPart[] = scaled
        let ok = true
        if (kase === 'open_up') {
          const mesh = toGeomMesh(scaled)
          const info = parseInfo(await geomRun(ctx, 'info', { mesh }))
          // Positions were given before scaling; move them with the part.
          const moved = i.hold.map((h) => (h.atMm ? { ...h, atMm: h.atMm.map((v) => v * factor) } : h))
          const placed = placeHoles(ctx, obj.id, moved, specs, info)
          if (placed.length < good.length) notes.push(`${good.length - placed.length} held hole${good.length - placed.length === 1 ? ' has' : 's have'} no position, so ${good.length - placed.length === 1 ? 'it was' : 'they were'} scaled with the part.`)
          if (placed.length) {
            const res = await cutHoles(ctx, mesh, placed)
            if (!res) {
              ok = false
              plan(NO_SUBTRACT_NOTE)
            } else {
              const part = partFromGeom(res.mesh, g.parts[0]?.name ?? obj.name, g.parts[0]?.slot ?? 1)
              if (!part) {
                ok = false
                plan('The hole cut returned no mesh, so nothing changed.')
              } else {
                result = [part]
                if (!res.watertight) notes.push('The part is not watertight after the cut; repair the mesh before slicing.')
              }
            }
          }
        }
        if (ok) {
          applied = await replaceGeometry(ctx.project, obj, result)
          if (!applied) notes.push('This project cannot swap geometry, so the scale was not applied.')
          size = placedBox(ctx.project, obj.id, result)
        }
      }
      notes.push(compNote)
      const before = obj.bboxMm
      const planned: Vec3 = [round(before[0] * factor, 1), round(before[1] * factor, 1), round(before[2] * factor, 1)]
      const rows: Cell[][] = good.map((s) => [s.label, `${round(s.modeledMm * factor, 2)} mm if scaled`, `${s.modeledMm} mm`, applied && kase === 'open_up' ? { text: 'held', tone: 'ok' } : { text: 'plan', tone: 'dim' }])
      return {
        summary: applied ? `Scaled ${obj.name} to ${i.scalePct}% (${fmtSize(size ?? planned)})${good.length ? `, ${good.length} hole${good.length === 1 ? '' : 's'} held at real size` : ''}` : `Plan only: ${obj.name} at ${i.scalePct}% is ${fmtSize(planned)}; ${kase === 'grows' ? 'holes cannot be held when scaling up' : 'holes could not be recut here'}`,
        output: {
          objectId: obj.id,
          scalePct: i.scalePct,
          applied,
          sizeMm: size ?? planned,
          held: good.map((s) => ({ label: s.label, modeledMm: s.modeledMm, scaledWouldBeMm: round(s.modeledMm * factor, 2) })),
          compensation: comp,
          notes,
        },
        display: [
          { kind: 'kv', rows: [['scale', `${i.scalePct}%`], ['size', fmtSize(size ?? planned)], ['applied', applied ? { text: 'yes', tone: 'ok' } : { text: 'no, plan only', tone: 'warn' }]] },
          ...(rows.length ? [{ kind: 'table' as const, head: ['hole', 'scaled', 'held at', 'status'], rows }] : []),
          { kind: 'text', text: notes.join(' ') },
        ],
        citations: cite.citations,
      }
    },
  })
}
