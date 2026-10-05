// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// settings.plan and settings.apply. Planning is deterministic code; applying
// lands in the project (class slice) or a saved profile (class profile).
import type { SettingsDiff, SettingValue } from '@slicerx/contracts'
import { z } from 'zod'
import type { KnowledgeBase } from '../kb/kb'
import type { PlanOptions, PlanResult, SettingsPlanner } from '../planner'
import { defineTool, type PilotTool } from '../tool'

const machine = z.object({
  printer: z.string().min(1).describe('Knowledge printer id or name, such as prusa_mk4s'),
  material: z.string().min(1).describe('Knowledge filament id or name, such as petg'),
  nozzle: z.number().min(0.1).max(2).describe('Nozzle diameter in mm'),
})

/** Where each guarded key's documented range lives in a filament record. */
const GUARDED_RANGE: Record<string, string> = {
  nozzle_temperature: 'nozzle_temp_c',
  nozzle_temperature_initial_layer: 'first_layer_nozzle_temp_c',
  hot_plate_temp: 'bed_temp_c',
  textured_plate_temp: 'bed_temp_c',
  cool_plate_temp: 'bed_temp_c',
  eng_plate_temp: 'bed_temp_c',
  filament_flow_ratio: 'extrusion.flow_ratio',
  retraction_length: 'extrusion.retraction_mm.direct_drive',
  pressure_advance: 'extrusion.pressure_advance.direct_drive',
  filament_max_volumetric_speed: 'extrusion.max_volumetric_speed_mm3s.high_flow_hotend',
}

/**
 * Guarded keys (knowledge/settings.yaml) outside the loaded filament's
 * documented range. Those changes need the user even when slicing is Allow.
 */
export function guardedOutOfRange(changes: Record<string, unknown>, material: string | undefined, kb: KnowledgeBase): string[] {
  const doc = material ? kb.get('filament', material) : undefined
  const out: string[] = []
  for (const [key, raw] of Object.entries(changes)) {
    if (kb.setting(key)?.pilot !== 'guarded') continue
    const v = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseFloat(raw) : NaN
    if (!Number.isFinite(v)) continue
    const path = GUARDED_RANGE[key]
    if (!doc || !path) {
      out.push(`${key} is a guarded setting and the documented range is unknown here`)
      continue
    }
    let r: unknown = doc.data
    for (const p of path.split('.')) r = r && typeof r === 'object' ? (r as Record<string, unknown>)[p] : undefined
    const rec = r && typeof r === 'object' ? (r as Record<string, unknown>) : {}
    const min = typeof rec['min'] === 'number' ? rec['min'] : undefined
    const max = typeof rec['max'] === 'number' ? rec['max'] : undefined
    if ((min !== undefined && v < min) || (max !== undefined && v > max)) {
      out.push(`${key} ${v} is outside the ${doc.name} range of ${min ?? '?'} to ${max ?? '?'}`)
    }
  }
  return out
}

/** Units for common keys where the catalog has none. */
const LABEL_UNIT: Record<string, string> = { nozzle_temperature: 'C', sparse_infill_density: '%', fan_max_speed: '%', fan_min_speed: '%', layer_height: 'mm', retraction_length: 'mm' }

export function fmtValue(v: SettingValue | null, unit?: string): string {
  if (v === null) return 'unset'
  const s = Array.isArray(v) ? v.map((x) => (Array.isArray(x) ? x.join('x') : String(x))).join(', ') : String(v)
  if (!unit) return s
  if (unit === '%') return `${s}%`
  return `${s} ${unit}`
}

export function planToDiff(plan: PlanResult, _kb?: KnowledgeBase): SettingsDiff {
  const parts: string[] = []
  if (plan.from.material !== plan.to.material) parts.push(`${plan.from.material} to ${plan.to.material}`)
  if (plan.from.printer !== plan.to.printer) parts.push(`${plan.from.printer} to ${plan.to.printer}`)
  if (plan.from.nozzle !== plan.to.nozzle) parts.push(`${plan.from.nozzle} mm to ${plan.to.nozzle} mm nozzle`)
  const title = `${parts.length ? `Switching ${parts.join(', ')}` : 'Settings check'}: ${plan.changes.length} ${plan.changes.length === 1 ? 'change' : 'changes'}. The saved profile is unchanged.`
  return {
    title,
    scope: 'plate',
    trigger: { from: plan.from, to: plan.to },
    rows: plan.changes.map((c) => {
      const row: SettingsDiff['rows'][number] = {
        key: c.key,
        label: c.label,
        before: c.before === null ? null : fmtValue(c.before, c.unit),
        after: fmtValue(c.after, c.unit),
        reason: c.reason,
        sources: c.sources,
      }
      if (c.unit) row.unit = c.unit
      if (c.approval === 'ask') row.approval = 'ask'
      return row
    }),
  }
}

export function settingsTools(planner: SettingsPlanner | undefined): PilotTool<never>[] {
  const plan = defineTool({
    name: 'settings.plan',
    version: '1.0.0',
    source: 'settings',
    permission: 'read',
    description:
      'Recompute every setting affected by a change of material, printer or nozzle (temperatures, fan, retraction, speeds, flow, pressure advance, bed). Returns before, after and a reason with sources for each key. Deterministic, no side effects.',
    input: z.object({
      from: machine,
      to: machine,
      goals: z.array(z.object({ id: z.string(), level: z.string().optional() })).optional().describe('Goals from kb.intent (strength, speed, detail, ...), merged into the plan'),
    }),
    args: (i) => `--from ${i.from.material}@${i.from.printer}/${i.from.nozzle} --to ${i.to.material}@${i.to.printer}/${i.to.nozzle}`,
    async run(input, ctx) {
      if (!planner) return { ok: false, summary: 'No settings planner is available' }
      const project = ctx.project
      const current = project?.overrides()
      const opts: PlanOptions = {}
      if (project) opts.base = project.config(project.plates()[0]?.index ?? 1)
      if (input.goals?.length) opts.goals = input.goals.map((g) => (g.level ? { id: g.id, level: g.level } : { id: g.id }))
      const res = planner.plan(input.from, input.to, current, opts)
      const diff = planToDiff(res, ctx.kb)
      const sources = res.changes.flatMap((c) => c.sources)
      return {
        summary: `${res.changes.length} settings change${res.warnings.length ? `, ${res.warnings.length} warning${res.warnings.length === 1 ? '' : 's'}` : ''}`,
        output: {
          changes: res.changes.map(({ key, before, after, unit, reason, approval }) => ({ key, before, after, unit, reason, ...(approval === 'ask' ? { needsApproval: true } : {}) })),
          warnings: res.warnings,
          blockers: res.blockers ?? [],
          questions: res.questions ?? [],
          caveats: (res.caveats ?? []).map((c) => c.text),
          tellUser: res.tellUser ?? [],
          refused: res.refused ?? [],
          clamps: (res.clamps ?? []).map((c) => c.reason),
        },
        display: [...(res.blockers ?? []).map((b) => ({ text: b, tone: 'bad' as const })), ...res.warnings.map((w) => ({ text: w, tone: 'warn' as const })), ...(res.questions ?? []).map((q) => ({ text: q, tone: 'run' as const }))].length
          ? [{ kind: 'log', lines: [...(res.blockers ?? []).map((b) => ({ text: b, tone: 'bad' as const })), ...res.warnings.map((w) => ({ text: w, tone: 'warn' as const })), ...(res.questions ?? []).map((q) => ({ text: q, tone: 'run' as const }))] }]
          : [],
        diff,
        citations: ctx.kb.cite(sources),
      }
    },
  })

  const apply = defineTool({
    name: 'settings.apply',
    version: '1.0.0',
    source: 'settings',
    permission: 'slice',
    description:
      'Apply setting values by Orca key. target "plate" or "project" changes only the open project. target "profile" writes a saved profile and always needs the user\'s approval.',
    input: z.object({
      target: z.enum(['plate', 'project', 'profile']),
      profile: z.string().optional().describe('Saved profile name when target is profile'),
      changes: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
      reason: z.string().optional(),
    }),
    permissionFor: (i) => (i.target === 'profile' ? 'profile' : 'slice'),
    async mustAsk(i, ctx) {
      const material = ctx.project?.machine()?.material ?? ctx.context.machine?.material
      return guardedOutOfRange(i.changes, material, ctx.kb)
    },
    async approval(i) {
      const n = Object.keys(i.changes).length
      if (i.target === 'profile') {
        const profileId = i.profile ?? 'current'
        return {
          title: `Save ${n} ${n === 1 ? 'change' : 'changes'} to profile "${profileId}"?`,
          lines: Object.entries(i.changes).map(([k, v]) => `${k}: ${String(v)}`),
          actions: [{ action: 'profile.write', target: profileId, params: { profileId, changes: i.changes } }],
        }
      }
      return { title: `Apply ${n} ${n === 1 ? 'change' : 'changes'} to this project?`, lines: Object.entries(i.changes).map(([k, v]) => `${k}: ${String(v)}`), actions: [] }
    },
    args: (i) => `--target ${i.target} ${Object.entries(i.changes).map(([k, v]) => `${k}=${String(v)}`).join(' ')}`,
    async run(input, ctx) {
      const rejected: string[] = []
      const accepted: Record<string, SettingValue> = {}
      for (const [k, raw] of Object.entries(input.changes)) {
        // Models often write percents and numbers as strings ("25%", "0.2").
        const v = typeof raw === 'string' && /^-?\d+(\.\d+)?%?$/.test(raw.trim()) ? Number.parseFloat(raw) : raw
        const def = ctx.kb.setting(k)
        if (def?.pilot === 'read') {
          rejected.push(`${k} is read only for mimir`)
          continue
        }
        if (def?.bounds && typeof v === 'number') {
          const { min, max } = def.bounds
          if ((min !== undefined && v < min) || (max !== undefined && v > max)) {
            rejected.push(`${k}=${v} is outside ${min ?? '-inf'} to ${max ?? 'inf'}`)
            continue
          }
        }
        accepted[k] = v
      }
      if (input.target === 'profile') {
        if (!ctx.token) return { ok: false, summary: 'Profile writes need an approval token' }
        if (!ctx.host.profiles) return { ok: false, summary: 'This host cannot write saved profiles' }
        const profileId = input.profile ?? 'current'
        // The host verifies the token against { profileId, changes } as approved.
        await ctx.host.profiles.write(profileId, input.changes, ctx.token)
        return { summary: `Saved ${Object.keys(accepted).length} changes to ${profileId}`, output: { accepted, rejected } }
      }
      const project = ctx.project
      if (!project) return { ok: false, summary: 'No project is open' }
      const before: Record<string, SettingValue> = { ...project.config(project.plates()[0]?.index ?? 1), ...project.overrides() }
      project.setOverrides(accepted)
      const diff: SettingsDiff = {
        title: input.reason ?? 'Plate overrides. The saved profile is unchanged.',
        scope: input.target,
        rows: Object.entries(accepted).map(([key, v]) => {
          const b = before[key]
          const shown = Array.isArray(b) && b.length === 1 ? (b[0] as SettingValue) : b
          const unit = LABEL_UNIT[key] ?? ctx.kb.setting(key)?.unit
          return { key, before: shown === undefined ? null : fmtValue(shown, unit), after: fmtValue(v, unit) }
        }),
      }
      return {
        ok: rejected.length === 0 || Object.keys(accepted).length > 0,
        summary: `${Object.keys(accepted).length} applied${rejected.length ? `, ${rejected.length} rejected` : ''}`,
        output: { applied: accepted, rejected },
        diff,
      }
    },
  })
  return [plan, apply] as PilotTool<never>[]
}
