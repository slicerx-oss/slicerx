// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// energy_estimate: kWh and electricity cost per plate from print time and heat
// up. Wattage comes from the printer knowledge when it has a figure, else from
// a stated assumption for the printer class. Every assumption is labeled.
import type { Cell, Tone } from '@slicerx/contracts'
import { z } from 'zod'
import type { KbDoc } from '../../src/kb/kb'
import { fmtDuration, fmtMoney, type ToolShared } from '../../src/shared'
import { defineSkill } from '../../src/tool'
import { filamentDoc, num, printerDoc, rec } from '../fleet_common/index'

/** Electricity price when the user gives none, per kWh. Stated in the output. */
export const DEFAULT_PRICE_PER_KWH = 0.15
/** Heat-up time when the user gives none, minutes. Stated in the output. */
export const DEFAULT_HEATUP_MIN = 6

export interface Watts {
  printing: number
  heatup: number
  source: 'input' | 'knowledge' | 'assumption'
  basis: string
  sources: string[]
}

/** The knowledge key for a filament: the record id, else its family. */
function figureKey(materialId: string | undefined, figures: Record<string, unknown>): { key: string; exact: boolean } | null {
  const id = materialId ?? 'pla'
  if (num(rec(figures[id])['value']) !== undefined) return { key: id, exact: true }
  const family = id.startsWith('pla') ? 'pla' : id.startsWith('petg') ? 'petg' : id === 'asa' ? 'abs' : id.startsWith('tpu') ? 'pla' : id.startsWith('pa') ? 'pc' : id
  if (num(rec(figures[family])['value']) !== undefined) return { key: family, exact: false }
  return null
}

/** Printing and heat-up watts for a printer record and material. Pure. */
export function wattsFor(printer: KbDoc | undefined, materialId: string | undefined, override?: number): Watts {
  const power = rec(printer?.data['power'])
  const maxW = num(rec(power['max_w'])['value'])
  const sources = printer ? printer.sources.slice(0, 2) : []
  const heatupW = maxW !== undefined ? Math.min(maxW * 0.6, 800) : undefined
  if (override !== undefined) return { printing: override, heatup: heatupW ?? 400, source: 'input', basis: 'wattage given by the user', sources: [] }
  const figures = rec(power['printing_typical_w'])
  const hit = figureKey(materialId, figures)
  if (printer && hit) {
    const w = num(rec(figures[hit.key])['value']) ?? 0
    return {
      printing: w,
      heatup: heatupW ?? 400,
      source: 'knowledge',
      basis: `${printer.name}: ${w} W typical while printing ${hit.key.toUpperCase()}${hit.exact ? '' : ` (closest figure to ${materialId ?? 'the material'})`}`,
      sources,
    }
  }
  const enc = String(rec(printer?.data['enclosure'])['type'] ?? '')
  const active = String(rec(printer?.data['enclosure'])['chamber_heating'] ?? '') === 'active'
  const enclosed = /enclosed|closed|full/.test(enc)
  const [printing, cls] = active ? [300, 'actively heated chamber'] : enclosed ? [150, 'enclosed printer'] : printer ? [100, 'open frame printer'] : [150, 'unknown printer']
  const psu = num(rec(power['psu_rated_w'])['value'])
  return {
    printing,
    heatup: heatupW ?? 400,
    source: 'assumption',
    basis: `assumed ${printing} W for an ${cls}${psu !== undefined ? `; the supply is rated ${psu} W and the bed heater wattage is not in the knowledge base, so pass printingWatts if you know it` : ''}`,
    sources,
  }
}

export interface EnergyLine {
  timeS: number
  watts: Watts
  heatupMin: number
  pricePerKwh: number
}

export function energyOf(l: EnergyLine): { printKwh: number; heatupKwh: number; kwh: number; cost: number } {
  const printKwh = (l.watts.printing * l.timeS) / 3600 / 1000
  const heatupKwh = (l.watts.heatup * l.heatupMin) / 60 / 1000
  const kwh = printKwh + heatupKwh
  return { printKwh, heatupKwh, kwh, cost: kwh * l.pricePerKwh }
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000

export function createEnergyEstimate(shared: ToolShared) {
  return defineSkill({
    name: 'energy_estimate',
    version: '1.0.0',
    permission: 'read',
    description:
      'Estimate electricity use and cost for sliced plates or a given print time: kWh and cost per plate from print time and heat-up. Uses the typical printing wattage in the printer knowledge when it has a figure for the material, and otherwise a stated assumption for the printer class; the output labels which is which. The electricity price is an input (assumed $0.15 per kWh when omitted). Use it for "how much electricity does this 14 hour ABS print use". Read only.',
    input: z.object({
      printer: z.string().optional().describe('Printer id such as "bay-1", or a model name such as "P1S". Default: each plate\'s assigned printer, else the project printer'),
      plates: z.array(z.number().int().min(1)).optional().describe('Sliced plate numbers; default all sliced plates'),
      hours: z.number().min(0.05).max(1000).optional().describe('Print hours, when nothing is sliced'),
      material: z.string().optional().describe('Material; default the project material'),
      pricePerKwh: z.number().min(0).max(5).optional().describe(`Electricity price per kWh (assumed ${DEFAULT_PRICE_PER_KWH} when omitted)`),
      printingWatts: z.number().min(1).max(5000).optional().describe('Average printing watts, if measured or known'),
      heatupMinutes: z.number().min(0).max(60).optional().describe(`Minutes of heat-up (assumed ${DEFAULT_HEATUP_MIN})`),
    }),
    args: (i) => [i.printer ? `--printer ${i.printer}` : null, i.hours !== undefined ? `--hours ${i.hours}` : null, i.plates?.length ? `--plates ${i.plates.join(',')}` : null].filter(Boolean).join(' '),
    async run(i, ctx) {
      const list = await ctx.host.printers.list()
      const resolve = (ref: string | undefined): { label: string; doc: KbDoc | undefined } => {
        if (!ref) return { label: 'project printer', doc: ctx.kb.get('printer', ctx.project?.machine()?.printer ?? ctx.context.machine?.printer ?? '') }
        const info = list.find((p) => p.id === ref)
        if (info) return { label: info.name, doc: printerDoc(ctx.kb, info) }
        return { label: ref, doc: ctx.kb.get('printer', ref) ?? ctx.kb.search(ref, { kinds: ['printer'], limit: 1 })[0]?.doc }
      }
      const materialName = i.material ?? ctx.project?.machine()?.material ?? ctx.context.machine?.material
      const mat = materialName ? filamentDoc(ctx.kb, materialName) : undefined
      const entries: { label: string; ref: string | undefined; timeS: number }[] = []
      if (i.hours !== undefined) entries.push({ label: 'print', ref: i.printer, timeS: i.hours * 3600 })
      else {
        const plateInfo = ctx.project?.plates() ?? []
        const sliced = [...shared.slices.values()].filter((s) => !i.plates || i.plates.includes(s.plate))
        for (const s of sliced) entries.push({ label: `plate ${s.plate}`, ref: i.printer ?? plateInfo.find((p) => p.index === s.plate)?.printerId, timeS: s.result.stats.timeS })
      }
      if (entries.length === 0) return { ok: false, summary: 'Nothing to estimate. Slice first or pass hours.' }
      const price = i.pricePerKwh ?? DEFAULT_PRICE_PER_KWH
      const heatupMin = i.heatupMinutes ?? DEFAULT_HEATUP_MIN
      const assumptions: string[] = []
      if (i.pricePerKwh === undefined) assumptions.push(`Electricity price assumed at ${fmtMoney(DEFAULT_PRICE_PER_KWH)} per kWh`)
      if (i.heatupMinutes === undefined) assumptions.push(`Heat-up assumed at ${DEFAULT_HEATUP_MIN} minutes per plate at about 60% of the printer's maximum draw, added on top of the printing figure (may count a little twice)`)
      const cites = new Set<string>()
      let anyAssumed = false
      let kwh = 0
      let cost = 0
      let heatKwh = 0
      const rows: Cell[][] = []
      const outLines: unknown[] = []
      for (const e of entries) {
        const p = resolve(e.ref)
        const w = wattsFor(p.doc, mat?.id, i.printingWatts)
        if (w.source === 'assumption') {
          anyAssumed = true
          assumptions.push(`${p.label}: ${w.basis}`)
        }
        for (const s of w.sources) cites.add(s)
        const r = energyOf({ timeS: e.timeS, watts: w, heatupMin, pricePerKwh: price })
        kwh += r.kwh
        cost += r.cost
        heatKwh += r.heatupKwh
        rows.push([e.label, p.label, fmtDuration(e.timeS), `${w.printing} W`, { text: w.source, tone: (w.source === 'assumption' ? 'warn' : 'ok') as Tone }, r.kwh.toFixed(2), fmtMoney(r.cost)])
        outLines.push({ line: e.label, printer: p.label, timeS: Math.round(e.timeS), printingWatts: w.printing, heatupWatts: Math.round(w.heatup), wattSource: w.source, basis: w.basis, printKwh: r3(r.printKwh), heatupKwh: r3(r.heatupKwh), kwh: r3(r.kwh), cost: Math.round(r.cost * 100) / 100 })
      }
      const unique = [...new Set(assumptions)]
      return {
        summary: `${kwh.toFixed(2)} kWh, ${fmtMoney(cost)} for ${entries.length} ${entries.length === 1 ? 'line' : 'lines'}. ${anyAssumed ? 'Some wattage is an assumption' : 'Wattage from printer knowledge'}; price ${i.pricePerKwh === undefined ? 'assumed' : 'given'}`,
        output: { kwh: r3(kwh), cost: Math.round(cost * 100) / 100, heatupShareKwh: r3(heatKwh), pricePerKwh: price, lines: outLines, assumptions: unique },
        display: [
          { kind: 'table', head: ['line', 'printer', 'time', 'printing', 'wattage from', 'kWh', 'cost'], rows },
          { kind: 'kv', rows: [['total', `${kwh.toFixed(2)} kWh, ${fmtMoney(cost)}`], ['heat-up share', `${heatKwh.toFixed(2)} kWh`]] },
          { kind: 'log', lines: unique.map((t) => ({ text: `Assumption: ${t}`, tone: 'warn' as Tone })) },
        ],
        untrusted: false,
        citations: ctx.kb.cite(cites),
      }
    },
  })
}
