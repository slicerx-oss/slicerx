// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// region_modifiers: plan settings that apply only where they matter (around
// holes, on thin walls, on flat tops, on overhangs). Planner only: the core has
// no modifier volume API yet, so nothing here is applied.
import type { Cell, SettingValue, ToolDisplay } from '@slicerx/contracts'
import { z } from 'zod'
import { defineSkill } from '../../src/tool'
import { pickObject } from '../common'

const GOALS = ['strong_holes', 'thin_walls', 'flat_tops', 'overhangs'] as const
type Goal = (typeof GOALS)[number]

const MODIFIER_GAP = 'The core has no modifier volume API yet, so mimir cannot place these regions in the project. Apply the settings whole part with settings.apply (slower or heavier everywhere), or add the modifiers by hand in the slicer.'

interface Rule {
  region: string
  why: string
  find: string
  set: (base: (k: string, d: number) => number) => { key: string; value: SettingValue; reason: string }[]
}

const RULES: Record<Goal, Rule> = {
  strong_holes: {
    region: 'each hole and a 3 mm ring around it',
    why: 'Holes take screw and load stress; extra walls there add strength without adding infill everywhere.',
    find: 'walls perimeters strength',
    set: (b) => [{ key: 'wall_loops', value: b('wall_loops', 2) + 2, reason: 'Two more walls around the hole' }],
  },
  thin_walls: {
    region: 'walls thinner than two line widths',
    why: 'Thin features need slower, filled walls to stay round and attached.',
    find: 'thin wall',
    set: (b) => [
      { key: 'detect_thin_wall', value: true, reason: 'Print thin walls as single extrusions instead of dropping them' },
      { key: 'outer_wall_speed', value: Math.max(20, Math.round(b('outer_wall_speed', 100) * 0.6)), reason: 'Slower outer walls on small features' },
    ],
  },
  flat_tops: {
    region: 'flat top surfaces',
    why: 'Ironing smooths only the top faces, so the rest of the part keeps its speed.',
    find: 'ironing',
    set: () => [
      { key: 'ironing_type', value: 'top', reason: 'Iron the top surfaces only' },
      { key: 'ironing_speed', value: 20, reason: 'Slow pass over the top layer' },
    ],
  },
  overhangs: {
    region: 'faces steeper than 45 degrees from vertical',
    why: 'Overhangs sag at full speed; slowing only those faces keeps the print time close to normal.',
    find: 'overhang',
    set: (b) => [
      { key: 'enable_overhang_speed', value: true, reason: 'Slow down on overhanging walls' },
      { key: 'outer_wall_speed', value: Math.max(20, Math.round(b('outer_wall_speed', 100) * 0.5)), reason: 'Half speed on overhang walls' },
    ],
  },
}

export function createRegionModifiers() {
  return defineSkill({
    name: 'region_modifiers',
    version: '0.1.0',
    permission: 'slice',
    description:
      'Plan region settings for a goal such as strong screw holes without slowing the whole part: which region, which setting keys and values, and why. Goals: strong_holes, thin_walls, flat_tops, overhangs. This is a plan only. The core has no modifier volume API yet, so nothing is applied to the project and you must say so.',
    input: z.object({
      goals: z.array(z.enum(GOALS)).min(1).max(4).describe('What to make better'),
      objectId: z.string().optional().describe('Object the plan is for; defaults to the first object'),
    }),
    args: (i) => `--goals ${i.goals.join(',')}`,
    async run(i, ctx) {
      const object = pickObject(ctx, i.objectId)
      const cfg: Record<string, SettingValue> = ctx.project ? { ...ctx.project.config(ctx.project.plates()[0]?.index ?? 1), ...ctx.project.overrides() } : {}
      const base = (k: string, d: number): number => {
        const v = cfg[k]
        const x = Array.isArray(v) ? v[0] : v
        return typeof x === 'number' ? x : d
      }
      const sources = new Set<string>()
      const modifiers = [...new Set(i.goals)].map((g) => {
        const rule = RULES[g]
        const changes = rule.set(base).flatMap((c) => {
          const def = ctx.kb.setting(c.key)
          if (!def) return []
          let value = c.value
          if (typeof value === 'number' && def.bounds) value = Math.min(def.bounds.max ?? value, Math.max(def.bounds.min ?? value, value))
          const b = cfg[c.key]
          const before = Array.isArray(b) ? b[0] : b
          return [{ key: c.key, label: def.label, before: before ?? null, after: value, reason: c.reason }]
        })
        for (const h of ctx.kb.search(rule.find, { kinds: ['workflow', 'troubleshoot'], limit: 1 })) for (const s of h.doc.sources.slice(0, 2)) sources.add(s)
        return { goal: g, region: rule.region, why: rule.why, changes }
      })
      const rows: Cell[][] = modifiers.flatMap((m) => m.changes.map((c, k): Cell[] => [k === 0 ? m.goal : '', k === 0 ? m.region : '', c.key, c.before === null ? 'unset' : String(c.before), String(c.after), c.reason]))
      const display: ToolDisplay[] = [{ kind: 'text', text: MODIFIER_GAP }, { kind: 'table', head: ['goal', 'region', 'setting', 'now', 'in region', 'why'], rows }]
      return {
        summary: `Plan only, nothing applied: ${modifiers.length} region ${modifiers.length === 1 ? 'modifier' : 'modifiers'}, ${modifiers.reduce((a, m) => a + m.changes.length, 0)} settings. Applying needs the modifier API`,
        output: { applied: false, blocked: MODIFIER_GAP, object: object ? { id: object.id, name: object.name } : null, modifiers },
        display,
        citations: ctx.kb.cite(sources),
      }
    },
  })
}
