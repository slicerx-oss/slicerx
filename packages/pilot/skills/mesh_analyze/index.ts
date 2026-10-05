// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mesh_analyze: measure an object as it sits on the bed now. Volume, area,
// size, open edges and shells from sx-geom info, then overhang area, support
// volume and bed contact from orient.analyze at the current rotation.
import type { Cell } from '@slicerx/contracts'
import { z } from 'zod'
import { defineSkill } from '../../src/tool'
import { pickObject } from '../common'
import { currentRotation } from '../orientation_search/geometry'
import { NO_MESH_NOTE, cm2, cm3, densityOf, fmtSize, geomRun, meshInfo, needsGeometry, objectGeometry, parseOrient, printNumbers, round, type MeshInfo, type OrientMeasure } from '../geom_common/index'

export interface MeshAnalysis {
  objectId: string
  name: string
  info: MeshInfo
  orient: OrientMeasure
  rotate: [number, number, number]
  solidGrams: number
}

/** One line for the folded row. */
export function analysisLine(a: MeshAnalysis): string {
  const shape = a.info.watertight ? 'watertight' : `${a.info.openEdges} open edges`
  const support = a.orient.overhangAreaMm2 > 50 ? `${cm2(a.orient.overhangAreaMm2)} cm2 overhang` : 'no real overhang'
  return `${a.name}: ${fmtSize(a.info.sizeMm)}, ${cm3(a.info.volumeMm3)} cm3, ${shape}, ${support}`
}

export function createMeshAnalyze() {
  return defineSkill({
    name: 'mesh_analyze',
    version: '1.0.0',
    permission: 'read',
    description:
      'Measure an object as it sits on the bed now: volume, surface area, size, whether it is watertight (open, flipped and non-manifold edges, separate shells), overhang area past the support angle, estimated support volume and bed contact area. Read only. Use it before repairing, hollowing, orienting or quoting a part.',
    input: z.object({
      objectId: z.string().optional().describe('Object id or name; defaults to the first object in the project'),
      supportAngle: z.number().min(10).max(80).optional().describe('Overhang angle that needs support, degrees (default 45)'),
    }),
    args: (i) => [i.objectId ?? null, i.supportAngle ? `--support-angle ${i.supportAngle}` : null].filter(Boolean).join(' '),
    async run(i, ctx) {
      if (!ctx.host.geom) return needsGeometry('Mesh analysis')
      const obj = pickObject(ctx, i.objectId)
      if (!obj) return { ok: false, summary: 'No object in the project' }
      const g = await objectGeometry(obj)
      if (!g) return { ok: false, summary: `No mesh for ${obj.name}`, output: { note: NO_MESH_NOTE } }
      const rotate = ctx.project ? currentRotation(ctx.project, obj.id) : ([0, 0, 0] as [number, number, number])
      const info = await meshInfo(ctx, g.mesh)
      const orient = parseOrient(await geomRun(ctx, 'orient.analyze', { mesh: g.mesh, orientation: { eulerDeg: rotate }, options: { overhangAngleDeg: i.supportAngle ?? 45 } }))
      const nums = printNumbers(ctx, obj.id)
      const dens = densityOf(ctx.kb, nums.material)
      const a: MeshAnalysis = { objectId: obj.id, name: obj.name, info, orient, rotate, solidGrams: round((info.volumeMm3 / 1000) * dens.gPerCm3, 1) }
      const rows: [string, Cell][] = [
        ['size as modeled', fmtSize(info.sizeMm)],
        ['volume', `${cm3(info.volumeMm3)} cm3 (${a.solidGrams} g if solid)`],
        ['surface', `${cm2(info.areaMm2)} cm2, ${info.triangles} triangles`],
        ['watertight', info.watertight ? { text: 'yes', tone: 'ok' } : { text: `no: ${info.openEdges} open, ${info.flippedEdges} flipped, ${info.nonManifoldEdges} non-manifold edges`, tone: 'warn' }],
        ['shells', info.components > 1 ? { text: `${info.components} separate shells`, tone: 'dim' } : '1'],
        ['rotation', rotate.some((d) => d !== 0) ? `${rotate.join(', ')} deg` : 'as modeled'],
        ['overhang', orient.overhangAreaMm2 > 50 ? { text: `${cm2(orient.overhangAreaMm2)} cm2 past ${i.supportAngle ?? 45} deg`, tone: 'warn' } : { text: 'none to speak of', tone: 'ok' }],
        ['support volume', `${cm3(orient.supportVolumeMm3)} cm3 (estimate, support everywhere)`],
        ['bed contact', `${cm2(orient.bedContactAreaMm2)} cm2`],
        ['height on the bed', `${round(orient.heightMm, 1)} mm`],
      ]
      return {
        summary: analysisLine(a),
        output: {
          objectId: obj.id,
          sizeMm: info.sizeMm,
          volumeCm3: cm3(info.volumeMm3),
          areaCm2: cm2(info.areaMm2),
          triangles: info.triangles,
          watertight: info.watertight,
          openEdges: info.openEdges,
          flippedEdges: info.flippedEdges,
          nonManifoldEdges: info.nonManifoldEdges,
          shells: info.components,
          rotate,
          overhangCm2: cm2(orient.overhangAreaMm2),
          supportVolumeCm3: cm3(orient.supportVolumeMm3),
          supportContactCm2: cm2(orient.supportContactAreaMm2),
          bedContactCm2: cm2(orient.bedContactAreaMm2),
          heightMm: round(orient.heightMm, 1),
          solidGrams: a.solidGrams,
          ...(dens.fromKb ? {} : { note: `No density for ${nums.material} in the knowledge base; grams use 1.24 g/cm3.` }),
        },
        display: [{ kind: 'kv', rows }],
        ...(dens.fromKb ? { citations: ctx.kb.cite(dens.sources) } : {}),
      }
    },
  })
}
