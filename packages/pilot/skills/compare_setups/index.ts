// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// compare_setups: slices one plate two ways and compares time, filament,
// cost, a strength proxy and risk notes side by side. Never changes the
// project.
import type { Cell, PrintConfig } from '@slicerx/contracts'
import { z } from 'zod'
import { fmtDuration, fmtGrams, fmtMoney } from '../../src/shared'
import { defineSkill } from '../../src/tool'
import { round } from '../common'
import { placesObject } from '../orientation_search/geometry'
import { checkChanges, configRisks, plateStrength } from '../optimize_to_target/proxy'

const changeSet = z.object({
  name: z.string().optional().describe('Short label, such as "0.6 nozzle" or "3 walls"'),
  changes: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).describe('Orca keys and values on top of the current settings; {} means the current settings'),
})

function label(set: { name?: string | undefined; changes: Record<string, unknown> }): string {
  if (set.name) return set.name
  const e = Object.entries(set.changes)
  return e.length ? e.map(([k, v]) => `${k}=${String(v)}`).join(' ') : 'current'
}

export interface SetupResult {
  name: string
  timeS: number
  grams: number
  cost: number
  strength: number
  layers: number
  risks: string[]
  rejected: string[]
}

/** One line verdict from two results: which is faster, lighter and stronger, and by how much. */
export function verdict(a: SetupResult, b: SetupResult): string {
  const rel = (x: number, y: number): number => (y === 0 ? 0 : Math.round(((x - y) / y) * 100))
  const parts: string[] = []
  const dt = rel(b.timeS, a.timeS)
  if (Math.abs(dt) >= 2) parts.push(`${dt < 0 ? b.name : a.name} is ${Math.abs(dt)}% faster`)
  const dg = rel(b.grams, a.grams)
  if (Math.abs(dg) >= 2) parts.push(`${dg < 0 ? b.name : a.name} uses ${Math.abs(dg)}% less filament`)
  const ds = rel(b.strength, a.strength)
  if (Math.abs(ds) >= 2) parts.push(`${ds > 0 ? b.name : a.name} is about ${Math.abs(ds)}% stronger by the proxy`)
  if (b.risks.length !== a.risks.length) parts.push(`${b.risks.length < a.risks.length ? b.name : a.name} has fewer risk notes`)
  return parts.length ? `${parts.join('; ')}.` : 'The two setups come out about the same.'
}

export function createCompareSetups() {
  return defineSkill({
    name: 'compare_setups',
    version: '1.0.0',
    permission: 'slice',
    description:
      'Slice the same plate two ways and compare side by side: print time, filament grams, cost, a strength proxy and risk notes, with a one line verdict. Each setup is a set of Orca keys on top of the current settings (an empty set means the current settings). Does not change the project. Use it for "is a 0.6 nozzle worth it", "3 walls at 0.28 or 2 walls at 0.2", or to check a settings plan before applying it.',
    input: z.object({
      plate: z.number().int().min(1).optional().describe('Plate number; default the first plate'),
      a: changeSet.describe('Setup A'),
      b: changeSet.describe('Setup B'),
    }),
    args: (i) => `--a "${label(i.a)}" --b "${label(i.b)}"`,
    async run(i, ctx) {
      const project = ctx.project
      if (!project) return { ok: false, summary: 'No project is open' }
      const slicer = ctx.host.slicer
      if (!slicer) return { ok: false, summary: 'No slicer on this host' }
      const plateIdx = i.plate ?? project.plates()[0]?.index
      if (plateIdx === undefined || !project.plates().some((p) => p.index === plateIdx)) return { ok: false, summary: 'No plate to compare. Run arrange first.' }
      const plate = await project.plate(plateIdx)
      const base: PrintConfig = project.config(plateIdx)
      const objs = project.objects()
      const boxes = plate.objects.map((po) => objs.find((o) => placesObject(po, o.id))?.bboxMm ?? ([20, 20, 20] as [number, number, number]))
      const machineNozzle = project.machine()?.nozzle ?? ctx.context.machine?.nozzle
      const baseStrength = plateStrength(boxes, base)
      const results: SetupResult[] = []
      const sources = new Set<string>(['orca_src:src/libslic3r/PrintConfig.cpp'])
      for (const [k, set] of [['A', i.a], ['B', i.b]] as const) {
        ctx.progress(`slicing setup ${k}`, k === 'A' ? 0 : 0.5)
        const checked = checkChanges(ctx.kb, set.changes)
        const config: PrintConfig = { ...base, ...checked.accepted }
        const nozzle = typeof config['nozzle_diameter'] === 'number' ? config['nozzle_diameter'] : Array.isArray(config.nozzle_diameter) && typeof config.nozzle_diameter[0] === 'number' ? config.nozzle_diameter[0] : machineNozzle ?? 0.4
        const res = await slicer.slice({ plate, config }, { signal: ctx.signal })
        try {
          slicer.release(res.id)
        } catch {
          // Housekeeping only.
        }
        const risks = [...configRisks(config, nozzle), ...res.warnings.map((w) => w.message)]
        if (checked.unknown.length) risks.push(`not in the settings catalog, passed through unchecked: ${checked.unknown.join(', ')}`)
        if (checked.guarded.length) risks.push(`guarded keys (need care on apply): ${checked.guarded.join(', ')}`)
        if ('nozzle_diameter' in set.changes) risks.push('a nozzle change also needs the hardware swap and a matching printer profile')
        results.push({
          name: set.name ?? `setup ${k}`,
          timeS: res.stats.timeS,
          grams: res.stats.filamentG.reduce((x, y) => x + y, 0),
          cost: res.stats.cost,
          strength: plateStrength(boxes, config),
          layers: res.layerCount,
          risks,
          rejected: checked.rejected,
        })
      }
      const [ra, rb] = results
      if (!ra || !rb) return { ok: false, summary: 'Could not slice both setups' }
      const pct = (s: number): string => `${Math.round((s / Math.max(1e-9, baseStrength)) * 100)}%`
      const delta = (x: number, y: number, fmt: (v: number) => string): Cell => {
        const d = y - x
        if (Math.abs(d) < 1e-9) return { text: 'same', tone: 'dim' }
        return { text: `${d > 0 ? '+' : '-'}${fmt(Math.abs(d))}`, tone: 'hl' }
      }
      const rows: Cell[][] = [
        ['time', fmtDuration(ra.timeS), fmtDuration(rb.timeS), delta(ra.timeS, rb.timeS, fmtDuration)],
        ['filament', fmtGrams(ra.grams), fmtGrams(rb.grams), delta(ra.grams, rb.grams, fmtGrams)],
        ['cost', fmtMoney(ra.cost), fmtMoney(rb.cost), delta(ra.cost, rb.cost, fmtMoney)],
        ['strength proxy', pct(ra.strength), pct(rb.strength), delta(ra.strength / baseStrength, rb.strength / baseStrength, (v) => `${Math.round(v * 100)} pts`)],
        ['layers', String(ra.layers), String(rb.layers), delta(ra.layers, rb.layers, (v) => String(v))],
        ['risks', ra.risks.length ? { text: ra.risks.join('; '), tone: 'warn' } : { text: 'none noted', tone: 'ok' }, rb.risks.length ? { text: rb.risks.join('; '), tone: 'warn' } : { text: 'none noted', tone: 'ok' }, ''],
      ]
      const rejected = [...ra.rejected.map((r) => `${ra.name}: ${r}`), ...rb.rejected.map((r) => `${rb.name}: ${r}`)]
      const line = verdict(ra, rb)
      if (ra.strength !== rb.strength) sources.add('cnckitchen_extrusion_width')
      return {
        summary: line,
        output: {
          plate: plateIdx,
          setups: results.map((r) => ({ name: r.name, timeS: Math.round(r.timeS), grams: round(r.grams), cost: round(r.cost, 2), strengthPct: Math.round((r.strength / baseStrength) * 100), layers: r.layers, risks: r.risks })),
          rejected,
          verdict: line,
          note: 'Strength is a proxy relative to the current settings (100): walls, infill and skins scaled for layer bond. The project was not changed.',
        },
        display: [
          { kind: 'table', head: ['', ra.name, rb.name, 'B minus A'], rows },
          { kind: 'log', lines: [{ text: line, tone: 'run' }, ...rejected.map((r) => ({ text: `ignored ${r}`, tone: 'warn' as const }))] },
        ],
        citations: ctx.kb.cite(sources),
      }
    },
  })
}
