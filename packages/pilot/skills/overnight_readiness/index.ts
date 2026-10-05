// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// overnight_readiness: a pre-flight checklist for a long unattended print.
import type { Cell, Tone } from '@slicerx/contracts'
import { z } from 'zod'
import { fmtDuration, fmtGrams, type ToolShared } from '../../src/shared'
import { defineSkill } from '../../src/tool'
import { filamentDoc, printerCaps, printerDoc, rec, strs } from '../fleet_common/index'
import { checkSpoolFit } from '../spool_fit/index'

export type Level = 'pass' | 'warn' | 'fail'
export interface CheckItem {
  check: string
  result: Level
  detail: string
}

/** Fail beats warn beats pass. */
export function overall(items: CheckItem[]): Level {
  return items.some((i) => i.result === 'fail') ? 'fail' : items.some((i) => i.result === 'warn') ? 'warn' : 'pass'
}

const DETECTION = ['spaghetti_detection', 'tangle_detection', 'first_layer_inspection', 'air_printing_detection', 'nozzle_clumping_detection']
const TONE: Record<Level, Tone> = { pass: 'ok', warn: 'warn', fail: 'bad' }

export function createOvernightReadiness(shared: ToolShared) {
  return defineSkill({
    name: 'overnight_readiness',
    version: '1.0.0',
    permission: 'read',
    description:
      'Pre-flight for a long unattended print on one printer. Checks the printer is idle, the spool has enough filament with a bigger margin, a camera is available, a filament runout sensor and failure detection exist (from the printer knowledge), and the material is safe for the printer unattended (enclosure, hotend temperature, nozzle, fumes, drying). Returns pass, warn or fail per item and overall. Slice first or pass gramsNeeded and hours. Use it for "is Bay 2 safe to run this overnight". Read only.',
    input: z.object({
      printerId: z.string().min(1).describe('Printer id, such as "bay-2"'),
      material: z.string().optional().describe('Material of the job; default is the project material'),
      plate: z.number().int().min(1).optional().describe('Sliced plate number to check'),
      gramsNeeded: z.number().min(0).max(100_000).optional().describe('Grams the job needs, when not sliced'),
      hours: z.number().min(0.1).max(500).optional().describe('Print hours, when not sliced'),
      marginPct: z.number().min(0).max(100).optional().describe('Filament margin in percent (default 15)'),
    }),
    args: (i) => `${i.printerId}${i.material ? ` --material ${i.material}` : ''}${i.plate ? ` --plate ${i.plate}` : ''}`,
    async run(i, ctx) {
      const info = (await ctx.host.printers.list()).find((p) => p.id === i.printerId)
      if (!info) return { ok: false, summary: `Unknown printer ${i.printerId}` }
      const status = await ctx.host.printers.status(i.printerId).catch(() => null)
      const doc = printerDoc(ctx.kb, info)
      const materialName = i.material ?? ctx.project?.machine()?.material ?? ctx.context.machine?.material
      const mat = materialName ? filamentDoc(ctx.kb, materialName) : undefined
      const caps = printerCaps(doc, mat)
      const items: CheckItem[] = []
      const add = (check: string, result: Level, detail: string): void => void items.push({ check, result, detail })
      const cites = new Set<string>()

      // Print time.
      const slice = i.plate !== undefined ? shared.slices.get(i.plate) : shared.slices.size === 1 ? [...shared.slices.values()][0] : undefined
      const hours = i.hours ?? (slice ? slice.result.stats.timeS / 3600 : undefined)

      // State.
      const state = status?.state ?? 'offline'
      if (state === 'idle') add('Printer state', 'pass', 'idle and ready')
      else if (state === 'finished') add('Printer state', 'warn', `finished ${status?.jobName ?? 'a job'}; clear the part off the bed first`)
      else add('Printer state', 'fail', state === 'offline' ? 'offline' : `${state}${status?.message ? `, ${status.message.slice(0, 80)}` : ''}`)

      // Filament.
      const fit = await checkSpoolFit(ctx, shared, { printerId: i.printerId, material: materialName, plate: i.plate, gramsNeeded: i.gramsNeeded, marginPct: i.marginPct ?? 15 })
      if (typeof fit === 'string') add('Filament', 'warn', `not checked: ${fit}`)
      else if (fit.status === 'pass') add('Filament', 'pass', `${fmtGrams(fit.availG ?? 0)} on the spool for ${fmtGrams(fit.needG)}, margin kept`)
      else add('Filament', fit.status, `${fit.availG === null ? 'amount unknown' : `${fmtGrams(fit.availG)} on the spool`} for ${fmtGrams(fit.needG)} needed. ${fit.advice[0] ?? ''}`.trim())

      // Camera.
      if (status?.cameraAvailable) add('Camera', 'pass', 'a camera feed is available')
      else add('Camera', 'warn', 'no camera feed, so nobody can watch the print remotely')

      // Runout sensor and failure detection, from the printer record.
      if (!doc) {
        add('Runout sensor', 'warn', `${info.model} is not in the knowledge base, so its sensors are unknown`)
        add('Failure detection', 'warn', 'unknown for this printer')
      } else {
        for (const s of strs(doc.data['sensors_src']).slice(0, 3)) cites.add(s)
        for (const s of doc.sources.slice(0, 2)) cites.add(s)
        if (caps.sensors.includes('filament_runout')) add('Runout sensor', 'pass', 'built in')
        else if (caps.sensors.some((s) => s.startsWith('filament_runout'))) add('Runout sensor', 'warn', 'optional on this printer; confirm it is fitted and on')
        else add('Runout sensor', 'fail', 'none listed for this printer')
        const found = caps.sensors.filter((s) => DETECTION.includes(s))
        if (found.length) add('Failure detection', 'pass', found.map((s) => s.replaceAll('_', ' ')).join(', '))
        else add('Failure detection', 'warn', 'no spaghetti or tangle detection listed; watch the first layers, then rely on the camera')
        if (caps.sensors.includes('power_loss_recovery')) add('Power loss recovery', 'pass', 'built in')
      }

      // Material safety for this printer.
      if (mat) {
        for (const s of mat.sources.slice(0, 2)) cites.add(s)
        for (const k of ['enclosure', 'safety', 'drying'] as const) for (const s of strs(rec(mat.data[k])['src'])) cites.add(s)
        if (caps.blockers.length) add('Hotend', 'fail', caps.blockers.join(', '))
        else if (caps.maxTempC !== undefined) add('Hotend', 'pass', `reaches ${caps.maxTempC} C, ${mat.name} needs ${String(rec(mat.data['nozzle_temp_c'])['min'] ?? '?')} C or more`)
        const level = String(rec(mat.data['enclosure'])['level'] ?? 'none')
        if (caps.enclosed === null) add('Enclosure', 'warn', 'printer enclosure unknown')
        else if (level === 'required' && !caps.enclosed) add('Enclosure', 'fail', `${mat.name} needs an enclosure and this printer is open`)
        else if (level === 'recommended' && !caps.enclosed) add('Enclosure', 'warn', `an enclosure is recommended for ${mat.name}`)
        else add('Enclosure', 'pass', caps.enclosed ? 'enclosed' : `${mat.name} does not need one`)
        const hard = caps.needs.find((n) => n.startsWith('hardened'))
        if (hard) add('Nozzle', 'warn', `${mat.name} is abrasive: confirm a ${hard}`)
        const fumes = String(rec(mat.data['safety'])['fumes'] ?? '')
        if (fumes === 'high') add('Fumes', 'warn', `${mat.name} gives off strong fumes. Run it in a ventilated room, close the enclosure, use the carbon filter, and never in a bedroom`)
        else if (fumes) add('Fumes', 'pass', `${fumes} fumes for ${mat.name}`)
        const need = String(rec(mat.data['drying'])['need'] ?? '')
        if (need === 'required') add('Dry filament', 'warn', `${mat.name} must be dry. Confirm the spool was dried and is in a dry box (drying_planner)`)
      } else add('Material', 'warn', materialName ? `${materialName} is not in the knowledge base, so enclosure and fume checks are skipped` : 'no material given, so enclosure and fume checks are skipped')

      const total = overall(items)
      const counts = { pass: 0, warn: 0, fail: 0 }
      for (const it of items) counts[it.result] += 1
      const rows: Cell[][] = items.map((it) => [it.check, { text: it.result, tone: TONE[it.result] }, it.detail])
      return {
        summary: `${info.name}: ${total === 'pass' ? 'ready for an overnight run' : total === 'warn' ? 'ready with warnings' : 'not ready'} (${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail)${hours !== undefined ? `, ${fmtDuration(hours * 3600)} print` : ''}`,
        output: { printerId: info.id, overall: total, hours: hours ?? null, material: mat?.id ?? materialName ?? null, items },
        display: [
          { kind: 'table', head: ['check', 'result', 'detail'], rows },
          { kind: 'kv', rows: [['overall', { text: total, tone: TONE[total] }], ...(hours !== undefined ? ([['print time', fmtDuration(hours * 3600)]] as [string, Cell][]) : [])] },
        ],
        untrusted: true,
        citations: ctx.kb.cite(cites),
      }
    },
  })
}
