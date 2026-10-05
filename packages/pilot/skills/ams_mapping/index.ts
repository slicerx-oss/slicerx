// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// ams_mapping: map the filaments a job needs to the slots loaded on a printer,
// plan swaps for what is missing, and flag materials an AMS cannot feed.
import type { Cell, FilamentSlot } from '@slicerx/contracts'
import { z } from 'zod'
import { defineSkill } from '../../src/tool'
import { amsFit, colorDistance, filamentDoc, oneLine, printerDoc } from '../d_common/index'

const need = z.object({
  material: z.string().min(1).describe('Filament name, such as "PETG" or "TPU 95A"'),
  color: z.string().optional().describe('Hex such as "#3b82f6" or a plain color name'),
  name: z.string().optional().describe('What it is for, such as "body" or "lettering"'),
})

/** Colors closer than this count as the requested color; farther counts as a different spool. */
const COLOR_OK = 120
const LOW_PCT = 15

export interface SlotAssignment {
  need: number
  material: string
  color?: string
  status: 'match' | 'color_differs' | 'swap' | 'external' | 'no_slot'
  slot?: string
  notes: string[]
}

export function createAmsMapping() {
  return defineSkill({
    name: 'ams_mapping',
    version: '1.0.0',
    permission: 'read',
    description:
      'Map the filaments a job needs (material and color per part) onto the slots loaded on one printer. Reports the slot map for printer.queue, the swaps to make for missing colors, low spools, and materials the AMS cannot feed (such as standard TPU). The project has no per-part filament data yet, so pass needs; without it the project material is used as a single need. Reads the printer, changes nothing.',
    input: z.object({
      printerId: z.string().min(1).describe('Printer id, such as "bay-1"'),
      needs: z.array(need).min(1).max(16).optional().describe('One entry per filament the job uses, in the slicer order'),
    }),
    args: (i) => `${i.printerId}${i.needs ? ` --needs ${i.needs.map((n) => `${n.material}${n.color ? `@${n.color}` : ''}`).join(',')}` : ''}`,
    async run(i, ctx) {
      const info = (await ctx.host.printers.list()).find((p) => p.id === i.printerId)
      if (!info) return { ok: false, summary: `No printer "${i.printerId}"` }
      const st = await ctx.host.printers.status(i.printerId).catch(() => null)
      if (!st) return { ok: false, summary: `${info.name} is not reachable, so its slots are unknown` }
      const notes: string[] = []
      let needs = i.needs
      if (!needs) {
        const mat = ctx.project?.machine()?.material ?? ctx.context.machine?.material
        if (!mat) return { ok: false, summary: 'Pass needs: the project has no per-part filament data' }
        needs = [{ material: mat }]
        notes.push('The project has no per-part filament data, so the project material is the only need. Pass needs for a multicolor job.')
      }
      const pdoc = printerDoc(ctx, info.vendor, info.model)
      const sources = new Set<string>(pdoc?.sources.slice(0, 2) ?? [])
      const isBambuAms = info.filamentSystem === 'ams' && /bambu/i.test(info.vendor)
      const idOf = (m: string | undefined): string => (m ? (filamentDoc(ctx, m)?.id ?? m.toLowerCase()) : '')
      const used = new Set<string>()
      const out: SlotAssignment[] = needs.map((n, k) => {
        const a: SlotAssignment = { need: k, material: n.material, status: 'no_slot', notes: [] }
        if (n.color) a.color = n.color
        return a
      })
      const docs = needs.map((n) => filamentDoc(ctx, n.material))
      // Materials the AMS cannot feed leave the slot map and go to an external spool.
      out.forEach((a, k) => {
        const d = docs[k]
        if (d) for (const s of d.sources.slice(0, 2)) sources.add(s)
        const fit = amsFit(d)
        if (isBambuAms && fit.ams === 'not_compatible') {
          a.status = 'external'
          a.notes.push(`${d?.name ?? a.material} cannot go through the AMS${fit.ht === 'compatible' ? ' (the AMS HT is a sealed drybox for it, hand fed)' : ''}. Feed it from an external spool.`)
          for (const s of fit.sources.slice(0, 2)) sources.add(s)
        }
        if (!d) a.notes.push(`No knowledge entry for "${a.material}"; matched by name only`)
      })
      const free = (): FilamentSlot[] => st.slots.filter((s) => !used.has(s.id))
      // Pass 1: same material and a matching color. Pass 2: same material, other color.
      for (const pass of [1, 2] as const) {
        out.forEach((a) => {
          if (a.slot || a.status === 'external') return
          const key = idOf(a.material)
          const cands = free().filter((s) => idOf(s.material) === key)
          const scored = cands.map((s) => ({ s, d: a.color && s.color ? colorDistance(a.color, s.color) : null }))
          const good = scored.filter((c) => c.d === null || c.d <= COLOR_OK).sort((x, y) => (x.d ?? 0) - (y.d ?? 0))
          const pick = pass === 1 ? good[0] : scored.sort((x, y) => (x.d ?? 999) - (y.d ?? 999))[0]
          if (!pick) return
          used.add(pick.s.id)
          a.slot = pick.s.id
          a.status = pass === 1 ? 'match' : 'color_differs'
          if (pass === 2) a.notes.push(`Slot ${pick.s.id} holds ${pick.s.color ?? 'another color'}, not ${a.color ?? 'the wanted color'}. Swap the spool or accept the color.`)
          if (pick.s.remainingPct !== undefined && pick.s.remainingPct < LOW_PCT) a.notes.push(`Slot ${pick.s.id} is at ${pick.s.remainingPct}%`)
        })
      }
      // Swaps: empty slots first, then the fullest spool nobody needs is the last to replace, so take the emptiest.
      out.forEach((a) => {
        if (a.slot || a.status === 'external') return
        const spare = free().sort((x, y) => Number(Boolean(x.material)) - Number(Boolean(y.material)) || (x.remainingPct ?? 100) - (y.remainingPct ?? 100))[0]
        if (!spare) {
          a.status = 'no_slot'
          a.notes.push('No free slot. Fewer filaments per plate, or another printer.')
          return
        }
        used.add(spare.id)
        a.slot = spare.id
        a.status = 'swap'
        a.notes.push(spare.material ? `Replace ${spare.material}${spare.color ? ` ${spare.color}` : ''} in slot ${spare.id} with ${a.material}${a.color ? ` ${a.color}` : ''}` : `Load ${a.material}${a.color ? ` ${a.color}` : ''} into empty slot ${spare.id}`)
      })
      if (st.state === 'printing' || st.state === 'paused' || st.state === 'preparing') notes.push(`${info.name} is ${st.state}. Swap spools after the job ends.`)
      if (st.slots.length === 0) notes.push(`${info.name} reports no filament slots.`)
      const swaps = out.filter((a) => a.status === 'swap')
      const slotMap: Record<string, string> = {}
      for (const a of out) if (a.slot && (a.status === 'match' || a.status === 'color_differs')) slotMap[String(a.need)] = a.slot
      const rows: Cell[][] = out.map((a) => [
        String(a.need + 1),
        a.material,
        a.color ?? '',
        a.slot ?? '',
        { text: a.status.replace('_', ' '), tone: a.status === 'match' ? 'ok' : a.status === 'no_slot' || a.status === 'external' ? 'bad' : 'warn' },
        oneLine(a.notes.join(' '), 200),
      ])
      const blocked = out.filter((a) => a.status === 'no_slot' || a.status === 'external').length
      return {
        ok: true,
        summary: `${out.filter((a) => a.status === 'match').length} of ${out.length} ready on ${info.name}${swaps.length ? `, ${swaps.length} swap${swaps.length === 1 ? '' : 's'}` : ''}${blocked ? `, ${blocked} blocked` : ''}`,
        output: { printer: { id: info.id, name: info.name, state: st.state }, assignments: out, slotMap, notes },
        display: [{ kind: 'table', head: ['#', 'material', 'color', 'slot', 'status', 'note'], rows }, ...(notes.length ? [{ kind: 'log' as const, lines: notes.map((text) => ({ text, tone: 'warn' as const })) }] : [])],
        untrusted: true,
        citations: ctx.kb.cite(sources),
      }
    },
  })
}
