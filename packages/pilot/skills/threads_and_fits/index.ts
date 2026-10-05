// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// threads_and_fits: size holes for heat-set inserts, tapping, bolts and pin
// fits for this printer, nozzle and material, and cut them into the part with
// sx-geom `subtract` when the host has it. Without it, returns the sizes to model.
import type { Cell, Citation } from '@slicerx/contracts'
import { z } from 'zod'
import type { KnowledgeBase } from '../../src/kb/kb'
import { defineSkill, type ToolContext } from '../../src/tool'
import { pickObject } from '../common'
import { FACE_NAMES, type FaceDir, type Vec3 } from '../orientation_search/geometry'
import { NO_GEOMETRY_NOTE, NO_MESH_NOTE, faceNormal, geomTry, holeSolid, meshInfo, num, objectGeometry, partFromGeom, plateConfig, printNumbers, reachAlong, replaceGeometry, round, type GeomMesh, type GeomSolid } from '../geom_common/index'
import { HOLE_KINDS, SIZE_BASIS, holeFor, type HoleSpec, type PrintBasis } from './sizes'

export const NO_SUBTRACT_NOTE = 'This geometry build has no subtract operation yet, so mimir cannot cut holes into the mesh. Model the holes at the sizes listed.'

export const HoleFeature = z.object({
  kind: z.enum(HOLE_KINDS).describe('insert: heat-set insert; tap: hole to tap a thread; thread: same as tap (printed threads are not modeled); clearance: bolt passes through; countersunk: clearance with a countersink; press_fit and slip_fit: a hole for a shaft or pin'),
  size: z.string().optional().describe('Metric size such as "M3", for inserts, tap, thread, clearance and countersunk holes'),
  diameterMm: z.number().positive().max(100).optional().describe('Shaft or pin diameter in mm, for press and slip fits'),
  atMm: z.array(z.number()).length(3).optional().describe('Where the hole starts on the surface, model coordinates in mm; without it only the size is returned'),
  face: z.enum(FACE_NAMES as [FaceDir, ...FaceDir[]]).optional().describe('Face the hole goes into, as the part sits on the bed; the hole runs straight in. Default top'),
  depthMm: z.number().positive().max(500).optional().describe('Blind depth in mm; default through, or insert length plus 1 mm for inserts'),
})
export type HoleFeatureInput = z.infer<typeof HoleFeature>

/** Printing numbers for hole sizing, with any hole compensation already on the plate. */
export function basisFor(ctx: ToolContext, objectId: string | undefined, material?: string): PrintBasis {
  const n = printNumbers(ctx, objectId)
  const v = plateConfig(ctx, objectId)['xy_hole_compensation']
  const comp = Number(Array.isArray(v) ? v[0] : v) || 0
  return { material: material ?? n.material, lineWidth: n.lineWidth, layerHeight: n.layerHeight, nozzle: n.nozzle, holeCompensation: comp }
}

/** Citations for the tolerance and dimensional accuracy knowledge the sizing follows. */
export function fitCitations(kb: KnowledgeBase): { citations: Citation[]; ids: string[] } {
  const docs = [kb.get('workflow', 'tolerance'), kb.get('intent', 'dimensional_accuracy')].filter((d) => d !== undefined)
  const ids = [...new Set(docs.flatMap((d) => d.sources.slice(0, 3)))]
  return { citations: kb.cite(ids), ids }
}

export interface PlacedHole {
  spec: HoleSpec
  point: Vec3
  inward: Vec3
  depthMm: number
}

/** The solids to subtract for placed holes; through holes reach past the far side of the part. */
export function holeSolids(holes: PlacedHole[]): GeomSolid[] {
  return holes.map((h) => holeSolid(h.point, h.inward, h.spec.modeledMm, h.depthMm, h.spec.countersink))
}

/** Places each feature that has a position; through holes get their depth from the part's bounds. */
export function placeHoles(ctx: ToolContext, objectId: string, features: HoleFeatureInput[], specs: (HoleSpec | { error: string })[], bounds: { min: Vec3; max: Vec3 }): PlacedHole[] {
  const out: PlacedHole[] = []
  features.forEach((f, k) => {
    const spec = specs[k]
    if (!spec || 'error' in spec || !f.atMm) return
    const n = faceNormal(ctx.project, objectId, f.face ?? 'top')
    const inward: Vec3 = [-n[0], -n[1], -n[2]]
    const point: Vec3 = [f.atMm[0] ?? 0, f.atMm[1] ?? 0, f.atMm[2] ?? 0]
    const depth = spec.depthMm ?? round(reachAlong(bounds.min, bounds.max, point, inward) + 1, 2)
    out.push({ spec, point, inward, depthMm: depth })
  })
  return out
}

/** Cuts holes with sx-geom subtract. Null when this build has no subtract. */
export async function cutHoles(ctx: ToolContext, mesh: GeomMesh, holes: PlacedHole[]): Promise<{ mesh: unknown; watertight: boolean; volumeMm3: number } | null> {
  const res = await geomTry(ctx, 'subtract', { mesh, solids: holeSolids(holes) })
  if (!res) return null
  return { mesh: res['mesh'], watertight: res['watertight'] === true, volumeMm3: num(res['volumeMm3']) }
}

export function createThreadsAndFits() {
  return defineSkill({
    name: 'threads_and_fits',
    version: '1.0.0',
    permission: 'slice',
    description:
      'Size holes for heat-set inserts, tapping, bolt clearance (plain or countersunk) and press or slip fits on pins and shafts, corrected for how much printed holes close up with this nozzle, line width, layer height and material. With a surface point for a hole and a geometry build that can subtract, cuts the holes into the part in the project; otherwise returns the diameters and depths to model. Printed threads are not modeled: thread requests get a tap hole.',
    input: z.object({
      objectId: z.string().optional().describe('Object id or name; defaults to the first object in the project'),
      material: z.string().optional().describe('Filament; default the loaded material'),
      features: z.array(HoleFeature).min(1).max(24),
    }),
    args: (i) => i.features.map((f) => `--${f.kind.replace('_', '-')} ${f.size ?? f.diameterMm ?? ''}${f.atMm ? `@${f.atMm.join(',')}` : ''}`).join(' '),
    async approval(i, ctx) {
      const obj = pickObject(ctx, i.objectId)
      const n = i.features.filter((f) => f.atMm).length
      return { title: n ? `Cut ${n} hole${n === 1 ? '' : 's'} into ${obj?.name ?? 'the model'}?` : 'Size the holes?', lines: i.features.map((f) => `${f.kind.replace('_', ' ')} ${f.size ?? `${f.diameterMm ?? ''} mm`}`), actions: [] }
    },
    async run(i, ctx) {
      const obj = pickObject(ctx, i.objectId)
      const basis = basisFor(ctx, obj?.id, i.material)
      const specs = i.features.map((f) => holeFor(f.kind, basis, { size: f.size, diameterMm: f.diameterMm, depthMm: f.depthMm }))
      const good = specs.filter((s): s is HoleSpec => !('error' in s))
      const errors = specs.filter((s): s is { error: string } => 'error' in s).map((s) => s.error)
      if (good.length === 0) return { ok: false, summary: errors[0] ?? 'No hole to size', output: { errors } }
      const cite = fitCitations(ctx.kb)
      const notes: string[] = []
      let cut = 0
      let watertight: boolean | null = null
      const wantsCut = i.features.some((f, k) => f.atMm && !('error' in (specs[k] ?? { error: '' })))
      if (wantsCut) {
        if (!ctx.host.geom) notes.push(NO_GEOMETRY_NOTE)
        else if (!obj) notes.push('No object in the project to cut into.')
        else {
          const g = await objectGeometry(obj)
          if (!g) notes.push(NO_MESH_NOTE)
          else {
            const info = await meshInfo(ctx, g.mesh)
            const placed = placeHoles(ctx, obj.id, i.features, specs, info)
            const res = await cutHoles(ctx, g.mesh, placed)
            if (!res) notes.push(NO_SUBTRACT_NOTE)
            else {
              const part = partFromGeom(res.mesh, g.parts[0]?.name ?? obj.name, g.parts[0]?.slot ?? 1)
              if (!part) notes.push('The hole cut returned no mesh, so nothing changed.')
              else if (await replaceGeometry(ctx.project, obj, [part])) {
                cut = placed.length
                watertight = res.watertight
                if (!res.watertight) notes.push('The part is not watertight after the cut; repair the mesh before slicing.')
              } else notes.push('This project cannot swap geometry, so the holes were not applied.')
            }
          }
        }
      }
      if (i.features.some((f) => f.kind === 'thread')) notes.push('Printed threads are not modeled. The thread is a tap hole: tap it by hand, or use a heat-set insert where the screw goes in and out often.')
      notes.push(...errors)
      const rows: Cell[][] = specs.map((s, k) => {
        const f = i.features[k]
        if ('error' in s) return [f?.kind ?? '', { text: s.error, tone: 'bad' }, '', '', '']
        const where = f?.atMm ? (cut ? { text: 'cut', tone: 'ok' as const } : { text: 'size only', tone: 'dim' as const }) : { text: 'no position', tone: 'dim' as const }
        return [s.label, `${s.targetMm} mm`, `${s.modeledMm} mm${s.countersink ? `, head ${s.countersink.headMm} mm` : ''}`, s.depthMm !== undefined ? `${s.depthMm} mm` : 'through', where]
      })
      return {
        summary: cut ? `Cut ${cut} hole${cut === 1 ? '' : 's'} into ${obj?.name ?? 'the part'}: ${good.map((s) => `${s.label} at ${s.modeledMm} mm`).slice(0, 2).join(', ')}` : `Hole sizes: ${good.map((s) => `${s.label} ${s.modeledMm} mm`).slice(0, 3).join(', ')}${wantsCut ? ' (not cut)' : ''}`,
        output: {
          objectId: obj?.id ?? null,
          holes: good.map((s) => ({ label: s.label, kind: s.kind, targetMm: s.targetMm, modeledMm: s.modeledMm, ...(s.depthMm !== undefined ? { depthMm: s.depthMm } : { through: true }), ...(s.countersink ? { countersink: s.countersink } : {}), why: s.why })),
          cut,
          ...(watertight !== null ? { watertight } : {}),
          basis: { ...basis, sizes: SIZE_BASIS },
          ...(notes.length ? { notes } : {}),
        },
        display: [{ kind: 'table', head: ['hole', 'finished', 'model at', 'depth', 'status'], rows }, ...(notes.length ? [{ kind: 'text' as const, text: notes.join(' ') }] : [])],
        citations: cite.citations,
      }
    },
  })
}
