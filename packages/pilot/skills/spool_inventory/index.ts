// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// spool_inventory: grams on hand per material and color against planned jobs,
// with warnings before a spool runs out. It suggests reorders and never orders.
import type { Cell, Tone } from '@slicerx/contracts'
import { z } from 'zod'
import { fmtGrams, type ToolShared } from '../../src/shared'
import { defineSkill } from '../../src/tool'
import { colorMatches, loadPrinters, materialKey, readSpools, spoolLabel, type SpoolRec } from '../fleet_common/index'

export interface Demand {
  label: string
  material: string
  color?: string | undefined
  grams: number
}

export interface DemandRow {
  label: string
  material: string
  color: string
  needG: number
  haveG: number
  afterG: number
  status: 'ok' | 'tight' | 'short' | 'none'
  /** Spools of the usual size to buy to cover the gap plus the low mark. */
  reorderSpools: number
}

export interface StockRow {
  material: string
  color: string
  spools: number
  onHandG: number
  lowSpools: string[]
}

/** Stock per material and color. A spool is low under `lowG` grams or under 15 percent of its start weight. */
export function stockRows(spools: SpoolRec[], keyOf: (m: string) => string, lowG: number): StockRow[] {
  const groups = new Map<string, StockRow>()
  for (const s of spools) {
    const color = (s.color ?? '').toLowerCase()
    const k = `${keyOf(s.material)}|${color}`
    const g = groups.get(k) ?? { material: s.material, color: s.name && s.color ? `${s.name} ${s.color}` : (s.name ?? s.color ?? ''), spools: 0, onHandG: 0, lowSpools: [] }
    g.spools += 1
    g.onHandG += s.remainingG ?? 0
    const pct = s.remainingG !== undefined && s.initialG ? s.remainingG / s.initialG : 1
    if (s.remainingG !== undefined && (s.remainingG < lowG || pct < 0.15)) g.lowSpools.push(`${spoolLabel(s)} ${Math.round(s.remainingG)} g`)
    groups.set(k, g)
  }
  return [...groups.values()].sort((a, b) => a.material.localeCompare(b.material) || a.color.localeCompare(b.color))
}

/** Grams on hand against each demand. A demand with a color counts only spools of that color. */
export function checkDemand(spools: SpoolRec[], demands: Demand[], keyOf: (m: string) => string, lowG: number): DemandRow[] {
  return demands.map((d) => {
    const mk = keyOf(d.material)
    const matching = spools.filter((s) => keyOf(s.material) === mk && colorMatches(s, d.color))
    const have = matching.reduce((a, s) => a + (s.remainingG ?? 0), 0)
    const after = have - d.grams
    const sizes = matching.map((s) => s.initialG ?? 0).filter((g) => g > 0)
    const size = sizes.length ? Math.max(...sizes) : 1000
    const status: DemandRow['status'] = matching.length === 0 ? 'none' : after < 0 ? 'short' : after < lowG ? 'tight' : 'ok'
    return { label: d.label, material: d.material, color: d.color ?? 'any', needG: d.grams, haveG: have, afterG: after, status, reorderSpools: status === 'ok' ? 0 : Math.ceil((lowG - after) / size) }
  })
}

const STATUS_TONE: Record<DemandRow['status'], Tone> = { ok: 'ok', tight: 'warn', short: 'bad', none: 'bad' }

export function createSpoolInventory(shared: ToolShared) {
  return defineSkill({
    name: 'spool_inventory',
    version: '1.0.0',
    permission: 'read',
    description:
      'Grams of filament on hand per material and color from Spoolman, checked against planned work: jobs you pass in (material, optional color, grams) and the plates already sliced in the project. Warns before a spool runs out and suggests how many spools to reorder. It never orders anything: ordering is a separate approval class that is off by default. Use it for "do I have enough black PETG for this week". Optional printers or fleet show which spools are loaded where.',
    input: z.object({
      needs: z.array(z.object({ material: z.string().min(1), color: z.string().optional().describe('Color name or hex'), grams: z.number().min(0).max(1_000_000), label: z.string().optional().describe('What it is for') })).optional().describe('Planned jobs by material and grams'),
      includeSlicedPlates: z.boolean().optional().describe('Count the plates sliced in this project (default true)'),
      lowSpoolG: z.number().min(0).max(1000).optional().describe('Warn when a spool or the stock after the jobs is under this many grams (default 150)'),
      printers: z.array(z.string()).optional().describe('Printer ids, to show where spools are loaded'),
      fleet: z.string().optional().describe('A fleet group name, when the user named one'),
    }),
    args: (i) => [i.needs?.length ? `--needs ${i.needs.map((n) => `${n.material}:${n.grams}`).join(',')}` : null, i.fleet ? `--fleet "${i.fleet}"` : null].filter(Boolean).join(' ') || '--all',
    async run(i, ctx) {
      const sp = await readSpools(ctx)
      if (sp.spools.length === 0) return { ok: false, summary: sp.note ?? 'Spoolman has no spools', output: { notes: sp.note ? [sp.note] : [] } }
      const lowG = i.lowSpoolG ?? 150
      const keyOf = (m: string): string => materialKey(ctx.kb, m)
      const demands: Demand[] = (i.needs ?? []).map((n, k) => ({ label: n.label ?? `job ${k + 1}`, material: n.material, color: n.color, grams: n.grams }))
      const sliced = [...shared.slices.values()]
      const projMat = ctx.project?.machine()?.material ?? ctx.context.machine?.material
      const notes: string[] = []
      if ((i.includeSlicedPlates ?? true) && sliced.length > 0) {
        const g = sliced.reduce((a, s) => a + s.result.stats.filamentG.reduce((x, y) => x + y, 0), 0)
        if (projMat) demands.push({ label: `sliced plates (${sliced.length})`, material: projMat, grams: g })
        else notes.push('Sliced plates were not counted: the project material is unknown')
      }
      const stock = stockRows(sp.spools, keyOf, lowG)
      const rows = checkDemand(sp.spools, demands, keyOf, lowG)
      const { views } = i.printers?.length || i.fleet ? await loadPrinters(ctx, { printers: i.printers, fleet: i.fleet }) : { views: [] }
      const loaded = new Map<number, string>()
      for (const v of views) for (const s of v.status?.slots ?? []) if (s.spoolmanId !== undefined) loaded.set(s.spoolmanId, `${v.info.name} ${s.id}`)

      const warnings: { text: string; tone: Tone }[] = []
      for (const s of stock) for (const l of s.lowSpools) warnings.push({ text: `Low spool: ${l}`, tone: 'warn' })
      for (const r of rows) {
        if (r.status === 'none') warnings.push({ text: `${r.label}: no ${r.material} ${r.color === 'any' ? '' : `${r.color} `}in stock, needs ${Math.round(r.needG)} g`, tone: 'bad' })
        else if (r.status === 'short') warnings.push({ text: `${r.label}: short by ${Math.round(-r.afterG)} g of ${r.material}${r.color === 'any' ? '' : ` ${r.color}`}`, tone: 'bad' })
        else if (r.status === 'tight') warnings.push({ text: `${r.label}: only ${Math.round(r.afterG)} g of ${r.material} left afterward`, tone: 'warn' })
      }
      const reorder = rows.filter((r) => r.reorderSpools > 0)
      const stockRowsOut: Cell[][] = stock.map((s) => [s.material, s.color, String(s.spools), fmtGrams(s.onHandG), s.lowSpools.length ? { text: `${s.lowSpools.length} low`, tone: 'warn' } : { text: 'ok', tone: 'ok' }])
      const demandRows: Cell[][] = rows.map((r) => [r.label, `${r.material} ${r.color}`, fmtGrams(r.needG), fmtGrams(r.haveG), { text: fmtGrams(r.afterG), tone: STATUS_TONE[r.status] }, { text: r.status, tone: STATUS_TONE[r.status] }, r.reorderSpools ? `${r.reorderSpools} spool${r.reorderSpools === 1 ? '' : 's'}` : ''])
      const total = stock.reduce((a, s) => a + s.onHandG, 0)
      return {
        summary: `${Math.round(total)} g on hand across ${sp.spools.length} spools. ${warnings.length ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : 'No shortfalls'}${reorder.length ? `, reorder ${reorder.map((r) => `${r.reorderSpools} ${r.material}`).join(', ')}` : ''}`,
        output: {
          stock,
          demand: rows,
          loadedOnPrinters: [...loaded].map(([id, where]) => ({ spoolId: id, where })),
          reorderSuggestions: reorder.map((r) => ({ material: r.material, color: r.color, spools: r.reorderSpools })),
          ordered: false,
          notes: [...notes, 'Nothing was ordered. Ordering is off by default and is not part of this skill'],
        },
        display: [
          { kind: 'table', head: ['material', 'color', 'spools', 'on hand', 'state'], rows: stockRowsOut },
          ...(rows.length ? [{ kind: 'table' as const, head: ['for', 'material', 'needs', 'on hand', 'after', 'state', 'reorder'], rows: demandRows }] : []),
          { kind: 'log', lines: warnings.length ? warnings : [{ text: 'Stock covers the planned work', tone: 'ok' as Tone }] },
        ],
        untrusted: true,
      }
    },
  })
}
