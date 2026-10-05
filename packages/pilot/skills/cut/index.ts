// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Fit planning for a model that is too big: compare scaling down with
// splitting, then split it. With geometry on the host, sx-geom cuts the mesh
// into watertight parts with connectors (split to fit the build volume, or one
// cut at a given height) and the parts replace the object. Without geometry,
// the split is recorded from the bounding box only, and the output says so.
import type { Cell, MeshPart } from '@slicerx/contracts'
import { z } from 'zod'
import type { ProjectObject } from '../../src/project'
import { defineSkill, type ToolContext } from '../../src/tool'
import { buildVolume, pickObject, round, type BuildVolume } from '../common'
import { fitsVolume } from '../printer_match/index'
import { arr, cm3, geomRun, meshInfo, newObject, num, objectGeometry, partFromGeom, rec, toGeomMesh, type GeomMesh } from '../geom_common/index'

export type ConnectorChoice = 'dovetail' | 'pins' | 'pin' | 'dowel' | 'none'

/** sx-geom connector for a choice; null for none. */
export function connectorSpec(c: ConnectorChoice | undefined): { kind: 'dovetail' | 'pin' | 'dowel' } | null {
  const k = c ?? 'dovetail'
  if (k === 'none') return null
  return { kind: k === 'pins' ? 'pin' : k }
}

interface CutPart {
  obj: ProjectObject
  part: MeshPart
  sizeMm: [number, number, number]
  rotateZ90: boolean
  extra: boolean
}

/** Parts from a split or cut response, named after the object: A, B, C... and connector pieces. */
function partsFrom(obj: ProjectObject, slot: number, pieces: { mesh: unknown; rotateZ90?: boolean }[], extras: unknown[]): CutPart[] {
  const out: CutPart[] = []
  const letter = (k: number): string => (k < 26 ? String.fromCharCode(65 + k) : String(k + 1))
  pieces.forEach((p, k) => {
    const part = partFromGeom(p.mesh, `${obj.name} ${letter(k)}`, slot)
    if (!part) return
    const o = newObject(`${obj.id}-${letter(k).toLowerCase()}`, part.name, [part])
    out.push({ obj: o, part, sizeMm: o.bboxMm, rotateZ90: p.rotateZ90 === true, extra: false })
  })
  extras.forEach((e, k) => {
    const part = partFromGeom(e, `${obj.name} connector ${k + 1}`, slot)
    if (!part) return
    const o = newObject(`${obj.id}-connector-${k + 1}`, part.name, [part])
    out.push({ obj: o, part, sizeMm: o.bboxMm, rotateZ90: false, extra: true })
  })
  return out
}

async function geometrySplit(ctx: ToolContext, mesh: GeomMesh, vol: BuildVolume, connector: ReturnType<typeof connectorSpec>, planeZ: number | undefined): Promise<{ pieces: { mesh: unknown; rotateZ90?: boolean }[]; extras: unknown[]; warnings: string[]; cuts: { axis: string; atMm: number }[] }> {
  const options = connector ? { connector } : {}
  if (planeZ !== undefined) {
    const r = await geomRun(ctx, 'cut', { mesh, plane: { axis: 'z', at: planeZ }, options })
    const report = rec(r['report'])
    return { pieces: [{ mesh: r['below'] }, { mesh: r['above'] }], extras: arr(r['extras']), warnings: arr(report['warnings']).filter((x): x is string => typeof x === 'string'), cuts: [{ axis: 'z', atMm: planeZ }] }
  }
  const r = await geomRun(ctx, 'split', { mesh, options: { buildVolumeMm: [vol.x, vol.y, vol.z], marginMm: 2, allowRotateZ: true, ...options } })
  const pieces = arr(r['parts']).map((p) => ({ mesh: rec(p)['mesh'], rotateZ90: rec(p)['rotateZ90'] === true }))
  const cuts = arr(r['cuts']).map((c) => ({ axis: ['x', 'y', 'z'][num(rec(c)['axis'])] ?? 'z', atMm: round(num(rec(c)['offsetMm']), 1) }))
  return { pieces, extras: arr(r['extras']), warnings: arr(r['warnings']).filter((x): x is string => typeof x === 'string'), cuts }
}

export function createCut() {
  return defineSkill({
    name: 'cut',
    version: '1.2.0',
    permission: 'slice',
    description:
      'Make a model fit a printer: compare scaling it down with splitting it (mode "compare" only reports), or split it (mode "split"). With geometry on the host the mesh is cut into watertight parts with dovetail, pin or dowel connectors, fewest cuts for the build volume (or one horizontal cut at planeZ when given), and the parts replace the object; the approval is asked when policy says so.',
    input: z.object({
      objectId: z.string().optional(),
      printerModel: z.string().describe('Printer model whose build volume must fit, such as "A1 mini"'),
      mode: z.enum(['compare', 'split']).default('compare'),
      planeZ: z.number().positive().optional().describe('Height of a single horizontal cut in mm; leave out to let the geometry pick the fewest cuts'),
      connector: z.enum(['dovetail', 'pins', 'pin', 'dowel', 'none']).optional().describe('dovetail (default): sliding rail; pin: pins on one part into sockets; dowel: sockets in both parts and separate dowels'),
    }),
    args: (i) => (i.mode === 'split' ? `--plane z=${i.planeZ ?? 'auto'} --connector ${i.connector ?? 'dovetail'}` : `--preview --compare scale,split --printer "${i.printerModel}"`),
    async approval(i) {
      return { title: `Replace the model in this project with ${i.planeZ ? '2 cut parts' : 'the cut parts'}?`, lines: ['The original stays in Library as version 1'], actions: [] }
    },
    permissionFor: (i) => (i.mode === 'split' ? 'slice' : 'read'),
    async run(i, ctx) {
      const obj = pickObject(ctx, i.objectId)
      if (!obj) return { ok: false, summary: 'No object in the project' }
      const vol = buildVolume(ctx.kb, i.printerModel)
      if (!vol) return { ok: false, summary: `Unknown build volume for "${i.printerModel}"` }
      const [x, y, z] = obj.bboxMm
      const scale = Math.min(1, vol.x / x, vol.y / y, vol.z / z)
      const pieces = Math.max(1, Math.ceil(z / vol.z))
      const planeZ = i.planeZ ?? round(z / pieces, 0)
      const g = ctx.host.geom ? await objectGeometry(obj) : null
      const citations = vol.source ? ctx.kb.cite(ctx.kb.get('printer', vol.source)?.sources.slice(0, 2) ?? []) : []
      if (i.mode === 'compare') {
        let geomParts: number | null = null
        let geomCuts: { axis: string; atMm: number }[] = []
        if (g && scale < 1) {
          const s = await geometrySplit(ctx, g.mesh, vol, null, undefined)
          geomParts = s.pieces.length
          geomCuts = s.cuts
        }
        const splitLabel = geomParts !== null ? `split in ${geomParts} (${geomCuts.map((c) => `${c.axis} ${c.atMm}`).join(', ') || 'no cut'})` : `split at z ${planeZ}`
        const rows: Cell[][] = [
          [`scale ${round(scale * 100, 1)}%`, `${round(x * scale, 0)} x ${round(y * scale, 0)} x ${round(z * scale, 0)} mm`, '1', scale < 0.95 ? { text: 'thin features shrink too', tone: 'warn' } : { text: 'small change', tone: 'ok' }],
          [splitLabel, `${round(x, 0)} x ${round(y, 0)} x ${round(z, 0)} mm`, String(geomParts ?? pieces), { text: (geomParts ?? pieces) > 2 ? 'full size, several seams to glue' : 'full size, one seam to glue', tone: 'ok' }],
        ]
        return {
          summary: scale >= 1 ? 'Fits without changes' : geomParts !== null ? `Scale to ${round(scale * 100, 1)}%, or split in ${geomParts} parts` : `Scale to ${round(scale * 100, 1)}%, or split in ${pieces} at z ${planeZ}`,
          output: { fits: scale >= 1, scale: round(scale, 3), split: { pieces: geomParts ?? pieces, planeZ, ...(geomParts !== null ? { cuts: geomCuts, planned: 'geometry' } : { planned: 'bounding box' }) }, buildVolume: vol },
          display: [{ kind: 'table', head: ['option', 'size', 'parts', 'tradeoff'], rows }],
          ...(citations.length ? { citations } : {}),
        }
      }
      if (g) {
        const connector = connectorSpec(i.connector)
        if (i.planeZ !== undefined && i.planeZ >= z) return { ok: false, summary: `A cut at z ${i.planeZ} is above the top of the model (${round(z, 1)} mm)` }
        const s = await geometrySplit(ctx, g.mesh, vol, connector, i.planeZ)
        const parts = partsFrom(obj, g.parts[0]?.slot ?? 1, s.pieces, s.extras)
        if (parts.filter((p) => !p.extra).length < 2) return { ok: false, summary: 'The cut produced fewer than 2 parts; nothing changed', output: { warnings: s.warnings } }
        const infos = await Promise.all(parts.map((p) => meshInfo(ctx, toGeomMesh([p.part]))))
        const fit = parts.map((p) => fitsVolume(p.sizeMm, vol))
        if (ctx.project?.replaceObjects) {
          await ctx.project.replaceObjects([obj.id], parts.map((p) => p.obj))
          for (const p of parts) if (p.rotateZ90) ctx.project.setRotation?.(p.obj.id, [0, 0, 90], 'turned 90 deg to fit')
        }
        const notes = [...s.warnings]
        if (g.parts.length > 1) notes.push(`The ${g.parts.length} parts were cut as one body on the first part's filament slot.`)
        if (fit.some((f) => !f)) notes.push(`Some parts are still larger than ${vol.x} x ${vol.y} x ${vol.z} mm.`)
        if (infos.some((m) => !m.watertight)) notes.push('Some parts are not watertight; repair their meshes before slicing.')
        if (!ctx.project?.replaceObjects) notes.push('This project cannot replace objects, so the parts were not added.')
        const main = parts.filter((p) => !p.extra).length
        const conn = connector ? `${connector.kind} connector${connector.kind === 'dovetail' ? '' : 's'}` : 'no connectors'
        return {
          summary: `${main} ${infos.every((m) => m.watertight) ? 'watertight ' : ''}part${main === 1 ? '' : 's'}${s.cuts.length ? ` (${s.cuts.map((c) => `${c.axis} ${c.atMm}`).join(', ')})` : ''} with ${conn}${parts.length > main ? `, plus ${parts.length - main} connector piece${parts.length - main === 1 ? '' : 's'}` : ''}`,
          output: {
            parts: parts.map((p, k) => ({ id: p.obj.id, name: p.obj.name, sizeMm: p.sizeMm, fits: fit[k] ?? false, watertight: infos[k]?.watertight ?? false, volumeCm3: cm3(infos[k]?.volumeMm3 ?? 0), ...(p.rotateZ90 ? { rotateZ90: true } : {}), ...(p.extra ? { connectorPiece: true } : {}) })),
            cuts: s.cuts,
            connector: connector?.kind ?? 'none',
            buildVolume: vol,
            ...(notes.length ? { notes } : {}),
          },
          display: [
            {
              kind: 'table',
              head: ['part', 'size', 'fits', 'watertight', 'volume'],
              rows: parts.map((p, k) => [p.obj.name, `${round(p.sizeMm[0], 0)} x ${round(p.sizeMm[1], 0)} x ${round(p.sizeMm[2], 0)} mm${p.rotateZ90 ? ', turned 90 deg' : ''}`, fit[k] ? { text: 'yes', tone: 'ok' } : { text: 'no', tone: 'bad' }, infos[k]?.watertight ? { text: 'yes', tone: 'ok' } : { text: 'no', tone: 'warn' }, `${cm3(infos[k]?.volumeMm3 ?? 0)} cm3`]),
            },
            ...(notes.length ? [{ kind: 'text' as const, text: notes.join(' ') }] : []),
          ],
          ...(citations.length ? { citations } : {}),
        }
      }
      if (z - planeZ > vol.z || planeZ > vol.z) return { ok: false, summary: `A cut at z ${planeZ} leaves a part taller than ${vol.z} mm` }
      const parts = [
        { id: `${obj.id}-a`, name: `${obj.name} A`, bboxMm: [x, y, planeZ] as [number, number, number] },
        { id: `${obj.id}-b`, name: `${obj.name} B`, bboxMm: [x, y, round(z - planeZ, 1)] as [number, number, number] },
      ]
      if (ctx.project?.replaceObjects) await ctx.project.replaceObjects([obj.id], parts)
      return {
        summary: `2 parts at z ${planeZ} with a ${i.connector ?? 'dovetail'} connector`,
        output: { parts: parts.map((p) => ({ id: p.id, bboxMm: p.bboxMm })), connector: i.connector ?? 'dovetail', note: 'The split is recorded in the project as two parts sized from the bounding box. Geometry is not available on this host, so the mesh itself was not cut.' },
        display: [{ kind: 'kv', rows: parts.map((p) => [p.name, `${round(p.bboxMm[0], 0)} x ${round(p.bboxMm[1], 0)} x ${round(p.bboxMm[2], 0)} mm`] as [string, Cell]) }],
      }
    },
  })
}
