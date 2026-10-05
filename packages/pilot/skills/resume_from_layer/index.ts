// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// resume_from_layer: after a failure with the part still on the bed, find the
// layer and nozzle height to restart from (sx-geom resume, same layer math as
// the core), and slice the part that is left for time and grams. Plan only:
// nothing is sent to a printer, and the resume G-code itself needs the core's
// start-layer option.
import type { Cell, MeshPart, SliceResult } from '@slicerx/contracts'
import { z } from 'zod'
import { fmtDuration } from '../../src/shared'
import { defineSkill, type ToolContext } from '../../src/tool'
import { pickObject } from '../common'
import { plateOf } from '../orientation_search/geometry'
import { NO_MESH_NOTE, arr, geomRun, needsGeometry, num, objectGeometry, partFromGeom, printNumbers, round } from '../geom_common/index'

export const START_LAYER_GAP = 'The start-layer option is not in the slice request contract yet, so mimir cannot produce the resume G-code. This is the plan to check against the part on the bed; nothing was sent to a printer.'

export interface ResumePlan {
  resumeLayer: number
  resumeLayerNumber: number
  layerCount: number
  remainingLayers: number
  printedHeightMm: number
  resumeZMm: number
  warnings: string[]
}

export function parseResume(v: Record<string, unknown>): ResumePlan {
  return {
    resumeLayer: num(v['resumeLayer']),
    resumeLayerNumber: num(v['resumeLayerNumber']),
    layerCount: num(v['layerCount']),
    remainingLayers: num(v['remainingLayers']),
    printedHeightMm: round(num(v['printedHeightMm']), 3),
    resumeZMm: round(num(v['resumeZMm']), 3),
    warnings: arr(v['warnings']).filter((x): x is string => typeof x === 'string'),
  }
}

/** The remaining part moved down so it sits on the bed for slicing. */
export function dropToBed(p: MeshPart, byMm: number): MeshPart {
  const out = new Float32Array(p.positions.length)
  for (let k = 0; k < p.positions.length; k++) out[k] = (p.positions[k] ?? 0) - (k % 3 === 2 ? byMm : 0)
  return { ...p, positions: out }
}

async function sliceRemaining(ctx: ToolContext, part: MeshPart, plateIndex: number | undefined, layerHeight: number): Promise<SliceResult | null> {
  const slicer = ctx.host.slicer
  const project = ctx.project
  if (!slicer || !project) return null
  const handle = await slicer.loadParts('resume-remaining', [part])
  try {
    const base = plateIndex !== undefined ? await project.plate(plateIndex) : null
    const config = { ...project.config(plateIndex ?? 1), layer_height: layerHeight, initial_layer_print_height: layerHeight }
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    return await slicer.slice({ plate: { bed: base?.bed ?? { widthMm: 256, depthMm: 256, heightMm: 256 }, objects: [{ id: 'resume', name: 'remaining part', mesh: handle.id, transform: identity }] }, config }, { signal: ctx.signal })
  } finally {
    slicer.release(handle.id)
  }
}

export function createResumeFromLayer() {
  return defineSkill({
    name: 'resume_from_layer',
    version: '1.0.0',
    permission: 'read',
    description:
      'Plan a restart after a failed print with the part still on the bed. Give the measured height of the part on the bed, or the layer the printer stopped at (or the printer id, to read it from the printer). Returns the layer and nozzle height to resume from and the time and grams of what is left. Plan only: it sends nothing to a printer, and producing the resume G-code needs the core start-layer option, which is not there yet.',
    input: z.object({
      objectId: z.string().optional().describe('Object that failed; defaults to the first object in the project'),
      measuredHeightMm: z.number().positive().optional().describe('Height of the part on the bed, measured with calipers, mm'),
      failedLayer: z.number().int().min(1).optional().describe('Layer number the printer showed when it stopped, counting from 1'),
      printerId: z.string().optional().describe('Printer to read the stopped layer from when failedLayer is not given'),
      layerHeightMm: z.number().min(0.04).max(1).optional().describe('Layer height of the failed job (default: the plate config)'),
      firstLayerHeightMm: z.number().min(0.04).max(1).optional().describe('First layer height of the failed job (default: the plate config)'),
    }),
    args: (i) => [i.objectId ?? null, i.measuredHeightMm ? `--measured ${i.measuredHeightMm}` : null, i.failedLayer ? `--layer ${i.failedLayer}` : null, i.printerId ? `--printer ${i.printerId}` : null].filter(Boolean).join(' '),
    printerFor: (i) => i.printerId,
    async run(i, ctx) {
      if (!ctx.host.geom) return needsGeometry('Planning a resume')
      const obj = pickObject(ctx, i.objectId)
      if (!obj) return { ok: false, summary: 'No object in the project' }
      const g = await objectGeometry(obj)
      if (!g) return { ok: false, summary: `No mesh for ${obj.name}`, output: { note: NO_MESH_NOTE } }
      let failedLayer = i.failedLayer
      let layerSource = failedLayer !== undefined ? 'given' : ''
      if (i.measuredHeightMm === undefined && failedLayer === undefined && i.printerId) {
        const st = await ctx.host.printers.status(i.printerId).catch(() => null)
        const layer = st?.layer
        if (typeof layer === 'number' && layer > 0) {
          failedLayer = layer
          layerSource = `read from ${i.printerId}`
        }
      }
      if (i.measuredHeightMm === undefined && failedLayer === undefined) return { ok: false, summary: 'Need the measured height of the part on the bed or the layer the printer stopped at' }
      const nums = printNumbers(ctx, obj.id)
      const layerHeight = i.layerHeightMm ?? nums.layerHeight
      const firstLayer = i.firstLayerHeightMm ?? nums.firstLayer
      const req: Record<string, unknown> = { mesh: g.mesh, layerHeightMm: layerHeight, firstLayerHeightMm: firstLayer, includeRemainingMesh: true }
      if (i.measuredHeightMm !== undefined) req['measuredHeightMm'] = i.measuredHeightMm
      else if (failedLayer !== undefined) req['failedLayer'] = failedLayer
      const res = await geomRun(ctx, 'resume', req)
      const plan = parseResume(res)
      const remaining = partFromGeom(res['remaining'], `${obj.name} remaining`, g.parts[0]?.slot ?? 1)
      const heightMm = round(Math.max(0, (g.parts.length ? top(g.parts) : 0) - plan.printedHeightMm), 2)
      let sliced: SliceResult | null = null
      const notes = [...plan.warnings]
      if (remaining && plan.remainingLayers > 0) {
        try {
          sliced = await sliceRemaining(ctx, dropToBed(remaining, plan.printedHeightMm), ctx.project ? plateOf(ctx.project, obj.id) : undefined, layerHeight)
        } catch (e) {
          notes.push(`Slicing the remaining part failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (!sliced && plan.remainingLayers > 0 && !notes.some((n) => n.startsWith('Slicing'))) notes.push('No slicer on this host, so time and grams for the rest are not known.')
      const grams = sliced ? round(sliced.stats.filamentG.reduce((a, b) => a + b, 0), 1) : null
      const timeS = sliced ? Math.round(sliced.stats.timeS) : null
      const steps = [
        `Measure the part on the bed: its top should be at ${plan.printedHeightMm} mm. If it is lower, measure again and rerun with that height.`,
        'Do not home Z with the nozzle over the part; clear the nozzle and keep the bed at print temperature so the part stays stuck.',
        `Resume at layer ${plan.resumeLayerNumber} (index ${plan.resumeLayer}), nozzle at Z ${plan.resumeZMm} mm.`,
      ]
      const rows: [string, Cell][] = [
        ['from', i.measuredHeightMm !== undefined ? `measured height ${i.measuredHeightMm} mm` : `stopped at layer ${failedLayer ?? ''} (${layerSource})`],
        ['already printed', `${plan.printedHeightMm} mm, layers 1 to ${plan.resumeLayerNumber - 1}`],
        ['resume at', `layer ${plan.resumeLayerNumber} of ${plan.layerCount}, Z ${plan.resumeZMm} mm`],
        ['left to print', `${plan.remainingLayers} layers, ${heightMm} mm`],
        ['time and filament', sliced && grams !== null && timeS !== null ? `${fmtDuration(timeS)}, ${grams} g` : { text: 'not sliced', tone: 'dim' }],
        ['resume G-code', { text: 'needs the core start-layer option', tone: 'warn' }],
      ]
      return {
        summary: `Resume ${obj.name} at layer ${plan.resumeLayerNumber} (Z ${plan.resumeZMm} mm), ${plan.remainingLayers} layers left${grams !== null ? `, about ${grams} g` : ''}. Plan only`,
        output: {
          objectId: obj.id,
          ...plan,
          layerHeightMm: layerHeight,
          firstLayerHeightMm: firstLayer,
          remainingHeightMm: heightMm,
          ...(grams !== null ? { remainingGrams: grams } : {}),
          ...(timeS !== null ? { remainingTimeS: timeS } : {}),
          steps,
          note: START_LAYER_GAP,
          ...(notes.length ? { warnings: notes } : {}),
        },
        display: [{ kind: 'kv', rows }, { kind: 'text', text: [...steps, ...notes, START_LAYER_GAP].join(' ') }],
      }
    },
  })
}

function top(parts: MeshPart[]): number {
  let z = -Infinity
  for (const p of parts) for (let k = 2; k < p.positions.length; k += 3) z = Math.max(z, p.positions[k] ?? -Infinity)
  return Number.isFinite(z) ? z : 0
}
