// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Picks the rotation with the least support. With geometry on the host,
// sx-geom ranks candidate rotations by support volume, overhang area, height
// and bed contact. Without it, the six axis rotations are scored here by
// overhang area (faces steeper than the support angle that are not on the
// bed), breaking ties by bed contact. Either result can be applied.
import type { Cell, MeshPart } from '@slicerx/contracts'
import { z } from 'zod'
import { defineSkill } from '../../src/tool'
import { pickObject, round } from '../common'
import { AXIS_ORIENTATIONS, FACE_DIRS, FACE_NAMES, eulerOf, type Vec3 } from '../orientation_search/geometry'
import { arr, cm2, cm3, geomRun, objectGeometry, parseOrient, rec, type OrientMeasure } from '../geom_common/index'

/** Rotations that put each of the six axis directions down. Maps a vertex (x,y,z) to its rotated form. */
const ROTATIONS: { name: string; f: (x: number, y: number, z: number) => [number, number, number] }[] = [
  { name: 'as modeled', f: (x, y, z) => [x, y, z] },
  { name: 'upside down', f: (x, y, z) => [x, -y, -z] },
  { name: 'on its front', f: (x, y, z) => [x, z, -y] },
  { name: 'on its back', f: (x, y, z) => [x, -z, y] },
  { name: 'on its left side', f: (x, y, z) => [z, y, -x] },
  { name: 'on its right side', f: (x, y, z) => [-z, y, x] },
]

export interface OrientScore {
  name: string
  overhangCm2: number
  contactCm2: number
  heightMm: number
  maxOverhangDeg: number
}

export function scoreOrientations(parts: MeshPart[], supportAngleDeg = 45): OrientScore[] {
  const cosLimit = Math.cos(((90 - supportAngleDeg) * Math.PI) / 180)
  return ROTATIONS.map((r) => {
    let minZ = Infinity
    let maxZ = -Infinity
    for (const p of parts) {
      for (let v = 0; v + 2 < p.positions.length; v += 3) {
        const z = r.f(p.positions[v] ?? 0, p.positions[v + 1] ?? 0, p.positions[v + 2] ?? 0)[2]
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }
    }
    let overhang = 0
    let contact = 0
    let steepest = 0
    for (const p of parts) {
      const P = p.positions
      const I = p.indices
      for (let t = 0; t + 2 < I.length; t += 3) {
        const ia = (I[t] ?? 0) * 3
        const ib = (I[t + 1] ?? 0) * 3
        const ic = (I[t + 2] ?? 0) * 3
        const a = r.f(P[ia] ?? 0, P[ia + 1] ?? 0, P[ia + 2] ?? 0)
        const b = r.f(P[ib] ?? 0, P[ib + 1] ?? 0, P[ib + 2] ?? 0)
        const c = r.f(P[ic] ?? 0, P[ic + 1] ?? 0, P[ic + 2] ?? 0)
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
        const len = Math.hypot(nx, ny, nz)
        if (len === 0) continue
        const area = len / 2
        const down = -nz / len
        const low = Math.max(a[2], b[2], c[2]) - minZ < 0.2
        if (down > 0.999 && low) contact += area
        else if (down > cosLimit && !low) {
          overhang += area
          const deg = 90 - (Math.acos(Math.min(1, down)) * 180) / Math.PI
          if (deg > steepest) steepest = deg
        }
      }
    }
    return { name: r.name, overhangCm2: round(overhang / 100, 1), contactCm2: round(contact / 100, 1), heightMm: round(maxZ - minZ, 1), maxOverhangDeg: round(90 - steepest, 0) }
  })
}

/** Name of a rotation by the model face that ends up on the bed. */
export function rotationName(matrix: number[][]): string {
  // The model direction that points down after the rotation: M^T (0, 0, -1).
  const down: Vec3 = [-(matrix[2]?.[0] ?? 0), -(matrix[2]?.[1] ?? 0), -(matrix[2]?.[2] ?? 0)]
  let best = { face: 'bottom', dot: -2 }
  for (const f of FACE_NAMES) {
    const d = FACE_DIRS[f]
    const dot = d[0] * down[0] + d[1] * down[1] + d[2] * down[2]
    if (dot > best.dot) best = { face: f, dot }
  }
  const name = best.dot > 0.999 ? `${best.face} down` : `tilted, ${best.face} side toward the bed`
  const turned = best.dot > 0.999 && best.face === 'bottom' && Math.abs((matrix[0]?.[0] ?? 1) - 1) > 1e-6 ? ', turned' : ''
  return name === 'bottom down' && !turned ? 'bottom down (as modeled)' : `${name}${turned}`
}

export interface RankedRotation {
  name: string
  rotate: [number, number, number]
  measure: OrientMeasure
}

export function createOrient() {
  return defineSkill({
    name: 'orient',
    version: '1.4.0',
    permission: 'slice',
    description:
      'Find the rotation with the least support (support volume and overhang area beyond the support angle) and good bed contact for an object, and apply it when apply is true. Changes only the project.',
    input: z.object({
      objectId: z.string().optional(),
      minSupports: z.boolean().optional(),
      supportAngle: z.number().min(10).max(80).optional().describe('Overhang angle that needs support, degrees (default 45)'),
      apply: z.boolean().optional().describe('Set the best rotation on the object in the project'),
    }),
    args: (i) => [i.minSupports !== false ? '--min-supports' : null, i.apply ? '--apply' : null, i.objectId ?? null].filter(Boolean).join(' '),
    async run(i, ctx) {
      const obj = pickObject(ctx, i.objectId)
      if (!obj) return { ok: false, summary: 'No object in the project' }
      if (!obj.mesh) {
        const [x, y, z] = obj.bboxMm
        return {
          summary: `Kept as modeled, ${round(z, 0)} mm tall (no mesh access)`,
          output: { rotation: 'as modeled', note: 'Mesh data is not available to mimir on this host, so only the bounding box was checked.', bboxMm: [x, y, z] },
        }
      }
      const angle = i.supportAngle ?? 45
      if (ctx.host.geom) {
        const g = await objectGeometry(obj)
        if (g) {
          const res = await geomRun(ctx, 'orient.rank', { mesh: g.mesh, options: { overhangAngleDeg: angle }, maxCandidates: 12 })
          const ranked: RankedRotation[] = arr(res['ranked']).map((r) => {
            const m = parseOrient(rec(r))
            return { name: rotationName(m.matrix), rotate: eulerOf(m.matrix), measure: m }
          })
          const best = ranked[0]
          if (!best) return { ok: false, summary: 'Could not rank rotations for the mesh' }
          const needs = best.measure.supportVolumeMm3 > 500 || best.measure.overhangAreaMm2 > 50
          let applied = false
          if (i.apply && ctx.project?.setRotation) {
            ctx.project.setRotation(obj.id, best.rotate, best.name)
            applied = true
          }
          const rows: Cell[][] = ranked.slice(0, 6).map((r, k) => [k === 0 ? { text: r.name, tone: 'ok' } : r.name, `${cm3(r.measure.supportVolumeMm3)} cm3`, `${cm2(r.measure.overhangAreaMm2)} cm2`, `${cm2(r.measure.bedContactAreaMm2)} cm2`, `${round(r.measure.heightMm, 0)} mm`])
          return {
            summary: `${best.name[0]?.toUpperCase()}${best.name.slice(1)}, ${needs ? `about ${cm3(best.measure.supportVolumeMm3)} cm3 of support` : 'no supports needed'}${applied ? ', applied' : ''}`,
            output: {
              rotation: best.name,
              rotate: best.rotate,
              applied,
              supportVolumeCm3: cm3(best.measure.supportVolumeMm3),
              overhangCm2: cm2(best.measure.overhangAreaMm2),
              contactCm2: cm2(best.measure.bedContactAreaMm2),
              heightMm: round(best.measure.heightMm, 1),
              candidates: ranked.slice(0, 8).map((r) => ({ name: r.name, rotate: r.rotate, supportVolumeCm3: cm3(r.measure.supportVolumeMm3), overhangCm2: cm2(r.measure.overhangAreaMm2), contactCm2: cm2(r.measure.bedContactAreaMm2), heightMm: round(r.measure.heightMm, 1) })),
              ...(i.apply && !applied ? { note: 'This project cannot set rotations, so the rotation was not applied.' } : {}),
            },
            display: [{ kind: 'table', head: ['rotation', 'support', 'overhang', 'bed contact', 'height'], rows }],
          }
        }
      }
      const parts = await obj.mesh()
      const scores = scoreOrientations(parts, angle)
      const best = [...scores].sort((a, b) => a.overhangCm2 - b.overhangCm2 || b.contactCm2 - a.contactCm2)[0]
      if (!best) return { ok: false, summary: 'Could not score the mesh' }
      const needs = best.overhangCm2 > 0.5
      const rotate = AXIS_ORIENTATIONS.find((o) => o.orientName === best.name)?.rotate ?? [0, 0, 0]
      let applied = false
      if (i.apply && ctx.project?.setRotation) {
        ctx.project.setRotation(obj.id, rotate, best.name)
        applied = true
      }
      return {
        summary: `${best.name[0]?.toUpperCase()}${best.name.slice(1)}, ${needs ? `${best.overhangCm2} cm2 needs support` : 'no supports needed'}${applied ? ', applied' : ''}`,
        output: { rotation: best.name, rotate, applied, candidates: scores },
        display: [
          { kind: 'kv', rows: [['rotation', best.name], ['overhang', `${best.overhangCm2} cm2 past ${angle} deg`], ['supports', needs ? { text: 'needed', tone: 'warn' } : { text: 'none needed', tone: 'ok' }], ['bed contact', `${best.contactCm2} cm2`]] },
        ],
      }
    },
  })
}
