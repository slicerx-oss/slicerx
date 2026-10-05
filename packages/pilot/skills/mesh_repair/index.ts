// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mesh_repair: weld, drop degenerate and duplicate faces, fix winding and
// fill holes with sx-geom, then swap the repaired geometry into the project.
// Each part of a multi-part object is repaired on its own so filament slots stay.
import type { Cell, MeshPart } from '@slicerx/contracts'
import { z } from 'zod'
import { defineSkill } from '../../src/tool'
import { pickObject } from '../common'
import { NO_MESH_NOTE, cm3, geomRun, meshInfo, needsGeometry, num, objectGeometry, partFromGeom, rec, replaceGeometry, toGeomMesh, type MeshInfo } from '../geom_common/index'

export interface RepairCounts {
  verticesMerged: number
  degenerateRemoved: number
  duplicatesRemoved: number
  trianglesFlipped: number
  holesFilled: number
  holesLeftOpen: number
}

export function addCounts(a: RepairCounts, r: Record<string, unknown>): RepairCounts {
  return {
    verticesMerged: a.verticesMerged + num(r['verticesMerged']),
    degenerateRemoved: a.degenerateRemoved + num(r['degenerateRemoved']),
    duplicatesRemoved: a.duplicatesRemoved + num(r['duplicatesRemoved']),
    trianglesFlipped: a.trianglesFlipped + num(r['trianglesFlipped']),
    holesFilled: a.holesFilled + num(r['holesFilled']),
    holesLeftOpen: a.holesLeftOpen + num(r['holesLeftOpen']),
  }
}

/** Fixes worth reporting, in plain words. Welding alone is not a fix the user sees. */
export function fixesOf(c: RepairCounts): string[] {
  const out: string[] = []
  if (c.holesFilled) out.push(`filled ${c.holesFilled} hole${c.holesFilled === 1 ? '' : 's'}`)
  if (c.trianglesFlipped) out.push(`flipped ${c.trianglesFlipped} triangle${c.trianglesFlipped === 1 ? '' : 's'} to face outward`)
  if (c.degenerateRemoved) out.push(`removed ${c.degenerateRemoved} zero-area triangle${c.degenerateRemoved === 1 ? '' : 's'}`)
  if (c.duplicatesRemoved) out.push(`removed ${c.duplicatesRemoved} duplicate face${c.duplicatesRemoved === 1 ? '' : 's'}`)
  if (c.verticesMerged) out.push(`merged ${c.verticesMerged} loose vertices`)
  return out
}

const defects = (m: MeshInfo): number => m.openEdges + m.flippedEdges + m.nonManifoldEdges

/** Did the repair change anything worth replacing the geometry for? */
export function changed(before: MeshInfo, after: MeshInfo, c: RepairCounts): boolean {
  return c.holesFilled + c.trianglesFlipped + c.degenerateRemoved + c.duplicatesRemoved + c.verticesMerged > 0 || before.openEdges !== after.openEdges || before.flippedEdges !== after.flippedEdges
}

/**
 * Keep the repair only when it leaves the mesh no worse: welding shells that
 * merely touch can turn a clean mesh into one with shared edges.
 */
export function improves(before: MeshInfo, after: MeshInfo, c: RepairCounts): boolean {
  if (!changed(before, after, c)) return false
  if (before.watertight && !after.watertight) return false
  return defects(after) <= defects(before)
}

const stateCell = (m: MeshInfo): Cell => (m.watertight ? { text: 'watertight', tone: 'ok' } : { text: 'not watertight', tone: 'warn' })

export function createMeshRepair() {
  return defineSkill({
    name: 'mesh_repair',
    version: '1.0.0',
    permission: 'slice',
    description:
      'Repair an object mesh before slicing: merge loose vertices, remove zero-area and duplicate triangles, flip inward-facing triangles and fill holes. Replaces the object geometry in the project (same object, plates kept) and reports open edges, flipped edges, shells and volume before and after. Needs geometry on the host.',
    input: z.object({
      objectId: z.string().optional().describe('Object id or name; defaults to the first object in the project'),
      maxHoleEdges: z.number().int().min(3).max(10000).optional().describe('Holes with more boundary edges than this stay open (default 64)'),
    }),
    args: (i) => [i.objectId ?? null, i.maxHoleEdges ? `--max-hole-edges ${i.maxHoleEdges}` : null].filter(Boolean).join(' '),
    async approval(i, ctx) {
      const obj = pickObject(ctx, i.objectId)
      return { title: `Replace ${obj?.name ?? 'the model'} with its repaired mesh?`, lines: ['The object stays on its plates; only its triangles change.'], actions: [] }
    },
    async run(i, ctx) {
      if (!ctx.host.geom) return needsGeometry('Mesh repair')
      const obj = pickObject(ctx, i.objectId)
      if (!obj) return { ok: false, summary: 'No object in the project' }
      const g = await objectGeometry(obj)
      if (!g) return { ok: false, summary: `No mesh for ${obj.name}`, output: { note: NO_MESH_NOTE } }
      const before = await meshInfo(ctx, g.mesh)
      let counts: RepairCounts = { verticesMerged: 0, degenerateRemoved: 0, duplicatesRemoved: 0, trianglesFlipped: 0, holesFilled: 0, holesLeftOpen: 0 }
      const repaired: MeshPart[] = []
      for (const [k, p] of g.parts.entries()) {
        ctx.progress(`repairing ${p.name}`, k / g.parts.length)
        const res = await geomRun(ctx, 'repair', { mesh: toGeomMesh([p]), options: i.maxHoleEdges ? { maxHoleEdges: i.maxHoleEdges } : {} })
        const part = partFromGeom(res['mesh'], p.name, p.slot)
        if (!part) return { ok: false, summary: `Repair of ${p.name} returned no mesh` }
        repaired.push(part)
        counts = addCounts(counts, rec(res['report']))
      }
      const after = await meshInfo(ctx, toGeomMesh(repaired))
      const did = improves(before, after, counts)
      const replacedIt = did ? await replaceGeometry(ctx.project, obj, repaired) : false
      const fixes = did ? fixesOf(counts) : []
      // What the project holds now: the repair when kept, else the original.
      const final = did ? after : before
      const rows: Cell[][] = [
        ['state', stateCell(before), stateCell(final)],
        ['open edges', String(before.openEdges), final.openEdges ? { text: String(final.openEdges), tone: 'warn' } : { text: '0', tone: 'ok' }],
        ['flipped edges', String(before.flippedEdges), String(final.flippedEdges)],
        ['non-manifold edges', String(before.nonManifoldEdges), String(final.nonManifoldEdges)],
        ['shells', String(before.components), String(final.components)],
        ['volume', `${cm3(before.volumeMm3)} cm3`, `${cm3(final.volumeMm3)} cm3`],
        ['triangles', String(before.triangles), String(final.triangles)],
      ]
      const notes: string[] = []
      if (did && counts.holesLeftOpen) notes.push(`${counts.holesLeftOpen} hole${counts.holesLeftOpen === 1 ? ' is' : 's are'} larger than the fill limit and stay open; raise maxHoleEdges or fix it in the model.`)
      if (final.nonManifoldEdges) notes.push('Some edges are shared by more than two triangles; the slicer may still warn about them.')
      if (did && !replacedIt) notes.push('This project cannot swap geometry, so the repaired mesh was not applied.')
      if (!did && changed(before, after, counts)) notes.push('The repair would not leave the mesh better than it is, so the original was kept.')
      const summary = !did
        ? `${obj.name} kept as is (${before.watertight ? `already watertight${before.components > 1 ? `, ${before.components} shells` : ''}` : `${before.openEdges} open edges the repair could not close`})`
        : `${obj.name}: ${fixes.slice(0, 2).join(', ') || 'cleaned up'}; ${final.watertight ? 'now watertight' : `${final.openEdges} open edges left`}`
      return {
        summary,
        output: {
          objectId: obj.id,
          replaced: replacedIt,
          fixes,
          before: { watertight: before.watertight, openEdges: before.openEdges, flippedEdges: before.flippedEdges, nonManifoldEdges: before.nonManifoldEdges, shells: before.components, volumeCm3: cm3(before.volumeMm3) },
          after: { watertight: final.watertight, openEdges: final.openEdges, flippedEdges: final.flippedEdges, nonManifoldEdges: final.nonManifoldEdges, shells: final.components, volumeCm3: cm3(final.volumeMm3) },
          ...(notes.length ? { notes } : {}),
        },
        display: [{ kind: 'table', head: ['', 'before', 'after'], rows }, ...(fixes.length || notes.length ? [{ kind: 'text' as const, text: [...fixes.map((f) => `${f[0]?.toUpperCase()}${f.slice(1)}.`), ...notes].join(' ') }] : [])],
      }
    },
  })
}
