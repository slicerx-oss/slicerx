// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slices project plates on the host's slicer (WASM worker pool or native core).
import type { Cell } from '@slicerx/contracts'
import { z } from 'zod'
import { fmtDuration, fmtGrams, fmtMoney, type ToolShared } from '../../src/shared'
import { defineSkill } from '../../src/tool'

export function createSlice(shared: ToolShared) {
  return defineSkill({
    name: 'slice',
    version: '2.3.1',
    permission: 'slice',
    description: 'Slice project plates with the current settings and overrides. Reports layers, print time, filament grams and cost per plate. Run arrange first for batches.',
    input: z.object({
      plates: z.array(z.number().int().min(1)).optional().describe('Plate numbers; default all'),
      profile: z.string().optional().describe('Process profile name to report, such as "0.20 Standard"'),
    }),
    args: (i) => [i.profile ? `--profile "${i.profile}"` : null, i.plates ? `--plates ${i.plates.join(',')}` : null].filter(Boolean).join(' '),
    async run(i, ctx) {
      const project = ctx.project
      if (!project) return { ok: false, summary: 'No project is open' }
      if (!ctx.host.slicer) return { ok: false, summary: 'No slicer on this host' }
      const all = project.plates()
      const indexes = i.plates ?? all.map((p) => p.index)
      for (const k of [...shared.slices.keys()]) if (!all.some((p) => p.index === k)) shared.slices.delete(k)
      if (indexes.length === 0) return { ok: false, summary: 'No plates to slice. Run arrange first.' }
      const rows: Cell[][] = []
      const progress: { label: string; fraction: number; note?: string }[] = []
      let time = 0
      let grams = 0
      let cost = 0
      let layers = 0
      for (const idx of indexes) {
        const plate = await project.plate(idx)
        const config = project.config(idx)
        const t0 = performance.now()
        const res = await ctx.host.slicer.slice(
          { plate, config, options: { emitGcode: true, emitPreview: true } },
          { onProgress: (p) => ctx.progress(`plate ${idx} ${p.stage}`, p.fraction), signal: ctx.signal },
        )
        const secs = (performance.now() - t0) / 1000
        shared.slices.set(idx, { plate: idx, result: res })
        const g = res.stats.filamentG.reduce((a, b) => a + b, 0)
        time += res.stats.timeS
        grams += g
        cost += res.stats.cost
        layers += res.layerCount
        const printer = all.find((p) => p.index === idx)?.printerId ?? ''
        progress.push({ label: `plate ${idx}`, fraction: 1, note: `${res.layerCount} layers, ${secs.toFixed(1)} s` })
        rows.push([String(idx), printer, fmtDuration(res.stats.timeS), fmtGrams(g), fmtMoney(res.stats.cost)])
        for (const w of res.warnings) rows.push(['', { text: w.code, tone: 'warn' }, { text: w.message, tone: 'warn' }, '', ''])
      }
      return {
        summary: `${indexes.length} plate${indexes.length === 1 ? '' : 's'}, ${fmtDuration(time)}, ${fmtGrams(grams)}, ${fmtMoney(cost)}`,
        output: {
          plates: indexes.map((idx) => {
            const r = shared.slices.get(idx)?.result
            return r ? { plate: idx, layers: r.layerCount, timeS: Math.round(r.stats.timeS), grams: Math.round(r.stats.filamentG.reduce((a, b) => a + b, 0) * 10) / 10, cost: Math.round(r.stats.cost * 100) / 100, warnings: r.warnings.map((w) => w.message) } : null
          }),
          total: { timeS: Math.round(time), grams: Math.round(grams * 10) / 10, cost: Math.round(cost * 100) / 100, layers },
        },
        display: [
          { kind: 'progress', items: progress },
          { kind: 'table', head: ['plate', 'printer', 'time', 'filament', 'cost'], rows },
        ],
      }
    },
  })
}
