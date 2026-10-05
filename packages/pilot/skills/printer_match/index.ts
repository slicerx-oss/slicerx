// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// printer_match: which printers can print this model in this material now,
// ranked by fit, readiness and machine cost, each with its reasons.
import type { Cell } from '@slicerx/contracts'
import { z } from 'zod'
import type { KbDoc } from '../../src/kb/kb'
import type { ToolShared } from '../../src/shared'
import { fmtDuration } from '../../src/shared'
import { defineSkill } from '../../src/tool'
import { resolvePrinters } from '../../src/tools/printers'
import { buildVolume, pickObject } from '../common'

type Rec = Record<string, unknown>
const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})

export interface PrinterFit {
  printerId: string
  name: string
  model: string
  ok: boolean
  score: number
  state: string
  waitS: number
  loaded: boolean
  rate?: number
  reasons: string[]
  blockers: string[]
}

/** Does a box fit a build volume in any axis-aligned orientation? Compares sorted sides. */
export function fitsVolume(box: [number, number, number], vol: { x: number; y: number; z: number }): boolean {
  const a = [...box].sort((p, q) => p - q)
  const b = [vol.x, vol.y, vol.z].sort((p, q) => p - q)
  return a.every((v, i) => v <= (b[i] ?? 0))
}

function printerDoc(kbGet: (q: string) => KbDoc | undefined, vendor: string, model: string): KbDoc | undefined {
  return kbGet(`${vendor} ${model}`) ?? kbGet(model)
}

export function createPrinterMatch(shared: ToolShared) {
  return defineSkill({
    name: 'printer_match',
    version: '1.0.0',
    permission: 'read',
    description:
      'Rank the printers that can print a model in a material right now: fit in the build volume, hotend temperature, nozzle hardness for abrasive filament, enclosure need, material already loaded, wait time and machine cost. All printers by default, or named printers, or a fleet group.',
    input: z.object({
      material: z.string().min(1).describe('Filament id or name, such as "PETG" or "pa_cf"'),
      objectId: z.string().optional().describe('Object to fit; defaults to the first object in the project'),
      printers: z.array(z.string()).optional(),
      fleet: z.string().optional().describe('A fleet group name, when the user named one'),
    }),
    args: (i) => [`--material ${i.material}`, i.fleet ? `--fleet "${i.fleet}"` : null, i.printers?.length ? `--printers ${i.printers.join(',')}` : null].filter(Boolean).join(' '),
    async run(i, ctx) {
      const mat = ctx.kb.get('filament', i.material) ?? ctx.kb.search(i.material, { kinds: ['filament'], limit: 1 })[0]?.doc
      if (!mat) return { ok: false, summary: `No filament entry for "${i.material}"` }
      const object = pickObject(ctx, i.objectId)
      const sel = await resolvePrinters(ctx, { printers: i.printers, fleet: i.fleet })
      const infos = (await ctx.host.printers.list()).filter((p) => sel.ids.includes(p.id))
      const needT = Number(obj(mat.data['nozzle_temp_c'])['min'] ?? 0)
      const encLevel = String(obj(mat.data['enclosure'])['level'] ?? 'none')
      const hardened = obj(mat.data['nozzle'])['hardened_required'] === true
      const aliases = [mat.id, mat.name, ...mat.aliases].map((a) => a.toLowerCase())
      const fits: PrinterFit[] = []
      const sources = new Set<string>(mat.sources.slice(0, 3))
      for (const p of infos) {
        const st = await ctx.host.printers.status(p.id).catch(() => null)
        const doc = printerDoc((q) => ctx.kb.get('printer', q) ?? ctx.kb.search(q, { kinds: ['printer'], limit: 1 })[0]?.doc, p.vendor, p.model)
        const f: PrinterFit = { printerId: p.id, name: p.name, model: p.model, ok: true, score: 0, state: st?.state ?? 'offline', waitS: 0, loaded: false, reasons: [], blockers: [] }
        const rate = shared.machineRates.get(p.id)
        if (rate !== undefined) f.rate = rate
        if (doc) for (const s of doc.sources.slice(0, 2)) sources.add(s)
        // Volume.
        const vol = doc ? buildVolume(ctx.kb, doc.id) : null
        if (object && vol) {
          if (fitsVolume(object.bboxMm, vol)) f.reasons.push('fits the build volume')
          else f.blockers.push(`too big for ${vol.x} x ${vol.y} x ${vol.z} mm`)
        }
        // Hotend, nozzle, enclosure.
        const hot = obj(doc?.data['hotend'])
        const maxT = Number(hot['max_temp_c'] ?? NaN)
        if (Number.isFinite(maxT) && needT && maxT < needT) f.blockers.push(`hotend reaches ${maxT} C, ${mat.name} needs ${needT} C`)
        if (hardened) {
          const stock = String(hot['stock_nozzle'] ?? '')
          if (/hardened|steel|tungsten/i.test(stock) && !/stainless/i.test(stock)) f.reasons.push('hardened nozzle fitted as stock')
          else {
            f.score -= 3
            f.reasons.push(`${mat.name} is abrasive: fit a hardened nozzle first (stock: ${stock || 'unknown'})`)
          }
        }
        const enc = String(obj(doc?.data['enclosure'])['type'] ?? 'unknown')
        const enclosed = /enclosed|closed|full/.test(enc)
        if (encLevel === 'required' && !enclosed) {
          f.score -= 4
          f.reasons.push(`${mat.name} needs an enclosure; this one is ${enc.replaceAll('_', ' ')}`)
        } else if (encLevel === 'recommended' && !enclosed) {
          f.score -= 1
          f.reasons.push('an enclosure is recommended')
        } else if (enclosed && (encLevel === 'required' || encLevel === 'recommended')) f.reasons.push('enclosed')
        // Loaded material.
        f.loaded = (st?.slots ?? []).some((s) => s.material && aliases.includes(s.material.toLowerCase()))
        if (f.loaded) {
          f.score += 3
          f.reasons.push(`${mat.name} loaded`)
        }
        // Readiness.
        if (f.state === 'idle' || f.state === 'finished') {
          f.score += 3
          if (f.state === 'finished') f.reasons.push('finished job to clear from the bed')
        } else if (f.state === 'printing' || f.state === 'preparing') {
          f.waitS = st?.timeLeftS ?? 3600
          f.score += Math.max(-2, 2 - f.waitS / 7200)
          f.reasons.push(`busy for ${fmtDuration(f.waitS)}`)
        } else f.blockers.push(f.state === 'offline' ? 'offline' : `${f.state}${st?.message ? ` (${st.message.slice(0, 60)})` : ''}`)
        if (rate !== undefined) f.score -= rate * 2
        f.ok = f.blockers.length === 0
        fits.push(f)
      }
      fits.sort((a, b) => Number(b.ok) - Number(a.ok) || b.score - a.score)
      const best = fits.find((f) => f.ok)
      const rows: Cell[][] = fits.map((f) => [
        f.name,
        f.model,
        f.ok ? { text: 'yes', tone: 'ok' } : { text: 'no', tone: 'bad' },
        f.loaded ? { text: 'loaded', tone: 'ok' } : { text: 'not loaded', tone: 'dim' },
        f.waitS ? `in ${fmtDuration(f.waitS)}` : f.ok ? 'now' : '',
        f.rate === undefined ? '' : `$${f.rate.toFixed(2)}/h`,
        [...f.blockers, ...f.reasons].join('; '),
      ])
      return {
        summary: best ? `Best: ${best.name} (${best.model}), ${best.reasons.slice(0, 2).join(', ') || 'ready'}` : 'No printer can take this job right now',
        output: { material: mat.id, object: object ? { id: object.id, bboxMm: object.bboxMm } : null, ranked: fits, ...(sel.note ? { note: sel.note } : {}) },
        display: [{ kind: 'table', head: ['printer', 'model', 'can print', 'material', 'start', 'cost', 'why'], rows }],
        untrusted: true,
        citations: ctx.kb.cite(sources),
      }
    },
  })
}
