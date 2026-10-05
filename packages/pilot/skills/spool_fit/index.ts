// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// spool_fit: will the loaded spool last for a sliced plate, with a margin, and
// what to do when it will not: a backup slot, a swap point or another spool.
import type { Cell, Tone } from '@slicerx/contracts'
import { z } from 'zod'
import { fmtGrams, type ToolShared } from '../../src/shared'
import { defineSkill, type ToolContext } from '../../src/tool'
import { filamentDoc, materialKey, readSpools, slotGrams, spoolLabel } from '../fleet_common/index'

export interface Verdict {
  status: 'pass' | 'warn' | 'fail'
  needWithMarginG: number
  marginG: number
  shortfallG: number
}

/** Pass when the spool covers the job plus margin, warn when it covers the job only, fail otherwise. */
export function fitVerdict(needG: number, availG: number, marginPct: number, minMarginG = 10): Verdict {
  const marginG = Math.max((needG * marginPct) / 100, minMarginG)
  const withMargin = needG + marginG
  const status = availG >= withMargin ? 'pass' : availG >= needG ? 'warn' : 'fail'
  return { status, needWithMarginG: withMargin, marginG, shortfallG: Math.max(0, withMargin - availG) }
}

/**
 * The last layer that finishes before the spool is spent. Uses per layer times as
 * a stand in for grams when the slice has them, else spreads grams evenly.
 */
export function swapLayer(layerCount: number, fraction: number, layerTimeS?: number[]): number {
  const f = Math.min(1, Math.max(0, fraction))
  if (layerTimeS && layerTimeS.length === layerCount && layerCount > 0) {
    const total = layerTimeS.reduce((a, b) => a + b, 0)
    if (total > 0) {
      let cum = 0
      for (let k = 0; k < layerCount; k++) {
        cum += layerTimeS[k] ?? 0
        if (cum / total > f) return k
      }
      return layerCount
    }
  }
  return Math.floor(f * layerCount)
}

export interface FitOptions {
  printerId: string
  slotId?: string | undefined
  material?: string | undefined
  plate?: number | undefined
  gramsNeeded?: number | undefined
  marginPct?: number | undefined
}

export interface FitResult extends Verdict {
  printerId: string
  printerName: string
  material: string
  slot: string | null
  needG: number
  needSource: string
  availG: number | null
  availSource: 'spoolman' | 'estimated' | 'unknown' | 'none'
  layerCount: number | null
  swapAfterLayer: number | null
  backups: { slot: string; grams: number | null; enough: boolean }[]
  otherSpools: { id: number; label: string; grams: number }[]
  advice: string[]
  autoRefill: boolean
}

/** The spool check, shared with overnight_readiness. A string is an error the caller can show. */
export async function checkSpoolFit(ctx: ToolContext, shared: ToolShared, o: FitOptions): Promise<FitResult | string> {
  const info = (await ctx.host.printers.list()).find((p) => p.id === o.printerId)
  if (!info) return `Unknown printer ${o.printerId}`
  const status = await ctx.host.printers.status(o.printerId).catch(() => null)
  if (!status) return `${info.name} is not reachable`
  // Grams needed.
  let needG = o.gramsNeeded
  let needSource = 'input'
  let layerCount: number | null = null
  let layerTimeS: number[] | undefined
  if (needG === undefined) {
    const all = [...shared.slices.values()]
    const pick = o.plate !== undefined ? all.find((s) => s.plate === o.plate) : all.length === 1 ? all[0] : [...all].sort((a, b) => b.result.stats.filamentG.reduce((x, y) => x + y, 0) - a.result.stats.filamentG.reduce((x, y) => x + y, 0))[0]
    if (!pick) return o.plate !== undefined ? `Plate ${o.plate} is not sliced yet. Run slice first or pass gramsNeeded.` : 'Nothing is sliced yet. Run slice first or pass gramsNeeded.'
    needG = pick.result.stats.filamentG.reduce((a, b) => a + b, 0)
    needSource = `plate ${pick.plate} slice`
    layerCount = pick.result.layerCount
    if (pick.result.layerTimeS.length === pick.result.layerCount) layerTimeS = Array.from(pick.result.layerTimeS)
  }
  const material = o.material ?? ctx.project?.machine()?.material ?? ctx.context.machine?.material ?? ''
  const mk = material ? materialKey(ctx.kb, material) : ''
  const sp = await readSpools(ctx)
  const withMat = status.slots.filter((s) => s.material)
  const primary = o.slotId ? status.slots.find((s) => s.id === o.slotId) : (withMat.find((s) => s.material && mk && materialKey(ctx.kb, s.material) === mk) ?? (mk ? undefined : withMat[0]))
  const marginPct = o.marginPct ?? 10
  const base = { printerId: info.id, printerName: info.name, material: primary?.material ?? material, needG, needSource, layerCount, swapAfterLayer: null as number | null, backups: [] as FitResult['backups'], otherSpools: [] as FitResult['otherSpools'], advice: [] as string[], autoRefill: false }
  if (!primary || !primary.material) {
    const v = fitVerdict(needG, 0, marginPct)
    return { ...base, ...v, status: 'fail', slot: o.slotId ?? null, availG: null, availSource: 'none', advice: [`${material || 'The material'} is not loaded on ${info.name}. Load it or pick another printer (printer_match)`] }
  }
  const have = slotGrams(primary, sp.spools)
  const v = fitVerdict(needG, have?.grams ?? 0, marginPct)
  const res: FitResult = { ...base, ...v, slot: primary.id, availG: have ? have.grams : null, availSource: have ? have.source : 'unknown' }
  if (!have) {
    // -1 or 0 from an AMS, or no reading yet, is not an empty spool: say so once and claim nothing more.
    res.status = 'warn'
    res.advice.push(`The ${info.filamentSystem === 'ams' ? 'AMS' : 'printer'} does not know how much is left on slot ${primary.id}${primary.spoolmanId === undefined ? '' : ', and Spoolman has no weight for it'}`)
  }
  const pmk = materialKey(ctx.kb, primary.material)
  for (const s of status.slots) {
    if (s.id === primary.id || !s.material || materialKey(ctx.kb, s.material) !== pmk) continue
    const g = slotGrams(s, sp.spools)
    res.backups.push({ slot: s.id, grams: g ? g.grams : null, enough: g ? g.grams >= v.shortfallG : false })
  }
  res.autoRefill = info.filamentSystem === 'ams' && res.backups.length > 0
  if (have && v.status === 'fail') {
    const usable = Math.max(0, have.grams - Math.min(v.marginG, 10))
    if (layerCount !== null) res.swapAfterLayer = swapLayer(layerCount, usable / needG, layerTimeS)
    const advice: string[] = []
    const backup = res.backups.find((b) => b.enough)
    if (backup && info.filamentSystem === 'ams') advice.push(`Slot ${backup.slot} holds the same material with enough left. The AMS can switch to it when ${primary.id} runs out; keep brand and color the same`)
    else if (backup) advice.push(`Slot ${backup.slot} has the same material. Pause near the end of the spool and swap`)
    if (layerCount !== null && res.swapAfterLayer !== null && res.swapAfterLayer > 0) advice.push(`Plan a swap: the spool covers about layer ${res.swapAfterLayer} of ${layerCount}${layerTimeS ? '' : ' (grams spread evenly by layer, so check the G-code)'}`)
    const primaryId = filamentDoc(ctx.kb, primary.material)?.id
    const others = sp.spools
      .filter((s) => primaryId !== undefined && filamentDoc(ctx.kb, s.material)?.id === primaryId && s.id !== primary.spoolmanId && !status.slots.some((x) => x.spoolmanId === s.id) && (s.remainingG ?? 0) >= v.needWithMarginG)
      .sort((a, b) => (a.remainingG ?? 0) - (b.remainingG ?? 0))
      .slice(0, 3)
    res.otherSpools = others.map((s) => ({ id: s.id, label: spoolLabel(s), grams: s.remainingG ?? 0 }))
    if (others.length) advice.push(`Load a fuller spool: ${others.map((s) => `${spoolLabel(s)} (${Math.round(s.remainingG ?? 0)} g)`).join(', ')}`)
    else if (!backup && sp.note !== undefined) advice.push('Load a fuller spool before printing')
    // Each option after the first is an alternative.
    res.advice.push(...advice.map((t, k) => (k === 0 ? t : `Or ${t.charAt(0).toLowerCase()}${t.slice(1)}`)))
    // Stock is known only through Spoolman; without it, nothing is said about what is on the shelf.
    if (!others.length && !backup && sp.note === undefined) res.advice.push('Spoolman has no other spool of this material that is big enough. Reorder or split the job')
  }
  return res
}

const TONE: Record<Verdict['status'], Tone> = { pass: 'ok', warn: 'warn', fail: 'bad' }

export function createSpoolFit(shared: ToolShared) {
  return defineSkill({
    name: 'spool_fit',
    version: '1.0.0',
    permission: 'read',
    description:
      'Check whether the filament loaded on a printer is enough for a sliced plate, with a margin (default 10 percent, at least 10 g). Reads grams from the plate slice and what is left from Spoolman or the slot percent. When it falls short it suggests a backup AMS slot with the same material, the layer to swap at, or a fuller spool. Slice first, or pass gramsNeeded. Use it for "will this spool finish the helmet". Read only.',
    input: z.object({
      printerId: z.string().min(1).describe('Printer id, such as "bay-2"'),
      slot: z.string().optional().describe('Filament slot id, such as "A1". Default: the first slot holding the material'),
      material: z.string().optional().describe('Material to look for when no slot is given; default is the project material'),
      plate: z.number().int().min(1).optional().describe('Sliced plate number; default the only or the heaviest sliced plate'),
      gramsNeeded: z.number().min(0).max(100_000).optional().describe('Grams the job needs, when not sliced'),
      marginPct: z.number().min(0).max(100).optional().describe('Safety margin in percent (default 10)'),
    }),
    args: (i) => `${i.printerId}${i.slot ? ` --slot ${i.slot}` : ''}${i.plate ? ` --plate ${i.plate}` : ''}`,
    async run(i, ctx) {
      const r = await checkSpoolFit(ctx, shared, { printerId: i.printerId, slotId: i.slot, material: i.material, plate: i.plate, gramsNeeded: i.gramsNeeded, marginPct: i.marginPct })
      if (typeof r === 'string') return { ok: false, summary: r }
      const rows: [string, Cell][] = [
        ['printer', `${r.printerName}${r.slot ? `, slot ${r.slot}` : ''}, ${r.material}`],
        ['needs', `${fmtGrams(r.needG)} (${r.needSource}), ${fmtGrams(r.needWithMarginG)} with margin`],
        ['on the spool', r.availG === null ? { text: 'unknown', tone: 'dim' } : `${fmtGrams(r.availG)} (${r.availSource === 'spoolman' ? 'Spoolman' : 'estimated from percent'})`],
        ['result', r.availG === null ? { text: 'unknown', tone: 'dim' } : { text: r.status === 'pass' ? 'enough' : r.status === 'warn' ? 'enough but under the margin' : 'not enough', tone: TONE[r.status] }],
      ]
      if (r.backups.length) rows.push(['same material', r.backups.map((b) => `${b.slot} ${b.grams === null ? '?' : `${Math.round(b.grams)} g`}`).join(', ')])
      const head = r.availG === null && r.availSource === 'unknown' ? `Unknown: nothing reports how much is left; the print needs ${fmtGrams(r.needG)}` : r.status === 'pass' ? `Enough: ${fmtGrams(r.availG ?? 0)} for ${fmtGrams(r.needG)}` : r.status === 'warn' ? `Tight: ${fmtGrams(r.availG ?? 0)} for ${fmtGrams(r.needG)}, under the margin` : `Not enough: short by ${fmtGrams(r.shortfallG)}`
      return {
        summary: `${r.printerName} ${r.slot ?? ''} ${r.material}. ${head}`.replace(/\s+/g, ' '),
        output: r,
        display: [{ kind: 'kv', rows }, ...(r.advice.length ? [{ kind: 'log' as const, lines: r.advice.map((t) => ({ text: t, tone: (r.status === 'fail' || (r.status === 'warn' && r.availG !== null) ? 'warn' : 'dim') as Tone })) }] : [])],
        untrusted: true,
      }
    },
  })
}
