// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// region_modifiers: settings that apply only where they matter (around holes, on thin walls, on flat tops, on
// overhangs). Without `apply` it plans. With `apply` it changes the project:
// - Settings that act only on their feature anyway (ironing top surfaces, overhang slowdown, thin wall detection) go
//   on the object as its own settings.
// - Settings that would change the whole object (more walls, a slower outer wall) go in modifier volumes: a ring
//   around each hole the caller names, or a box, cylinder or sphere region it names. Where no place is named they stay
//   a plan, and the answer says so.
import type { Cell, SettingValue, ToolDisplay } from '@slicerx/contracts'
import { z } from 'zod'
import type { PilotProject, VolumeShape, VolumeSpec } from '../../src/project'
import { defineSkill, type ToolContext } from '../../src/tool'
import { pickObject } from '../common'

const GOALS = ['strong_holes', 'thin_walls', 'flat_tops', 'overhangs'] as const
type Goal = (typeof GOALS)[number]

/** How far past a hole's edge the stronger walls reach, mm. */
export const HOLE_RING_MM = 3
/** Walls added around a hole. */
export const HOLE_EXTRA_WALLS = 2

const PLAN_NOTE = 'This is a plan. Ask to apply it: settings that act only on their feature go on the object, and the rest go in modifier volumes where you name the place (each hole, or a region).'
const NO_HOST_NOTE = 'This project cannot hold volumes or object settings here, so nothing was applied.'

interface Rule {
  region: string
  why: string
  find: string
  set: (base: (k: string, d: number) => number) => { key: string; value: SettingValue; reason: string }[]
  /** Keys that act only on the goal's feature, so they can go on the whole object with the same effect. */
  objectWide: readonly string[]
}

const RULES: Record<Goal, Rule> = {
  strong_holes: {
    region: `each hole and a ${HOLE_RING_MM} mm ring around it`,
    why: 'Holes take screw and load stress; extra walls there add strength without adding infill everywhere.',
    find: 'walls perimeters strength',
    set: (b) => [{ key: 'wall_loops', value: b('wall_loops', 2) + HOLE_EXTRA_WALLS, reason: `${HOLE_EXTRA_WALLS} more walls around the hole` }],
    objectWide: [],
  },
  thin_walls: {
    region: 'walls thinner than two line widths',
    why: 'Thin features need slower, filled walls to stay round and attached.',
    find: 'thin wall',
    set: (b) => [
      { key: 'detect_thin_wall', value: true, reason: 'Print thin walls as single extrusions instead of dropping them' },
      { key: 'outer_wall_speed', value: Math.max(20, Math.round(b('outer_wall_speed', 100) * 0.6)), reason: 'Slower outer walls on small features' },
    ],
    objectWide: ['detect_thin_wall'],
  },
  flat_tops: {
    region: 'flat top surfaces',
    why: 'Ironing smooths only the top faces, so the rest of the part keeps its speed.',
    find: 'ironing',
    set: () => [
      { key: 'ironing_type', value: 'top', reason: 'Iron the top surfaces only' },
      { key: 'ironing_speed', value: 20, reason: 'Slow pass over the top layer' },
    ],
    objectWide: ['ironing_type', 'ironing_speed'],
  },
  overhangs: {
    region: 'faces steeper than 45 degrees from vertical',
    why: 'Overhangs sag at full speed; slowing only those faces keeps the print time close to normal.',
    find: 'overhang',
    set: (b) => [
      { key: 'enable_overhang_speed', value: true, reason: 'Slow down on overhanging walls' },
      { key: 'outer_wall_speed', value: Math.max(20, Math.round(b('outer_wall_speed', 100) * 0.5)), reason: 'Half speed on overhang walls' },
    ],
    objectWide: ['enable_overhang_speed'],
  },
}

const vec3 = z.tuple([z.number(), z.number(), z.number()])
const shapeInput = z.union([
  z.object({ box: vec3.describe('Size in mm, X, Y and Z') }),
  z.object({ cylinder: z.object({ diameter: z.number().positive(), height: z.number().positive() }).describe('Upright along Z') }),
  z.object({ sphere: z.object({ diameter: z.number().positive() }) }),
])

const input = z.object({
  goals: z.array(z.enum(GOALS)).min(1).max(4).describe('What to make better'),
  objectId: z.string().optional().describe('Object the plan is for; defaults to the first object'),
  apply: z.boolean().default(false).describe('Change the project: object settings, and modifier volumes where a place is named. Default: plan only'),
  holes: z
    .array(
      z.object({
        center: vec3.describe("The hole's center on its axis, mm, in the object's own coordinates (as modeled)"),
        diameter: z.number().positive().max(200).describe('Hole diameter, mm'),
        depth: z.number().positive().optional().describe("How deep the ring goes, mm, centered on center; default the object's height"),
      }),
    )
    .max(64)
    .default([])
    .describe(`For strong_holes: each hole, upright along Z. A modifier ring ${HOLE_RING_MM} mm past its edge gets ${HOLE_EXTRA_WALLS} more walls`),
  regions: z
    .array(z.object({ goal: z.enum(GOALS), shape: shapeInput, center: vec3.describe("Center in the object's own coordinates, mm") }))
    .max(32)
    .default([])
    .describe("Places for a goal's settings that would otherwise change the whole object (slower outer walls on thin walls or overhangs, more walls)"),
})
type Input = z.infer<typeof input>

interface Change {
  key: string
  label: string
  before: SettingValue | null
  after: SettingValue
  reason: string
}

interface Placement {
  goal: Goal
  spec: VolumeSpec
  /** In words, with the numbers: what it is and where. */
  what: string
}

interface Plan {
  object: { id: string; name: string } | null
  modifiers: { goal: Goal; region: string; why: string; changes: Change[] }[]
  objectSettings: Record<string, SettingValue>
  volumes: Placement[]
  /** What stays a plan, and why. */
  left: { goal: Goal; keys: string[]; why: string }[]
  sources: Set<string>
}

const mm = (v: number): string => `${Math.round(v * 100) / 100}`
const at = (c: readonly number[]): string => `[${c.map(mm).join(', ')}]`

function shapeOf(s: z.infer<typeof shapeInput>): { shape: VolumeShape; words: string } {
  if ('box' in s) return { shape: { kind: 'box', sizeMm: s.box }, words: `box ${s.box.map(mm).join(' x ')} mm` }
  if ('cylinder' in s) return { shape: { kind: 'cylinder', diameterMm: s.cylinder.diameter, heightMm: s.cylinder.height }, words: `cylinder ${mm(s.cylinder.diameter)} mm across, ${mm(s.cylinder.height)} mm tall` }
  return { shape: { kind: 'sphere', diameterMm: s.sphere.diameter }, words: `sphere ${mm(s.sphere.diameter)} mm across` }
}

function settingsOf(changes: Change[], keys?: readonly string[]): Record<string, SettingValue> {
  return Object.fromEntries(changes.filter((c) => !keys || keys.includes(c.key)).map((c) => [c.key, c.after]))
}

/** The plan, and with `apply` what it puts where. Pure: nothing changes here. */
function plan(i: Input, ctx: ToolContext): Plan {
  const obj = pickObject(ctx, i.objectId)
  const cfg: Record<string, SettingValue> = ctx.project ? { ...ctx.project.config(ctx.project.plates()[0]?.index ?? 1), ...ctx.project.overrides() } : {}
  const base = (k: string, d: number): number => {
    const v = cfg[k]
    const x = Array.isArray(v) ? v[0] : v
    return typeof x === 'number' ? x : d
  }
  const sources = new Set<string>()
  const modifiers = [...new Set(i.goals)].map((g) => {
    const rule = RULES[g]
    const changes = rule.set(base).flatMap((c): Change[] => {
      const def = ctx.kb.setting(c.key)
      if (!def) return []
      let value = c.value
      if (typeof value === 'number' && def.bounds) value = Math.min(def.bounds.max ?? value, Math.max(def.bounds.min ?? value, value))
      const b = cfg[c.key]
      const before = Array.isArray(b) ? ((b[0] as SettingValue | undefined) ?? null) : (b ?? null)
      return [{ key: c.key, label: def.label, before, after: value, reason: c.reason }]
    })
    for (const h of ctx.kb.search(rule.find, { kinds: ['workflow', 'troubleshoot'], limit: 1 })) for (const s of h.doc.sources.slice(0, 2)) sources.add(s)
    return { goal: g, region: rule.region, why: rule.why, changes }
  })
  const out: Plan = { object: obj ? { id: obj.id, name: obj.name } : null, modifiers, objectSettings: {}, volumes: [], left: [], sources }
  if (!i.apply || !obj) return out
  for (const m of modifiers) {
    const rule = RULES[m.goal]
    Object.assign(out.objectSettings, settingsOf(m.changes, rule.objectWide))
    const local = m.changes.filter((c) => !rule.objectWide.includes(c.key))
    if (!local.length) continue
    const settings = settingsOf(local)
    const words = local.map((c) => `${c.key} ${String(c.before ?? 'unset')} -> ${String(c.after)}`).join(', ')
    let placed = 0
    if (m.goal === 'strong_holes') {
      for (const h of i.holes ?? []) {
        const diameter = h.diameter + 2 * HOLE_RING_MM
        const height = h.depth ?? obj.bboxMm[2]
        out.volumes.push({
          goal: m.goal,
          spec: { role: 'modifier', name: `Hole ring ${mm(h.diameter)} mm`, shape: { kind: 'cylinder', diameterMm: diameter, heightMm: height }, centerMm: h.center, settings },
          what: `cylinder ${mm(diameter)} mm across (the ${mm(h.diameter)} mm hole plus a ${HOLE_RING_MM} mm ring), ${mm(height)} mm tall, at ${at(h.center)}: ${words}`,
        })
        placed++
      }
    }
    for (const r of (i.regions ?? []).filter((x) => x.goal === m.goal)) {
      const { shape, words: shapeWords } = shapeOf(r.shape)
      out.volumes.push({ goal: m.goal, spec: { role: 'modifier', name: `${m.goal.replace('_', ' ')} region`, shape, centerMm: r.center, settings }, what: `${shapeWords} at ${at(r.center)}: ${words}` })
      placed++
    }
    if (!placed) {
      out.left.push({
        goal: m.goal,
        keys: local.map((c) => c.key),
        why:
          m.goal === 'strong_holes'
            ? 'No holes were named. Give each hole (center and diameter) to put a ring of stronger walls around it.'
            : `On the whole object it would change every ${local.map((c) => c.label.toLowerCase()).join(' and ')}. Name a region to put it only there.`,
      })
    }
  }
  return out
}

function canApply(p: PilotProject | undefined): p is PilotProject & Required<Pick<PilotProject, 'addVolume' | 'setObjectSettings'>> {
  return Boolean(p?.addVolume && p.setObjectSettings)
}

export function createRegionModifiers() {
  return defineSkill({
    name: 'region_modifiers',
    version: '0.2.0',
    permission: 'slice',
    description: `Settings for a goal only where it matters, such as strong screw holes without slowing the whole part. Goals: strong_holes, thin_walls, flat_tops, overhangs. Without apply it returns the plan (region, keys, values, why). With apply: settings that act only on their feature (ironing top surfaces, overhang slowdown, thin wall detection) go on the object; settings that would change the whole object go in modifier volumes, a ring ${HOLE_RING_MM} mm past each named hole with ${HOLE_EXTRA_WALLS} more walls, or a named box, cylinder or sphere region. Positions are in the object's own coordinates (as modeled), mm, holes upright along Z. What has no place named stays a plan, and the answer says which. Never starts a print.`,
    input,
    args: (i) => `--goals ${i.goals.join(',')}${i.apply ? ' --apply' : ''}`,
    async approval(i, ctx) {
      const p = plan(i, ctx)
      const lines = [
        ...Object.entries(p.objectSettings).map(([k, v]) => `${p.object?.name ?? 'Object'}: ${k} = ${JSON.stringify(v)}`),
        ...p.volumes.map((v) => `Modifier: ${v.what}`),
        ...p.left.map((l) => `Not placed (${l.goal}): ${l.keys.join(', ')}`),
      ]
      const n = p.volumes.length
      return {
        title: i.apply ? `Add ${n} modifier${n === 1 ? '' : 's'} and ${Object.keys(p.objectSettings).length} object settings to ${p.object?.name ?? 'the object'}?` : 'Plan region settings?',
        lines: lines.length ? lines : ['Plan only, nothing changes'],
        actions: [],
      }
    },
    async run(i, ctx) {
      const p = plan(i, ctx)
      const total = p.modifiers.reduce((a, m) => a + m.changes.length, 0)
      const rows: Cell[][] = p.modifiers.flatMap((m) => m.changes.map((c, k): Cell[] => [k === 0 ? m.goal : '', k === 0 ? m.region : '', c.key, c.before === null ? 'unset' : String(c.before), String(c.after), c.reason]))
      const table: ToolDisplay = { kind: 'table', head: ['goal', 'region', 'setting', 'now', 'in region', 'why'], rows }
      const citations = ctx.kb.cite(p.sources)
      const project = ctx.project
      if (!i.apply || !p.object || !canApply(project)) {
        const note = i.apply && p.object ? NO_HOST_NOTE : PLAN_NOTE
        return {
          summary: `Plan only, nothing applied: ${p.modifiers.length} region ${p.modifiers.length === 1 ? 'modifier' : 'modifiers'}, ${total} settings`,
          output: { applied: false, note, object: p.object, modifiers: p.modifiers },
          display: [{ kind: 'text', text: note }, table],
          citations,
        }
      }
      const object = p.object
      if (Object.keys(p.objectSettings).length) project.setObjectSettings(object.id, p.objectSettings)
      const placed = []
      for (const v of p.volumes) {
        const { id } = await project.addVolume(object.id, v.spec)
        placed.push({ id, goal: v.goal, role: v.spec.role, shape: v.spec.shape, centerMm: v.spec.centerMm, settings: v.spec.settings ?? {}, what: v.what })
      }
      // Read-back: the object as the project holds it now.
      const readBack = { objectSettings: project.objectSettings?.(object.id) ?? null, volumes: project.volumes?.(object.id) ?? null }
      const nSettings = Object.keys(p.objectSettings).length
      const applied = placed.length > 0 || nSettings > 0
      const lines = [
        ...Object.entries(p.objectSettings).map(([k, v]) => `${object.name}: ${k} = ${JSON.stringify(v)}`),
        ...placed.map((v) => `Modifier ${v.id}: ${v.what}`),
        ...p.left.map((l) => `Not placed (${l.goal}): ${l.why}`),
      ]
      const leftText = p.left.length ? `; ${p.left.map((l) => l.goal).join(', ')} left as a plan` : ''
      return {
        summary: applied ? `${placed.length} modifier${placed.length === 1 ? '' : 's'} and ${nSettings} object settings on ${object.name}${leftText}` : `Nothing applied: ${p.left.map((l) => l.goal).join(', ')} need a place named`,
        output: { applied, object, objectSettings: p.objectSettings, volumes: placed, left: p.left, readBack, modifiers: p.modifiers },
        display: [{ kind: 'text', text: lines.join('\n') }, table],
        citations,
      }
    },
  })
}
