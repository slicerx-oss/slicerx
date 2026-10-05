// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// orientation_search: slices the part in each axis orientation (and
// optionally 45 degree tilts), scores time, filament, overhang area, bed
// contact and the faces the user wants clean, and ranks them.
import type { Cell, MeshPart } from '@slicerx/contracts'
import { z } from 'zod'
import { rotatedBox } from '../../src/memory-project'
import { fmtDuration, fmtGrams } from '../../src/shared'
import { defineSkill } from '../../src/tool'
import { pickObject, round } from '../common'
import { scoreOrientations } from '../orient/index'
import { AXIS_ORIENTATIONS, FACE_NAMES, TILT_ORIENTATIONS, currentRotation, faceExposure, plateOf, unrotateBox, scoreRotation, setItemRotation, type FaceDir, type FaceExposure, type Orientation } from './geometry'

export interface OrientationWeights {
  time: number
  support: number
  contact: number
  surface: number
}

export const DEFAULT_WEIGHTS: OrientationWeights = { time: 1, support: 1.5, contact: 0.5, surface: 2 }

export interface OrientationCandidate {
  name: string
  rotate: [number, number, number]
  timeS: number
  grams: number
  overhangCm2: number | null
  contactCm2: number
  heightMm: number
  faces: FaceExposure[]
}

export interface RankedOrientation extends OrientationCandidate {
  /** 0 to 100, higher is better. */
  score: number
  /** Surface penalty from the clean faces, 0 (all clean) to 1 per face. */
  surfacePenalty: number
  notes: string[]
}

/**
 * Surface penalty for one clean face: 1 when support would touch it, 0.5 when
 * it rests on the bed (plate texture and first layer squish), 0 otherwise.
 * Faces measured on a mesh are weighted by the share of their area affected.
 */
export function facePenalty(f: FaceExposure): number {
  if (f.areaCm2 > 0) return Math.min(1, f.supportedCm2 / f.areaCm2 + (0.5 * f.onBedCm2) / f.areaCm2)
  return f.facing === 'down' ? 0.75 : 0
}

/**
 * Ranks candidates. Each metric is scaled to 0 (best candidate) through 1
 * (worst) across the set, then weighted: time, support (overhang area),
 * contact (less bed contact is worse) and surface (clean faces). Score is 100
 * times one minus the weighted mean. Without a mesh, support is unknown and
 * drops out.
 */
export function rankOrientations(cands: OrientationCandidate[], weights: OrientationWeights = DEFAULT_WEIGHTS): RankedOrientation[] {
  const span = (xs: number[]): [number, number] => [Math.min(...xs), Math.max(...xs)]
  const norm = (v: number, [lo, hi]: [number, number]): number => (hi - lo > 1e-9 ? (v - lo) / (hi - lo) : 0)
  const time = span(cands.map((c) => c.timeS))
  const hasOverhang = cands.every((c) => c.overhangCm2 !== null)
  const over = span(cands.map((c) => c.overhangCm2 ?? 0))
  const maxContact = Math.max(...cands.map((c) => c.contactCm2), 1e-9)
  const w = { ...weights, support: hasOverhang ? weights.support : 0 }
  const total = w.time + w.support + w.contact + w.surface || 1
  return cands
    .map((c) => {
      const surface = c.faces.length ? c.faces.reduce((s, f) => s + facePenalty(f), 0) / c.faces.length : 0
      const cost = w.time * norm(c.timeS, time) + w.support * norm(c.overhangCm2 ?? 0, over) + w.contact * (1 - c.contactCm2 / maxContact) + w.surface * surface
      const notes: string[] = []
      for (const f of c.faces) {
        if (f.supportedCm2 > 0.05) notes.push(`${f.face} face: ${f.supportedCm2} cm2 would touch support`)
        else if (f.onBedCm2 > 0 || (f.areaCm2 === 0 && f.facing === 'down')) notes.push(`${f.face} face rests on the bed`)
        else notes.push(`${f.face} face points ${f.facing}`)
      }
      return { ...c, score: Math.round(100 * (1 - cost / total)), surfacePenalty: Math.round(surface * 100) / 100, notes }
    })
    .sort((a, b) => b.score - a.score || a.timeS - b.timeS)
}

export function createOrientationSearch() {
  return defineSkill({
    name: 'orientation_search',
    version: '1.0.0',
    permission: 'slice',
    description:
      'Choose how to lay a part on the bed by slicing each candidate orientation: the six axis orientations, plus 45 degree tilts when asked. Each is scored on print time, overhang area that needs support, bed contact and the faces the user wants clean (named in model coordinates: top, bottom, front, back, left, right), with weights the user can change. Returns the ranking; applies the best rotation to the project only when apply is true. Use it for "least support but keep the logo side clean" or "fastest orientation". For a quick overhang check without slicing, use orient.',
    input: z.object({
      objectId: z.string().optional().describe('Object id or name; defaults to the first object'),
      cleanFaces: z.array(z.enum(FACE_NAMES as [FaceDir, ...FaceDir[]])).optional().describe('Faces to keep clean, in model coordinates: top, bottom, front (minus Y), back, left (minus X), right'),
      weights: z
        .object({
          time: z.number().min(0).max(10).optional(),
          support: z.number().min(0).max(10).optional(),
          contact: z.number().min(0).max(10).optional(),
          surface: z.number().min(0).max(10).optional(),
        })
        .optional()
        .describe('Relative weights of print time, support (overhang area), bed contact and clean faces. Default 1, 1.5, 0.5, 2'),
      tilts: z.boolean().optional().describe('Also try 45 degree tilts (more support, sometimes cleaner faces)'),
      supportAngle: z.number().min(10).max(80).optional().describe('Overhang angle that needs support, degrees from horizontal (default 45)'),
      apply: z.boolean().optional().describe('Set the best rotation on the object; default false, which only reports'),
    }),
    args: (i) => [i.objectId ?? null, i.cleanFaces?.length ? `--clean ${i.cleanFaces.join(',')}` : null, i.tilts ? '--tilts' : null, i.apply ? '--apply' : null].filter(Boolean).join(' '),
    async run(i, ctx) {
      const project = ctx.project
      if (!project) return { ok: false, summary: 'No project is open' }
      const slicer = ctx.host.slicer
      if (!slicer) return { ok: false, summary: 'No slicer on this host' }
      const obj = pickObject(ctx, i.objectId)
      if (!obj) return { ok: false, summary: 'No object in the project' }
      const plateIdx = plateOf(project, obj.id)
      if (plateIdx === undefined) return { ok: false, summary: 'The object is not on a plate. Run arrange first.' }
      const angle = i.supportAngle ?? 45
      const weights: OrientationWeights = { ...DEFAULT_WEIGHTS, ...Object.fromEntries(Object.entries(i.weights ?? {}).filter(([, v]) => v !== undefined)) }
      const notes: string[] = []
      const parts: MeshPart[] | null = obj.mesh ? await obj.mesh() : null
      if (!parts) notes.push('Mesh data is not available on this host, so overhang area is unknown and clean faces are judged from the bounding box.')
      // The object's size as modeled: undo the current rotation.
      const current = currentRotation(project, obj.id)
      const modeled = unrotateBox(obj.bboxMm, current)
      if (current.some((d) => d !== 0)) notes.push('Rotations are absolute, measured from the model as loaded.')
      const axisScores = parts ? scoreOrientations(parts, angle) : []
      const list: Orientation[] = [...AXIS_ORIENTATIONS, ...(i.tilts ? TILT_ORIENTATIONS : [])]
      const plate0 = await project.plate(plateIdx)
      const config = project.config(plateIdx)
      const cands: OrientationCandidate[] = []
      let k = 0
      for (const o of list) {
        if (ctx.signal.aborted) break
        ctx.progress(`slicing ${o.name}`, k++ / list.length)
        const plate = setItemRotation(plate0, obj.id, o.rotate)
        let timeS = 0
        let grams = 0
        try {
          const res = await slicer.slice({ plate, config }, { signal: ctx.signal })
          timeS = res.stats.timeS
          grams = res.stats.filamentG.reduce((a, b) => a + b, 0)
          try {
            slicer.release(res.id)
          } catch {
            // Housekeeping only.
          }
        } catch (e) {
          notes.push(`${o.name}: slice failed (${e instanceof Error ? e.message : String(e)})`)
          continue
        }
        const sc = parts ? (o.orientName ? axisScores.find((s) => s.name === o.orientName) : undefined) ?? scoreRotation(parts, o.rotate, angle) : null
        const box = rotatedBox(modeled, o.rotate)
        cands.push({
          name: o.name,
          rotate: o.rotate,
          timeS,
          grams,
          overhangCm2: sc ? sc.overhangCm2 : null,
          contactCm2: sc ? sc.contactCm2 : round((box[0] * box[1]) / 100, 1),
          heightMm: sc ? sc.heightMm : box[2],
          faces: (i.cleanFaces ?? []).map((f) => faceExposure(parts, o.rotate, f, angle)),
        })
      }
      if (cands.length === 0) return { ok: false, summary: 'No orientation could be sliced' }
      const ranked = rankOrientations(cands, weights)
      const best = ranked[0]
      if (!best) return { ok: false, summary: 'No orientation could be ranked' }
      let applied = false
      if (i.apply) {
        if (project.setRotation) {
          project.setRotation(obj.id, best.rotate, best.name)
          applied = true
        } else notes.push('This project cannot set rotations from mimir, so nothing was applied.')
      }
      const rows: Cell[][] = ranked.map((r, n) => [
        n === 0 ? { text: r.name, tone: 'hl' } : r.name,
        String(r.score),
        fmtDuration(r.timeS),
        fmtGrams(r.grams),
        r.overhangCm2 === null ? 'unknown' : `${r.overhangCm2} cm2`,
        `${r.contactCm2} cm2`,
        r.faces.length ? { text: r.notes.join('; '), tone: r.surfacePenalty >= 0.5 ? 'warn' : 'ok' } : '',
      ])
      const needs = best.overhangCm2 !== null && best.overhangCm2 > 0.5
      return {
        summary: `${best.name[0]?.toUpperCase() ?? ''}${best.name.slice(1)}, score ${best.score}, ${fmtDuration(best.timeS)}${best.overhangCm2 === null ? '' : needs ? `, ${best.overhangCm2} cm2 needs support` : ', no supports needed'}${applied ? ', applied' : ''}`,
        output: {
          object: obj.id,
          best: { name: best.name, rotate: best.rotate, score: best.score },
          ranked: ranked.map((r) => ({ name: r.name, rotate: r.rotate, score: r.score, timeS: Math.round(r.timeS), grams: round(r.grams), overhangCm2: r.overhangCm2, contactCm2: r.contactCm2, heightMm: r.heightMm, cleanFaces: r.notes })),
          weights,
          applied,
          notes,
        },
        display: [
          { kind: 'kv', rows: [['best', best.name], ['rotation', `${best.rotate.join(', ')} deg (X, Y, Z)`], ['supports', best.overhangCm2 === null ? { text: 'unknown without a mesh', tone: 'dim' } : needs ? { text: `${best.overhangCm2} cm2 past ${angle} deg`, tone: 'warn' } : { text: 'none needed', tone: 'ok' }], ['result', applied ? { text: 'rotation applied', tone: 'ok' } : { text: 'not applied', tone: 'dim' }]] },
          { kind: 'table', head: ['orientation', 'score', 'time', 'filament', 'overhang', 'bed contact', 'clean faces'], rows },
          ...(notes.length ? [{ kind: 'log' as const, lines: notes.map((t) => ({ text: t, tone: 'warn' as const })) }] : []),
        ],
      }
    },
  })
}
