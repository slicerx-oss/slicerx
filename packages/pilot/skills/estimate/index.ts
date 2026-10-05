// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Totals for the sliced plates: machine time, wall clock when plates run in
// parallel, filament and cost including machine time, and the finish time.
import type { Cell } from '@slicerx/contracts'
import { z } from 'zod'
import { fmtDuration, fmtGrams, fmtMoney, type ToolShared } from '../../src/shared'
import { defineSkill } from '../../src/tool'

export function createEstimate(shared: ToolShared) {
  return defineSkill({
    name: 'estimate',
    version: '1.0.0',
    permission: 'read',
    description: 'Totals for the sliced plates: machine time, wall clock when each plate runs on its own printer, filament grams, filament and machine cost, and whether it finishes before a deadline.',
    input: z.object({
      deadline: z.string().optional().describe('ISO date or date-time the job must finish by'),
      machineRatePerHour: z.number().min(0).max(100).optional().describe('Machine cost per hour when the printers have none set'),
      startAt: z.string().optional().describe('ISO date-time the plates start; default now'),
    }),
    args: (i) => [i.deadline ? `--deadline ${i.deadline}` : null].filter(Boolean).join(' '),
    async run(i, ctx) {
      const plates = ctx.project?.plates() ?? []
      const sliced = [...shared.slices.values()]
      if (sliced.length === 0) return { ok: false, summary: 'Nothing sliced yet. Run slice first.' }
      const byPrinter = new Map<string, number>()
      let machineS = 0
      let grams = 0
      let filamentCost = 0
      let machineCost = 0
      const rows: Cell[][] = []
      for (const s of sliced) {
        const printerId = plates.find((p) => p.index === s.plate)?.printerId ?? `plate-${s.plate}`
        const rate = shared.machineRates.get(printerId) ?? i.machineRatePerHour ?? 0
        const g = s.result.stats.filamentG.reduce((a, b) => a + b, 0)
        const mc = (s.result.stats.timeS / 3600) * rate
        machineS += s.result.stats.timeS
        grams += g
        filamentCost += s.result.stats.cost
        machineCost += mc
        byPrinter.set(printerId, (byPrinter.get(printerId) ?? 0) + s.result.stats.timeS)
        rows.push([String(s.plate), printerId, fmtDuration(s.result.stats.timeS), fmtGrams(g), fmtMoney(s.result.stats.cost + mc)])
      }
      const wallS = Math.max(...byPrinter.values())
      const start = i.startAt ? Date.parse(i.startAt) : Date.parse(`${ctx.today}T12:00:00Z`)
      const finish = new Date(start + wallS * 1000)
      const deadline = i.deadline ? Date.parse(i.deadline.length <= 10 ? `${i.deadline}T23:59:59Z` : i.deadline) : NaN
      const onTime = Number.isFinite(deadline) ? finish.getTime() <= deadline : null
      return {
        summary: `${fmtDuration(machineS)} machine time, ${fmtDuration(wallS)} wall clock, ${fmtMoney(filamentCost + machineCost)}${onTime === null ? '' : onTime ? ', on time' : ', late'}`,
        output: {
          machineTimeS: Math.round(machineS),
          wallClockS: Math.round(wallS),
          grams: Math.round(grams * 10) / 10,
          filamentCost: Math.round(filamentCost * 100) / 100,
          machineCost: Math.round(machineCost * 100) / 100,
          total: Math.round((filamentCost + machineCost) * 100) / 100,
          finishesAt: finish.toISOString(),
          onTime,
        },
        display: [
          { kind: 'table', head: ['plate', 'printer', 'time', 'filament', 'cost'], rows },
          { kind: 'kv', rows: [['wall clock', fmtDuration(wallS)], ['total', fmtMoney(filamentCost + machineCost)], ...(onTime === null ? [] : ([['deadline', onTime ? { text: 'on time', tone: 'ok' } : { text: 'late', tone: 'bad' }]] as [string, Cell][]))] },
        ],
      }
    },
  })
}
