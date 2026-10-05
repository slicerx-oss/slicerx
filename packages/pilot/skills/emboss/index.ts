// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// emboss: raised or recessed text on a face of a part with sx-geom, checked
// against the nozzle and layer height so the strokes actually print.
import type { Cell } from '@slicerx/contracts'
import { z } from 'zod'
import { defineSkill, type ToolContext } from '../../src/tool'
import { pickObject } from '../common'
import { FACE_NAMES, currentRotation, rot3, type FaceDir, type Vec3 } from '../orientation_search/geometry'
import { NO_MESH_NOTE, boxFacePoint, faceNormal, geomRun, meshInfo, modelDirection, needsGeometry, objectGeometry, partFromGeom, printNumbers, replaceGeometry, round } from '../geom_common/index'

/** sx-geom's default stroke, as a share of the capital height. */
export const STROKE_SHARE = 0.16

export interface TextCheck {
  strokeMm: number
  minStrokeMm: number
  minSizeMm: number
  minDepthMm: number
  warnings: string[]
}

/**
 * Strokes narrower than about two line widths print as a single wobbly line
 * or vanish; raised text lower than two layers barely shows, and a pocket
 * shallower than two layers fills in.
 */
export function checkText(o: { sizeMm: number; depthMm: number; strokeMm?: number | undefined; lineWidth: number; layerHeight: number; mode: 'emboss' | 'deboss'; vertical: boolean }): TextCheck {
  const stroke = o.strokeMm ?? o.sizeMm * STROKE_SHARE
  const minStroke = round(2 * o.lineWidth, 2)
  const minSize = round(minStroke / STROKE_SHARE, 1)
  const minDepth = round(2 * o.layerHeight, 2)
  const warnings: string[] = []
  if (stroke < minStroke) warnings.push(`Strokes are ${round(stroke, 2)} mm wide, under two line widths (${minStroke} mm): letters will print thin or break up. Use at least ${minSize} mm tall text.`)
  if (o.depthMm < minDepth) warnings.push(`${o.mode === 'emboss' ? 'Raised' : 'Recessed'} depth ${o.depthMm} mm is under two layers (${minDepth} mm) and will hardly show.`)
  if (o.mode === 'deboss' && !o.vertical && stroke < minStroke * 1.25) warnings.push('Recessed text on a top face needs slightly wider strokes than raised text; the top skin bridges narrow pockets.')
  return { strokeMm: round(stroke, 2), minStrokeMm: minStroke, minSizeMm: minSize, minDepthMm: minDepth, warnings }
}

/** World Z of a model direction as the object is placed; 0 without a direction. */
function modelToWorldZ(ctx: ToolContext, objectId: string, dir: Vec3 | null): number {
  if (!dir) return 0
  const m = rot3(ctx.project ? currentRotation(ctx.project, objectId) : [0, 0, 0])
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1
  return ((m[2]?.[0] ?? 0) * dir[0] + (m[2]?.[1] ?? 0) * dir[1] + (m[2]?.[2] ?? 0) * dir[2]) / len
}

export function createEmboss() {
  return defineSkill({
    name: 'emboss',
    version: '1.0.0',
    permission: 'slice',
    description:
      'Emboss (raised) or deboss (recessed) text on a face of a part. Give the face as a direction as the part sits on the bed (top, front, back, left, right, bottom) or as a point and outward normal in model coordinates, the capital letter height and the depth. Checks the stroke width against the line width and the depth against the layer height and warns when the text will not print cleanly. Replaces the object geometry in the project. Needs geometry on the host.',
    input: z.object({
      objectId: z.string().optional().describe('Object id or name; defaults to the first object in the project'),
      text: z.string().min(1).max(80).describe('Text to place; a line break starts a new line'),
      face: z.enum(FACE_NAMES as [FaceDir, ...FaceDir[]]).optional().describe('Face as placed on the bed; front faces the viewer. Default top'),
      point: z.array(z.number()).length(3).optional().describe('Center of the text on the surface, model coordinates in mm (instead of face)'),
      normal: z.array(z.number()).length(3).optional().describe('Outward surface normal at point'),
      sizeMm: z.number().min(1).max(200).describe('Capital letter height in mm'),
      depthMm: z.number().min(0.1).max(10).default(0.6).describe('Height of raised text or depth of the pocket in mm'),
      mode: z.enum(['emboss', 'deboss']).default('deboss'),
      strokeMm: z.number().min(0.2).max(10).optional().describe('Stroke width in mm (default 16 percent of the size)'),
    }),
    args: (i) => [`"${i.text}"`, i.point ? `--at ${i.point.join(',')}` : `--face ${i.face ?? 'top'}`, `--size ${i.sizeMm}`, `--depth ${i.depthMm}`, `--${i.mode}`].join(' '),
    async approval(i, ctx) {
      const obj = pickObject(ctx, i.objectId)
      return { title: `${i.mode === 'emboss' ? 'Emboss' : 'Deboss'} "${i.text}" on ${obj?.name ?? 'the model'}?`, lines: [`${i.sizeMm} mm tall, ${i.depthMm} mm ${i.mode === 'emboss' ? 'raised' : 'deep'}, on the ${i.point ? 'given point' : `${i.face ?? 'top'} face`}`], actions: [] }
    },
    async run(i, ctx) {
      if (!ctx.host.geom) return needsGeometry('Embossing')
      const obj = pickObject(ctx, i.objectId)
      if (!obj) return { ok: false, summary: 'No object in the project' }
      const g = await objectGeometry(obj)
      if (!g) return { ok: false, summary: `No mesh for ${obj.name}`, output: { note: NO_MESH_NOTE } }
      const face: FaceDir = i.face ?? 'top'
      const info = await meshInfo(ctx, g.mesh)
      // With a point and no normal, sx-geom uses the triangle nearest the point.
      const normal: Vec3 | null = i.point ? (i.normal ? [i.normal[0] ?? 0, i.normal[1] ?? 0, i.normal[2] ?? 1] : null) : faceNormal(ctx.project, obj.id, face)
      const point: Vec3 = i.point ? [i.point[0] ?? 0, i.point[1] ?? 0, i.point[2] ?? 0] : boxFacePoint(info.min, info.max, normal ?? [0, 0, 1])
      // Text reads upright: world up on side faces, toward the back on top and bottom faces.
      const horizontal = i.point ? Math.abs(modelToWorldZ(ctx, obj.id, normal)) > 0.9 : face === 'top' || face === 'bottom'
      const up = modelDirection(ctx.project, obj.id, horizontal ? [0, 1, 0] : [0, 0, 1])
      const nums = printNumbers(ctx, obj.id)
      const check = checkText({ sizeMm: i.sizeMm, depthMm: i.depthMm, strokeMm: i.strokeMm, lineWidth: nums.lineWidth, layerHeight: nums.layerHeight, mode: i.mode, vertical: !horizontal })
      const spec: Record<string, unknown> = { text: i.text, point, up, sizeMm: i.sizeMm, depthMm: i.depthMm, mode: i.mode }
      if (normal) spec['normal'] = normal
      if (i.strokeMm) spec['strokeMm'] = i.strokeMm
      const res = await geomRun(ctx, 'emboss', { mesh: g.mesh, spec })
      const first = g.parts[0]
      const part = partFromGeom(res['mesh'], first?.name ?? obj.name, first?.slot ?? 1)
      if (!part) return { ok: false, summary: 'Embossing returned no mesh' }
      const replaced = await replaceGeometry(ctx.project, obj, [part])
      const notes = [...check.warnings]
      if (g.parts.length > 1) notes.push(`The ${g.parts.length} parts were merged into one body on the first part's filament slot.`)
      if (!replaced) notes.push('This project cannot swap geometry, so the text was not applied.')
      const where = i.point ? `at ${point.map((v) => round(v, 1)).join(', ')}` : `on the ${face} face`
      const rows: [string, Cell][] = [
        ['text', `"${i.text}"`],
        ['where', where],
        ['size', `${i.sizeMm} mm tall, ${check.strokeMm} mm strokes`],
        [i.mode === 'emboss' ? 'raised' : 'recessed', `${i.depthMm} mm`],
        ['stroke check', check.warnings.length ? { text: `under ${check.minStrokeMm} mm or ${check.minDepthMm} mm deep`, tone: 'warn' } : { text: `ok for a ${nums.nozzle} mm nozzle at ${nums.layerHeight} mm layers`, tone: 'ok' }],
      ]
      return {
        summary: `${i.mode === 'emboss' ? 'Embossed' : 'Debossed'} "${i.text}" ${where}${check.warnings.length ? `, ${check.warnings.length} print warning${check.warnings.length === 1 ? '' : 's'}` : ''}`,
        output: {
          objectId: obj.id,
          replaced,
          text: i.text,
          mode: i.mode,
          point: point.map((v) => round(v, 2)),
          normal,
          sizeMm: i.sizeMm,
          depthMm: i.depthMm,
          strokeMm: check.strokeMm,
          minStrokeMm: check.minStrokeMm,
          minSizeMm: check.minSizeMm,
          minDepthMm: check.minDepthMm,
          lineWidthMm: nums.lineWidth,
          layerHeightMm: nums.layerHeight,
          ...(notes.length ? { warnings: notes } : {}),
        },
        display: [{ kind: 'kv', rows }, ...(notes.length ? [{ kind: 'text' as const, text: notes.join(' ') }] : [])],
      }
    },
  })
}
