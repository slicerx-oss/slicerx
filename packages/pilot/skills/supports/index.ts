// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// supports: decides whether to support a part and how (normal or tree, the
// threshold angle, build plate only), from the overhangs of the part as it
// sits, and keeps named faces clear where settings alone can.
import type { Cell, SettingsDiff, SettingValue } from '@slicerx/contracts'
import { z } from 'zod'
import { defineSkill } from '../../src/tool'
import { fmtValue } from '../../src/tools/settings'
import { pickObject } from '../common'
import { FACE_NAMES, currentRotation, faceExposure, overhangStats, plateOf, transformParts, type FaceDir, type FaceExposure, type OverhangStats } from '../orientation_search/geometry'
import { checkChanges } from '../optimize_to_target/proxy'

type Rec = Record<string, unknown>
const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/**
 * Support threshold angle for a layer height, from the Bambu presets in
 * knowledge/workflows/techniques/supports.yaml: 15 deg at 0.08 mm, 30 at 0.20,
 * 40 at 0.28, linear in between and held flat outside.
 */
export function thresholdForLayer(layerHeight: number): number {
  const pts: [number, number][] = [[0.08, 15], [0.2, 30], [0.28, 40]]
  const first = pts[0] ?? [0.08, 15]
  const last = pts[pts.length - 1] ?? [0.28, 40]
  if (layerHeight <= first[0]) return first[1]
  if (layerHeight >= last[0]) return last[1]
  for (let k = 1; k < pts.length; k++) {
    const [x1, y1] = pts[k] ?? last
    const [x0, y0] = pts[k - 1] ?? first
    if (layerHeight <= x1) return Math.round(y0 + ((layerHeight - x0) / (x1 - x0)) * (y1 - y0))
  }
  return last[1]
}

export interface SupportPlanInput {
  stats: OverhangStats
  threshold: number
  material: string
  /** Faces to keep clean, as they sit now. */
  protect: FaceExposure[]
  prefer?: 'normal' | 'tree' | undefined
}

export interface SupportPlan {
  changes: Record<string, string | number | boolean>
  reasons: Record<string, string>
  /** Source ids per key. */
  sources: Record<string, string[]>
  removalRisk: 'low' | 'medium' | 'high'
  notes: string[]
}

export interface SupportFacts {
  type: string[]
  style: string[]
  threshold: string[]
  plateOnly: string[]
}

/**
 * The decision, as pure code. Under 0.5 cm2 of overhang: no support. Mostly
 * flat ceilings in a few regions: normal supports (a stable grid under
 * large flat overhangs). Otherwise tree supports with the organic style,
 * which use less material. Build plate only when little overhang sits over
 * the part, or when a protected face points up under an overhang.
 */
export function planSupports(p: SupportPlanInput, facts: SupportFacts): SupportPlan {
  const plan: SupportPlan = { changes: {}, reasons: {}, sources: {}, removalRisk: 'low', notes: [] }
  const s = p.stats
  const set = (key: string, value: string | number | boolean, why: string, src: string[]): void => {
    plan.changes[key] = value
    plan.reasons[key] = why
    plan.sources[key] = src
  }
  if (s.overhangCm2 < 0.5) {
    set('enable_support', false, `Only ${s.overhangCm2} cm2 of overhang flatter than ${p.threshold} deg; it prints without support.`, facts.threshold)
    return plan
  }
  set('enable_support', true, `${s.overhangCm2} cm2 of overhang flatter than ${p.threshold} deg in ${s.regions} region${s.regions === 1 ? '' : 's'}.`, facts.threshold)
  const flat = s.flatShare >= 0.6 && s.regions <= 3
  const type = p.prefer ?? (flat ? 'normal' : 'tree')
  const protecting = p.protect.length > 0
  if (type === 'normal') {
    set('support_type', 'normal(auto)', flat ? `Mostly flat ceilings (${Math.round(s.flatShare * 100)} percent) in few regions: a normal grid is stable under large flat overhangs.` : 'Normal supports as asked.', facts.type)
    set('support_style', protecting ? 'snug' : 'default', protecting ? 'Snug normal supports hug the part and scar less.' : 'Default grid style.', facts.style)
  } else {
    set('support_type', 'tree(auto)', p.prefer === 'tree' ? 'Tree supports as asked.' : `Overhangs are spread out or sloped (${s.regions} regions, ${Math.round(s.flatShare * 100)} percent flat): trees branch to them with less material.`, facts.type)
    set('support_style', 'organic', 'Organic is the default tree style and uses the least material.', facts.style)
  }
  set('support_threshold_angle', p.threshold, `Matches the layer height, as the Bambu presets do.`, facts.threshold)
  const overPartShare = s.overhangCm2 > 0 ? s.overPartCm2 / s.overhangCm2 : 0
  const upProtected = p.protect.filter((f) => f.facing === 'up')
  if (upProtected.length && s.overPartCm2 > 0) {
    set('support_on_build_plate_only', true, `Keeps supports from starting on the ${upProtected.map((f) => f.face).join(' and ')} face.`, facts.plateOnly)
    plan.notes.push(`${s.overPartCm2} cm2 of overhang sits over the part and will print without support; check it in the preview or reorient.`)
  } else if (overPartShare <= 0.15) {
    set('support_on_build_plate_only', true, 'Almost all overhang is over the bed, so supports need not start on the part.', facts.plateOnly)
  } else {
    set('support_on_build_plate_only', false, `${s.overPartCm2} cm2 of overhang sits over the part and needs support that starts on it.`, facts.plateOnly)
  }
  if (/^petg/.test(p.material)) {
    set('support_top_z_distance', 0.25, 'PETG bonds hard to its own supports; a slightly larger top gap makes removal easier.', [])
    plan.removalRisk = 'high'
  } else if (type === 'tree' && overPartShare > 0.15) plan.removalRisk = 'medium'
  else if (type === 'normal' && s.overhangCm2 > 20) plan.removalRisk = 'medium'
  for (const f of p.protect) {
    if (f.supportedCm2 > 0.05 || (f.areaCm2 === 0 && f.facing === 'down')) {
      plan.notes.push(`The ${f.face} face points down and needs support where it overhangs. Painted support blockers need paint support in the core, which is not available yet, so settings cannot keep support off it. Reorient with orientation_search and cleanFaces ["${f.face}"].`)
    } else if (f.onBedCm2 > 0) plan.notes.push(`The ${f.face} face rests on the bed, so it takes the plate texture but no support.`)
  }
  return plan
}

export function supportFacts(guide: { data: Rec } | undefined): SupportFacts {
  const facts = (Array.isArray(guide?.data['facts']) ? (guide.data['facts'] as unknown[]) : []).map(obj)
  const find = (re: RegExp): string[] => strs(facts.find((f) => re.test(String(f['text'] ?? '')))?.['src'])
  const all = strs(guide?.data['src'])
  const or = (xs: string[]): string[] => (xs.length ? xs : all.slice(0, 1))
  return { type: or(find(/grid under overhangs/)), style: or(find(/Organic is the default/)), threshold: or([...find(/threshold angle get support/), ...find(/change the threshold with layer height/)]), plateOnly: all.slice(0, 1) }
}

export function createSupports() {
  return defineSkill({
    name: 'supports',
    version: '1.0.0',
    permission: 'slice',
    description:
      'Decide supports for a part as it sits on the bed: whether to enable them, normal or tree type and style (from how flat and how spread out the overhangs are), the threshold angle for the layer height, and support on build plate only. Can protect named faces (top, bottom, front, back, left, right in model coordinates) where settings allow; painted blockers are not available, so a face that itself needs support is left to orientation_search. Applies the settings to the project only when apply is true. Run orientation_search or orient first when the part could be turned.',
    input: z.object({
      objectId: z.string().optional().describe('Object id or name; defaults to the first object'),
      protect: z.array(z.enum(FACE_NAMES as [FaceDir, ...FaceDir[]])).optional().describe('Faces to keep free of support scars, in model coordinates'),
      prefer: z.enum(['normal', 'tree']).optional().describe('Force a support type when the user asked for one'),
      thresholdAngle: z.number().int().min(5).max(80).optional().describe('Orca support threshold angle in degrees; default from the layer height'),
      apply: z.boolean().optional().describe('Apply the support settings to the project; default false, which only reports'),
    }),
    args: (i) => [i.objectId ?? null, i.protect?.length ? `--protect ${i.protect.join(',')}` : null, i.prefer ? `--prefer ${i.prefer}` : null, i.apply ? '--apply' : null].filter(Boolean).join(' '),
    async run(i, ctx) {
      const project = ctx.project
      if (!project) return { ok: false, summary: 'No project is open' }
      const o = pickObject(ctx, i.objectId)
      if (!o) return { ok: false, summary: 'No object in the project' }
      const guide = ctx.kb.get('workflow', 'supports')
      const facts = supportFacts(guide)
      const plateIdx = plateOf(project, o.id) ?? 1
      const cfg = project.config(plateIdx)
      const lh = typeof cfg.layer_height === 'number' ? cfg.layer_height : 0.2
      const threshold = i.thresholdAngle ?? thresholdForLayer(lh)
      if (!o.mesh) {
        return {
          summary: 'No mesh access on this host, so overhangs cannot be measured; nothing changed',
          output: { note: 'Mesh data is not available to mimir here. Turn supports on by hand in the slicer if the preview shows floating overhangs.', suggestedThreshold: threshold },
          citations: ctx.kb.cite(facts.threshold),
        }
      }
      const rot = currentRotation(project, o.id)
      const modeled = await o.mesh()
      // Measure the part as it sits; Orca's threshold is the complement of the mesh check's angle.
      const placed = transformParts(modeled, rot)
      const stats = overhangStats(placed, 90 - threshold)
      const protect = (i.protect ?? []).map((f) => faceExposure(modeled, rot, f, 90 - threshold))
      const material = project.machine()?.material ?? ctx.context.machine?.material ?? ''
      const plan = planSupports({ stats, threshold, material: ctx.kb.get('filament', material)?.id ?? material, protect, prefer: i.prefer }, facts)
      const checked = checkChanges(ctx.kb, plan.changes)
      for (const r of checked.rejected) plan.notes.push(`Dropped: ${r}`)
      const changes = checked.accepted
      let diff: SettingsDiff | undefined
      if (i.apply && Object.keys(changes).length) {
        const before: Record<string, SettingValue> = { ...cfg }
        project.setOverrides(changes)
        diff = {
          title: `Support settings for ${o.name}. The saved profile is unchanged.`,
          scope: 'project',
          rows: Object.entries(changes).map(([key, v]) => {
            const b = before[key]
            const unit = ctx.kb.setting(key)?.unit
            const row: SettingsDiff['rows'][number] = { key, before: b === undefined ? null : fmtValue(b, unit), after: fmtValue(v, unit) }
            const why = plan.reasons[key]
            if (why) row.reason = why
            const src = plan.sources[key]
            if (src?.length) row.sources = src
            return row
          }),
        }
      }
      const rows: Cell[][] = Object.entries(changes).map(([k, v]) => [k, String(v), plan.reasons[k] ?? ''])
      const on = changes['enable_support'] === true
      return {
        summary: `${on ? `${String(changes['support_type'])}, ${threshold} deg${changes['support_on_build_plate_only'] === true ? ', build plate only' : ''}` : 'No supports needed'}${diff ? ', applied' : ''}`,
        output: {
          object: o.id,
          overhang: stats,
          changes,
          removalRisk: plan.removalRisk,
          protect: protect.map((f) => ({ face: f.face, facing: f.facing, supportedCm2: f.supportedCm2, onBedCm2: f.onBedCm2 })),
          applied: Boolean(diff),
          notes: plan.notes,
        },
        display: [
          { kind: 'kv', rows: [['overhang', `${stats.overhangCm2} cm2 flatter than ${threshold} deg, ${stats.regions} region${stats.regions === 1 ? '' : 's'}, ${Math.round(stats.flatShare * 100)}% flat`], ['over the part', `${stats.overPartCm2} cm2`], ['removal', { text: plan.removalRisk, tone: plan.removalRisk === 'low' ? 'ok' : 'warn' }], ['result', diff ? { text: 'applied to the project', tone: 'ok' } : { text: 'not applied', tone: 'dim' }]] },
          { kind: 'table', head: ['setting', 'value', 'why'], rows },
          ...(plan.notes.length ? [{ kind: 'log' as const, lines: plan.notes.map((t) => ({ text: t, tone: 'warn' as const })) }] : []),
        ],
        ...(diff ? { diff } : {}),
        citations: ctx.kb.cite([...Object.values(plan.sources).flat(), ...strs(guide?.data['src'])]),
      }
    },
  })
}
