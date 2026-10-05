// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// optimize_to_target: slices many real candidates over layer height, walls,
// infill and (optionally) orientation to hit a time, filament or cost limit,
// and shows the best few with their tradeoffs. Changes the project only when
// asked to apply.
import type { Cell, PrintConfig, SettingsDiff, SettingValue } from '@slicerx/contracts'
import { z } from 'zod'
import { parseIntent, type SettingTarget } from '../../src/intent'
import type { KnowledgeBase } from '../../src/kb/kb'
import { rotatedBox } from '../../src/memory-project'
import { fmtDuration, fmtGrams, fmtMoney } from '../../src/shared'
import { defineSkill } from '../../src/tool'
import { fmtValue, guardedOutOfRange } from '../../src/tools/settings'
import { round } from '../common'
import { AXIS_ORIENTATIONS, composeRotation, currentRotation, placesObject, rotateItems, type Rot } from '../orientation_search/geometry'
import { checkChanges, plateStrength, type ChangeValue } from './proxy'
import { layerHeights, searchSpace, violation, type DimValue, type Metrics, type Objective, type SearchDim, type Target } from './search'

const SEARCH_KEYS = ['layer_height', 'wall_loops', 'sparse_infill_density', 'sparse_infill_pattern'] as const
const INFILL = [5, 10, 15, 20, 25, 30, 40, 50, 60]
const WALLS = [2, 3, 4, 5, 6]
const STRONG_PATTERNS = ['gyroid', 'grid', 'cubic']
const LIGHT_PATTERNS = ['grid', 'gyroid', 'lightning']
const BOUNDS_SOURCE = 'orca_src:src/libslic3r/PrintConfig.cpp'

export interface GoalBounds {
  /** Per search key: lowest, highest or fixed value from the goals. */
  floors: Record<string, { min?: number; max?: number; set?: ChangeValue }>
  /** Editable keys outside the search that the goals ask for. */
  extras: Record<string, ChangeValue>
  /** Guarded keys the goals mention; shown, never applied here. */
  guarded: SettingTarget[]
  sources: string[]
}

/** Goal floors from the intent knowledge (via parseIntent), split into search bounds and extra settings. */
export function goalBounds(kb: KnowledgeBase, goals: { id: string; level?: string | undefined }[], today: string, machine: { nozzle: number; material?: string | undefined }, base: Record<string, SettingValue>): GoalBounds {
  const out: GoalBounds = { floors: {}, extras: {}, guarded: [], sources: [] }
  if (goals.length === 0) return out
  const words: string[] = []
  for (const g of goals) {
    const doc = kb.get('intent', g.id)
    const phrases = Array.isArray(doc?.data['phrases']) ? (doc.data['phrases'] as unknown[]).filter((p): p is string => typeof p === 'string') : []
    const word = phrases[0] ?? g.id.replaceAll('_', ' ')
    words.push(g.level === 'max' ? `very ${word}` : g.level === 'draft' ? `draft ${word}` : word)
  }
  const opts: { nozzle: number; material?: string } = { nozzle: machine.nozzle }
  if (machine.material) opts.material = machine.material
  const intent = parseIntent(words.join(', '), kb, today, opts)
  const wanted = new Set(goals.map((g) => g.id))
  for (const t of intent.targets) {
    if (!wanted.has(t.goal)) continue
    out.sources.push(...t.sources)
    if ((SEARCH_KEYS as readonly string[]).includes(t.key)) {
      const f = (out.floors[t.key] ??= {})
      if (t.op === 'at_least' && typeof t.value === 'number') f.min = Math.max(f.min ?? -Infinity, t.value)
      else if (t.op === 'at_most' && typeof t.value === 'number') f.max = Math.min(f.max ?? Infinity, t.value)
      else if (t.op === 'set') f.set = t.value
      continue
    }
    const def = kb.setting(t.key)
    if (def?.pilot === 'guarded') {
      out.guarded.push(t)
      continue
    }
    if (def?.pilot !== 'edit') continue
    const cur = base[t.key]
    const curN = typeof cur === 'number' ? cur : Array.isArray(cur) && typeof cur[0] === 'number' ? cur[0] : undefined
    if (t.op === 'at_least' && typeof t.value === 'number') {
      if (curN === undefined || curN < t.value) out.extras[t.key] = t.value
    } else if (t.op === 'at_most' && typeof t.value === 'number') {
      if (curN === undefined || curN > t.value) out.extras[t.key] = t.value
    } else out.extras[t.key] = t.value
  }
  out.sources = [...new Set(out.sources)]
  return out
}

function bounded(values: number[], f: { min?: number; max?: number } | undefined): number[] {
  if (!f) return values
  const lo = f.min ?? -Infinity
  const hi = f.max ?? Infinity
  const kept = values.filter((v) => v >= lo && v <= hi)
  if (kept.length) return kept
  return [Number.isFinite(lo) ? lo : hi]
}

const numOf = (v: SettingValue | undefined): number | undefined => {
  const x = Array.isArray(v) ? v[0] : v
  return typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : undefined
}

const same = (a: SettingValue | undefined, b: ChangeValue): boolean => {
  const an = numOf(a)
  return an !== undefined && typeof b === 'number' ? Math.abs(an - b) < 1e-9 : String(Array.isArray(a) ? a[0] : a) === String(b)
}

export function createOptimizeToTarget() {
  return defineSkill({
    name: 'optimize_to_target',
    version: '1.0.0',
    permission: 'slice',
    description:
      'Hit a print target by slicing many real candidates: under a time limit, under a filament or cost limit, or strongest (or fastest, lightest, cheapest) within a limit. Searches layer height (25 to 75 percent of the nozzle), wall loops, infill density and pattern, and optionally the six axis orientations, inside knowledge bounds and the floors of any kb.intent goals. Keys the user will not trade go in keep or fixed. Returns the best 3 to 5 candidates with time, grams, cost, a strength proxy and the changed keys. Changes the project only when apply is true. Use it for "make this under 2 hours but as strong as possible" or "cheapest way to print this under 40 g".',
    input: z.object({
      plate: z.number().int().min(1).optional().describe('Plate number; default the first plate'),
      maxTimeS: z.number().positive().optional().describe('Print time limit in seconds (2 hours is 7200)'),
      maxGrams: z.number().positive().optional().describe('Filament limit in grams'),
      maxCost: z.number().positive().optional().describe('Filament cost limit in the project currency'),
      objective: z.enum(['strength', 'time', 'grams', 'cost']).optional().describe('What to make best inside the limits. Default: strength when a limit is given, time when none is'),
      keep: z.array(z.string()).optional().describe('Orca keys the user will not trade, held at their current values, such as ["wall_loops"]'),
      fixed: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional().describe('Orca keys held at given values, such as {"layer_height": 0.2}'),
      goals: z.array(z.object({ id: z.string(), level: z.string().optional() })).optional().describe('Goals from kb.intent (strength, speed, detail, economy); their floors bound the search'),
      orientation: z.boolean().optional().describe('Also try the six axis rotations of the parts on the plate'),
      patterns: z.array(z.string()).optional().describe('Infill patterns to try, Orca values; default gyroid, grid and cubic when strength matters'),
      maxCandidates: z.number().int().min(10).max(2000).optional().describe('Most slices to try (default 240)'),
      timeLimitS: z.number().min(1).max(300).optional().describe('Wall clock cap for the search in seconds (default 20)'),
      apply: z.boolean().optional().describe('Apply the best candidate that meets the target to the project; default false, which only reports'),
    }),
    args: (i) =>
      [
        i.maxTimeS ? `--max-time ${fmtDuration(i.maxTimeS).replace(' ', '')}` : null,
        i.maxGrams ? `--max-grams ${i.maxGrams}` : null,
        i.maxCost ? `--max-cost ${i.maxCost}` : null,
        i.objective ? `--objective ${i.objective}` : null,
        i.keep?.length ? `--keep ${i.keep.join(',')}` : null,
        i.orientation ? '--orientation' : null,
        i.apply ? '--apply' : null,
      ]
        .filter(Boolean)
        .join(' '),
    async mustAsk(i, ctx) {
      if (!i.apply || !i.fixed) return []
      const material = ctx.project?.machine()?.material ?? ctx.context.machine?.material
      return guardedOutOfRange(i.fixed, material, ctx.kb)
    },
    async run(i, ctx) {
      const project = ctx.project
      if (!project) return { ok: false, summary: 'No project is open' }
      const slicer = ctx.host.slicer
      if (!slicer) return { ok: false, summary: 'No slicer on this host' }
      const plateIdx = i.plate ?? project.plates()[0]?.index
      if (plateIdx === undefined || !project.plates().some((p) => p.index === plateIdx)) return { ok: false, summary: 'No plate to optimize. Run arrange first.' }
      const machine = project.machine() ?? ctx.context.machine
      const base: PrintConfig = project.config(plateIdx)
      const nozzle = machine?.nozzle ?? numOf(base.nozzle_diameter) ?? 0.4
      const hasLimit = i.maxTimeS !== undefined || i.maxGrams !== undefined || i.maxCost !== undefined
      const objective: Objective = i.objective ?? (hasLimit ? 'strength' : 'time')
      const target: Target = { maxTimeS: i.maxTimeS, maxGrams: i.maxGrams, maxCost: i.maxCost, objective }
      const notes: string[] = []
      const sources = new Set<string>([BOUNDS_SOURCE])

      // Held keys.
      const fixedChecked = checkChanges(ctx.kb, i.fixed ?? {})
      for (const r of fixedChecked.rejected) notes.push(`Not held: ${r}`)
      const held: Record<string, ChangeValue> = { ...fixedChecked.accepted }
      for (const k of i.keep ?? []) {
        const v = base[k]
        const x = Array.isArray(v) ? v[0] : v
        if (typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') held[k] = x
      }

      // Goal floors.
      const goals = goalBounds(ctx.kb, i.goals ?? [], ctx.today, { nozzle, material: machine?.material }, base)
      for (const s of goals.sources) sources.add(s)
      for (const t of goals.guarded) notes.push(`The ${t.goal} goal also suggests ${t.key} ${t.op.replace('_', ' ')} ${String(t.value)}; that is a guarded setting, so apply it with settings.apply if wanted.`)
      const extras: Record<string, ChangeValue> = {}
      for (const [k, v] of Object.entries(goals.extras)) if (!(k in held)) extras[k] = v
      const strengthMatters = objective === 'strength' || (i.goals ?? []).some((g) => g.id === 'strength') || goals.floors['wall_loops']?.min !== undefined
      if (strengthMatters) sources.add('cnckitchen_extrusion_width')

      // Search dimensions.
      const dims: SearchDim[] = []
      const lhDef = ctx.kb.setting('layer_height')
      const addDim = (key: string, values: DimValue[]): void => {
        if (key in held) return
        const f = goals.floors[key]
        if (f?.set !== undefined && typeof f.set !== 'boolean') {
          held[key] = f.set
          return
        }
        if (values.length === 1 && values[0] !== undefined) {
          held[key] = values[0]
          return
        }
        if (values.length) dims.push({ key, values })
      }
      addDim('layer_height', bounded(layerHeights(nozzle, lhDef?.bounds), goals.floors['layer_height']))
      const wb = ctx.kb.setting('wall_loops')?.bounds
      addDim('wall_loops', bounded(WALLS.filter((w) => w >= (wb?.min ?? 1) && w <= (wb?.max ?? 20)), goals.floors['wall_loops']))
      addDim('sparse_infill_density', bounded(INFILL, goals.floors['sparse_infill_density']))
      const known = ctx.kb.setting('sparse_infill_pattern')?.values ?? []
      let patterns = (i.patterns?.length ? i.patterns : strengthMatters ? STRONG_PATTERNS : LIGHT_PATTERNS).filter((p) => known.length === 0 || known.includes(p))
      if (strengthMatters && patterns.includes('lightning')) {
        patterns = patterns.filter((p) => p !== 'lightning')
        notes.push('Lightning infill was left out because strength matters; it only holds up the top skin.')
      }
      if (patterns.length === 0) patterns = ['gyroid']
      addDim('sparse_infill_pattern', patterns)
      const orientations = i.orientation ? AXIS_ORIENTATIONS : []
      if (orientations.length) dims.push({ key: 'orientation', values: orientations.map((o) => o.name) })

      // Evaluation: a real slice per candidate on a copy of the plate.
      const plate0 = await project.plate(plateIdx)
      const objs = project.objects()
      const boxes = (rot: Rot | null): [number, number, number][] =>
        plate0.objects.map((po) => {
          const b = objs.find((o) => placesObject(po, o.id))?.bboxMm ?? [20, 20, 20]
          return rot ? rotatedBox(b, rot) : b
        })
      const maxCandidates = i.maxCandidates ?? 240
      const limitS = i.timeLimitS ?? 20
      const t0 = performance.now()
      let slices = 0
      let failures = 0
      const sliceOne = async (changes: Record<string, ChangeValue>, rot: Rot | null): Promise<Metrics | null> => {
        const config: PrintConfig = { ...base, ...changes }
        const plate = rot && rot.some((d) => d !== 0) ? rotateItems(plate0, rot) : plate0
        try {
          const res = await slicer.slice({ plate, config }, { signal: ctx.signal })
          slices++
          try {
            slicer.release(res.id)
          } catch {
            // Releasing is housekeeping; a host that cannot release keeps the result.
          }
          return { timeS: res.stats.timeS, grams: res.stats.filamentG.reduce((a, b) => a + b, 0), cost: res.stats.cost, strength: plateStrength(boxes(rot), config) }
        } catch {
          failures++
          return null
        }
      }
      const changesFor = (values: DimValue[]): { changes: Record<string, ChangeValue>; rot: Rot | null; orient: string | null } => {
        const changes: Record<string, ChangeValue> = { ...extras, ...held }
        let rot: Rot | null = null
        let orient: string | null = null
        for (let k = 0; k < dims.length; k++) {
          const d = dims[k]
          const v = values[k]
          if (!d || v === undefined) continue
          if (d.key === 'orientation') {
            const o = orientations.find((x) => x.name === v)
            if (o) {
              rot = o.rotate
              orient = o.name
            }
          } else changes[d.key] = v
        }
        return { changes, rot, orient }
      }

      ctx.progress('slicing the current settings', 0)
      const baseline = await sliceOne({}, null)
      if (!baseline) return { ok: false, summary: 'The slicer could not slice this plate with the current settings' }
      const result = await searchSpace({
        dims,
        target,
        maxCandidates,
        stop: () => ctx.signal.aborted || (performance.now() - t0) / 1000 > limitS,
        evaluate: async (values) => {
          const c = changesFor(values)
          return sliceOne(c.changes, c.rot)
        },
        onProgress: (n, phase) => {
          if (n % 10 === 0) ctx.progress(`${phase}: ${n} candidates sliced`, Math.min(1, n / maxCandidates))
        },
      })
      const elapsed = (performance.now() - t0) / 1000
      if (result.evaluated.length === 0) return { ok: false, summary: `No candidate sliced (${failures} failed)` }

      // Best few, described by what they change from the current config.
      const top = result.evaluated.slice(0, 5).map((e, k) => {
        const c = changesFor(e.idx.map((x, d) => dims[d]?.values[x] ?? ''))
        const changed: Record<string, ChangeValue> = {}
        for (const [key, v] of Object.entries(c.changes)) if (!same(base[key], v)) changed[key] = v
        return { rank: k + 1, metrics: e.metrics, fits: violation(e.metrics, target) === 0, changed, rot: c.rot, orient: c.orient }
      })
      const best = top[0]
      const pct = (s: number): number => Math.round((s / Math.max(1e-9, baseline.strength)) * 100)
      const changeText = (t: (typeof top)[number]): string => [...Object.entries(t.changed).map(([k, v]) => `${k}=${String(v)}`), ...(t.orient && t.rot?.some((d) => d !== 0) ? [`orientation: ${t.orient}`] : [])].join(', ') || 'no change'
      if (best && !best.fits) notes.push('No candidate meets every limit. The closest ones are shown; loosen a limit or free a held key.')
      if (failures) notes.push(`${failures} candidates failed to slice and were skipped.`)
      if (result.stoppedBy === 'time') notes.push(`Stopped at the ${limitS} s time cap after ${slices} slices.`)
      if (orientations.length) notes.push('Orientation candidates rotate the parts about their origin; the host drops them onto the bed.')
      const baseRow: Cell[] = ['current', fmtDuration(baseline.timeS), fmtGrams(baseline.grams), fmtMoney(baseline.cost), '100%', violation(baseline, target) === 0 ? { text: 'yes', tone: 'ok' } : { text: 'no', tone: 'bad' }, '']
      const rows: Cell[][] = [
        baseRow,
        ...top.map((t): Cell[] => [String(t.rank), fmtDuration(t.metrics.timeS), fmtGrams(t.metrics.grams), fmtMoney(t.metrics.cost), `${pct(t.metrics.strength)}%`, t.fits ? { text: 'yes', tone: 'ok' } : { text: 'no', tone: 'bad' }, changeText(t)]),
      ]

      // Apply only on request, and only a candidate that meets the target.
      let diff: SettingsDiff | undefined
      let applied = false
      if (i.apply && best?.fits) {
        const before: Record<string, SettingValue> = { ...base }
        if (Object.keys(best.changed).length) project.setOverrides(best.changed)
        if (best.rot && best.rot.some((d) => d !== 0) && project.setRotation) {
          const ids = new Set(objs.filter((o) => plate0.objects.some((po) => placesObject(po, o.id))).map((o) => o.id))
          for (const id of ids) project.setRotation(id, composeRotation(currentRotation(project, id), best.rot), best.orient ?? undefined)
        }
        applied = true
        diff = {
          title: `Best of ${result.evaluated.length} sliced candidates. The saved profile is unchanged.`,
          scope: 'project',
          rows: Object.entries(best.changed).map(([key, v]) => {
            const b = before[key]
            const unit = ctx.kb.setting(key)?.unit
            return { key, before: b === undefined ? null : fmtValue(Array.isArray(b) && b.length === 1 ? (b[0] as SettingValue) : b, unit), after: fmtValue(v as SettingValue, unit), reason: `optimize_to_target, ${objective}` }
          }),
        }
      } else if (i.apply) notes.push('Nothing was applied because no candidate meets the target.')

      const targetText = [i.maxTimeS ? `under ${fmtDuration(i.maxTimeS)}` : null, i.maxGrams ? `under ${i.maxGrams} g` : null, i.maxCost ? `under ${fmtMoney(i.maxCost)}` : null].filter(Boolean).join(', ') || 'no limit'
      const summary = best
        ? `${best.fits ? 'Best' : 'Closest'} of ${result.evaluated.length}: ${fmtDuration(best.metrics.timeS)}, ${fmtGrams(best.metrics.grams)}, strength ${pct(best.metrics.strength)}% of current${applied ? ', applied' : ''}`
        : 'No candidate'
      return {
        summary,
        output: {
          target: { ...target, text: targetText },
          baseline: { timeS: Math.round(baseline.timeS), grams: round(baseline.grams), cost: round(baseline.cost, 2), strength: 100 },
          candidates: top.map((t) => ({ rank: t.rank, timeS: Math.round(t.metrics.timeS), grams: round(t.metrics.grams), cost: round(t.metrics.cost, 2), strengthPct: pct(t.metrics.strength), fits: t.fits, changes: t.changed, ...(t.orient && t.rot?.some((d) => d !== 0) ? { orientation: t.orient } : {}) })),
          searched: { slices: slices, coarse: result.coarse, refined: result.refined, stoppedBy: result.stoppedBy, seconds: round(elapsed, 1), dims: dims.map((d) => ({ key: d.key, values: d.values })), held },
          applied,
          strengthProxy: 'Relative to the current settings (100). Walls times shell area, plus weighted infill and skins, scaled for layer bond. A ranking aid, not a load rating.',
          notes,
        },
        display: [
          {
            kind: 'kv',
            rows: [
              ['target', `${targetText}, best ${objective}`],
              ['searched', `${slices} slices (${result.coarse} coarse, ${result.refined} refine) in ${round(elapsed, 1)} s`],
              ['held', Object.keys(held).length ? Object.entries(held).map(([k, v]) => `${k}=${String(v)}`).join(', ') : 'nothing'],
              ['result', applied ? { text: 'applied to the project', tone: 'ok' } : best?.fits ? { text: 'not applied', tone: 'dim' } : { text: 'no candidate meets the target', tone: 'warn' }],
            ],
          },
          { kind: 'progress', items: [{ label: 'coarse grid', fraction: 1, note: `${result.coarse} candidates` }, { label: 'refine', fraction: result.stoppedBy === 'converged' ? 1 : Math.min(1, slices / maxCandidates), note: `${result.refined} candidates, stopped: ${result.stoppedBy}` }] },
          { kind: 'table', head: ['#', 'time', 'filament', 'cost', 'strength', 'meets target', 'changes'], rows },
          ...(notes.length ? [{ kind: 'log' as const, lines: notes.map((n) => ({ text: n, tone: 'warn' as const })) }] : []),
        ],
        ...(diff ? { diff } : {}),
        citations: ctx.kb.cite(sources),
      }
    },
  })
}
