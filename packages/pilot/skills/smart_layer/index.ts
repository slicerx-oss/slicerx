// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// smart_layer: sleipnir (adaptive layer height) in Quality or
// Strength mode. The mode comes from the request: surface and detail goals
// want Quality, functional and load bearing parts want Strength. The height
// band per mode and material family comes from the sleipnir guide in the
// knowledge base; the height plan comes from the geometry service when the
// host has it, else from the mesh slope here.
import type { Cell, PrintConfig } from '@slicerx/contracts'
import { z } from 'zod'
import { parseIntent } from '../../src/intent'
import type { KnowledgeBase } from '../../src/kb/kb'
import { fmtDuration } from '../../src/shared'
import { defineSkill } from '../../src/tool'
import { pickObject, round } from '../common'
import { placedParts, plateOf } from '../orientation_search/geometry'
import { layerHeights } from '../optimize_to_target/search'
import { layerPlan, planTops, type LayerPlan } from './plan'

export type SmartLayerMode = 'quality' | 'strength'

type Rec = Record<string, unknown>
const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Quality for looks, Strength for parts that carry load. Null when the request says neither. */
export function modeFromRequest(text: string, kb: KnowledgeBase, today: string): SmartLayerMode | null {
  const goals = parseIntent(text, kb, today).goals.map((g) => g.id)
  if (goals.includes('strength')) return 'strength'
  if (goals.some((g) => g === 'surface_finish' || g === 'detail' || g === 'dimensional_accuracy')) return 'quality'
  if (/\b(functional|load|bracket|mount|hook|strong)\b/i.test(text)) return 'strength'
  if (/\b(smooth|pretty|display|figure|miniature|detail|quality|look)\b/i.test(text)) return 'quality'
  return null
}

/** Height band as fractions of the nozzle, for a mode and material, from the sleipnir guide. */
export function modeBand(kb: KnowledgeBase, mode: SmartLayerMode, material: string | undefined): { floor: number; ceiling: number; sources: string[] } {
  const guide = kb.get('workflow', 'smart_layer')
  const modes = obj(guide?.data['modes'])
  const fams = obj(modes['families'])
  for (const f of Object.values(fams)) {
    const fam = obj(f)
    const applies = Array.isArray(fam['applies_to']) ? fam['applies_to'].map(String) : []
    if (material && applies.includes(material)) {
      const band = obj(fam[mode])
      const floor = num(band['floor'])
      const ceiling = num(band['ceiling'])
      if (floor !== undefined && ceiling !== undefined) return { floor, ceiling, sources: guide?.sources.slice(0, 4) ?? [] }
    }
  }
  const band = obj(obj(modes[mode])['default_band'])
  return { floor: num(band['floor']) ?? (mode === 'strength' ? 0.3 : 0.2), ceiling: num(band['ceiling']) ?? 0.5, sources: guide?.sources.slice(0, 4) ?? [] }
}

export function createSmartLayer() {
  return defineSkill({
    name: 'smart_layer',
    version: '1.0.0',
    permission: 'slice',
    description:
      'sleipnir: adaptive layer height. Quality mode puts thin layers on shallow slopes, domes and curves and thick layers on vertical walls; Strength mode keeps every layer in the band that bonds well (0.3 to 0.5 of the nozzle). Pick the mode from the request (pass request, or mode directly). Plans the heights, estimates time against uniform layers, and with apply sets smart_layer, smart_layer_min_height and smart_layer_max_height on the plate.',
    input: z.object({
      objectId: z.string().optional().describe('Object id or name; defaults to the first object'),
      mode: z.enum(['quality', 'strength']).optional().describe('Set when the user named it; otherwise pass request'),
      request: z.string().optional().describe("The user's words, used to choose the mode"),
      minHeightMm: z.number().min(0.04).max(0.8).optional(),
      maxHeightMm: z.number().min(0.04).max(0.8).optional(),
      apply: z.boolean().optional().describe('Turn sleipnir on for this plate with the planned band'),
    }),
    args: (i) => [i.objectId ?? null, i.mode ? `--mode ${i.mode}` : '--mode auto', i.apply ? '--apply' : null].filter(Boolean).join(' '),
    async run(i, ctx) {
      const project = ctx.project
      if (!project) return { ok: false, summary: 'No project is open' }
      const o = pickObject(ctx, i.objectId)
      if (!o) return { ok: false, summary: 'No object in the project' }
      const machine = project.machine() ?? ctx.context.machine
      const nozzle = machine?.nozzle ?? 0.4
      const material = machine?.material
      const guessed = i.request ? modeFromRequest(i.request, ctx.kb, ctx.today) : null
      const mode: SmartLayerMode = i.mode ?? guessed ?? 'quality'
      const why = i.mode ? 'set by the request' : guessed ? `chosen from the request (${guessed === 'strength' ? 'a functional part' : 'surface quality'})` : 'default, the request named no goal'
      const band = modeBand(ctx.kb, mode, material)
      const bounds = ctx.kb.setting('smart_layer_min_height')?.bounds
      const clamp = (v: number): number => Math.min(bounds?.max ?? 0.8, Math.max(bounds?.min ?? 0.04, v))
      const minMm = clamp(round(i.minHeightMm ?? band.floor * nozzle, 2))
      const maxMm = clamp(round(i.maxHeightMm ?? band.ceiling * nozzle, 2))
      if (minMm > maxMm) return { ok: false, summary: `Thinnest layer ${minMm} mm is above the thickest ${maxMm} mm` }
      const notes: string[] = []
      if (mode === 'strength') notes.push('In Strength mode the band is 0.3 to 0.5 of the nozzle. Walls, nozzle temperature and orientation matter more for strength than layer height inside that band.')

      // Plan: geometry service first, slope planner here otherwise.
      let tops: number[] | null = null
      let plan: LayerPlan | null = null
      const parts = await placedParts(project, o)
      const cfg = project.config(plateOf(project, o.id) ?? 1)
      const first = Number(cfg['initial_layer_print_height'] ?? 0.2)
      if (ctx.host.geom && parts) {
        try {
          const res = obj(
            await ctx.host.geom.run('layers.plan', {
              mesh: { positions: Array.from(parts.flatMap((p) => Array.from(p.positions))), indices: parts.length === 1 ? Array.from(parts[0]?.indices ?? []) : undefined },
              nozzleMm: nozzle,
              mode,
              options: { minHeightMm: minMm, maxHeightMm: maxMm, firstLayerMm: first },
            }),
          )
          const t = res['layerTopsMm']
          if (Array.isArray(t) && t.every((x) => typeof x === 'number')) tops = t as number[]
        } catch (e) {
          notes.push(`Geometry planning failed (${e instanceof Error ? e.message : String(e)}); used the slope planner.`)
        }
      }
      if (!tops && parts) {
        const heights = layerHeights(nozzle, ctx.kb.setting('layer_height')?.bounds).filter((h) => h >= minMm - 1e-9 && h <= maxMm + 1e-9)
        plan = layerPlan(parts, heights.length ? heights : [minMm, maxMm], mode === 'quality' ? 'standard' : 'draft', nozzle)
        tops = planTops(plan, first)
      }
      if (!tops) notes.push('No mesh access on this host, so the heights were not planned; the band still applies when sleipnir is on.')

      // Time: uniform at the thinnest and thickest layer against the plan.
      let est: { planS: number; thinS: number; thickS: number } | null = null
      const idx = plateOf(project, o.id)
      if (ctx.host.slicer && idx !== undefined && tops) {
        const plate = await project.plate(idx)
        const slice = async (config: PrintConfig, layerTops?: number[]): Promise<number> => {
          const res = await ctx.host.slicer?.slice({ plate, config, ...(layerTops ? { options: { layerTopsMm: layerTops } } : {}) }, { signal: ctx.signal })
          if (!res) return 0
          ctx.host.slicer?.release(res.id)
          return res.stats.timeS
        }
        try {
          ctx.progress('slicing the plan', 0.3)
          const planS = await slice(cfg, tops)
          const thinS = await slice({ ...cfg, layer_height: minMm })
          const thickS = await slice({ ...cfg, layer_height: maxMm })
          est = { planS, thinS, thickS }
        } catch (e) {
          notes.push(`Time estimate skipped: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      const changes = { smart_layer: mode, smart_layer_min_height: minMm, smart_layer_max_height: maxMm }
      if (i.apply) project.setOverrides(changes)
      const heights = tops ? tops.map((t, k) => round(t - (k === 0 ? 0 : (tops?.[k - 1] ?? 0)), 3)) : []
      const thin = heights.filter((h) => h <= minMm + 1e-6).length
      const rows: Cell[][] = plan
        ? plan.segments.map((s) => [`${s.fromMm} to ${s.toMm} mm`, { text: `${s.heightMm} mm`, tone: s.heightMm <= minMm ? 'hl' : 'dim' }, s.slopeDeg === null ? 'vertical walls or flats' : `slopes down to ${s.slopeDeg} deg`])
        : []
      return {
        summary: `sleipnir: ${mode === 'quality' ? 'Quality' : 'Strength'}, ${minMm} to ${maxMm} mm${tops ? `, ${tops.length} layers` : ''}${est && est.thinS > est.planS ? `, about ${fmtDuration(est.thinS - est.planS)} faster than uniform ${minMm} mm` : ''}${i.apply ? ', on for this plate' : ''}`,
        output: {
          mode,
          modeReason: why,
          band: { minMm, maxMm, fractionOfNozzle: [band.floor, band.ceiling] },
          layers: tops?.length ?? null,
          thinLayers: thin,
          estimate: est,
          applied: i.apply === true,
          settings: changes,
          notes,
        },
        display: [
          {
            kind: 'kv',
            rows: [
              ['mode', `${mode === 'quality' ? 'Quality' : 'Strength'} (${why})`],
              ['band', `${minMm} to ${maxMm} mm on a ${nozzle} mm nozzle`],
              ...(tops ? ([['layers', `${tops.length}, ${thin} at the thinnest height`]] as [string, Cell][]) : []),
              ...(est ? ([['time', `${fmtDuration(est.planS)}, against ${fmtDuration(est.thinS)} at ${minMm} mm and ${fmtDuration(est.thickS)} at ${maxMm} mm`]] as [string, Cell][]) : []),
              ['applied', i.apply ? { text: 'on for this plate', tone: 'ok' } : { text: 'not yet', tone: 'dim' }],
            ],
          },
          ...(rows.length ? [{ kind: 'table' as const, head: ['height', 'layer', 'why'], rows }] : []),
          ...(notes.length ? [{ kind: 'log' as const, lines: notes.map((t) => ({ text: t, tone: 'dim' as const })) }] : []),
        ],
        ...(i.apply ? { diff: { title: 'sleipnir on this plate. The saved profile is unchanged.', scope: 'plate' as const, rows: Object.entries(changes).map(([key, v]) => ({ key, before: null, after: String(v) })) } } : {}),
        citations: ctx.kb.cite(band.sources),
      }
    },
  })
}
