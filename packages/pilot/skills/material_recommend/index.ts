// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// material_recommend: rank materials for a use case from the knowledge base,
// prefer spools the user owns, and flag what the user's printers would need.
import type { Cell } from '@slicerx/contracts'
import { z } from 'zod'
import type { KbDoc, KnowledgeBase } from '../../src/kb/kb'
import { defineSkill } from '../../src/tool'
import { filamentDoc, loadPrinters, num, printerCaps, readSpools, rec, strs } from '../fleet_common/index'

export const NEEDS = ['heat', 'uv', 'flexible', 'chemical', 'food_contact', 'strength', 'cheap'] as const
export type Need = (typeof NEEDS)[number]

export interface MaterialReq {
  needs: Need[]
  useTempC?: number
}

export interface RankedMaterial {
  id: string
  name: string
  score: number
  /** False when a hard limit fails, such as a use temperature above the softening point. */
  ok: boolean
  reasons: string[]
  cautions: string[]
  sources: string[]
}

const INTENT: Record<Need, string> = { heat: 'heat_resistance', uv: 'uv_resistance', flexible: 'flexibility', chemical: '', food_contact: 'food_contact', strength: 'strength', cheap: 'economy' }
/** Support and soluble materials are not candidates for a part. */
const SUPPORT = new Set(['pva', 'bvoh', 'hips'])
/** Typical spool price tiers, 4 cheapest. An assumption: the knowledge base carries no prices. */
const PRICE_TIER: Record<string, number> = { pla: 4, pla_matte: 3, pla_plus: 3, pla_silk: 2.5, petg: 3, abs: 2, asa: 1.5, pp: 1, tpu_95a: 0.5, tpu_85a: 0.5 }

const rel = (d: KbDoc, k: string): number | undefined => num(rec(rec(d.data['properties'])['relative'])[k])

function softening(d: KbDoc): number | undefined {
  const p = rec(d.data['properties'])
  return num(rec(p['softening_temp_c'])['typical']) ?? num(rec(p['heat_deflection_c'])['at_0_45_mpa'])
}

function hints(intents: Record<string, KbDoc | undefined>, need: Need): { prefer: string[]; acceptable: string[]; avoid: string[]; note?: string } {
  const h = rec(intents[need]?.data['material_hints'])
  const note = typeof h['note'] === 'string' ? h['note'] : undefined
  return { prefer: strs(h['prefer']), acceptable: strs(h['acceptable']), avoid: strs(h['avoid']), ...(note ? { note } : {}) }
}

/** Ranks candidate filaments for the needs. Pure: takes the knowledge records, returns best first. */
export function rankMaterials(filaments: KbDoc[], intents: Record<string, KbDoc | undefined>, req: MaterialReq, ownedG: ReadonlyMap<string, number> = new Map()): RankedMaterial[] {
  const out: RankedMaterial[] = []
  for (const d of filaments) {
    if (SUPPORT.has(d.id)) continue
    const r: RankedMaterial = { id: d.id, name: d.name, score: 0, ok: true, reasons: [], cautions: [], sources: [...d.sources] }
    for (const need of req.needs) {
      const h = hints(intents, need)
      if (h.prefer.includes(d.id)) {
        r.score += 3
        r.reasons.push(`preferred for ${need.replaceAll('_', ' ')} in the knowledge base`)
      } else if (h.acceptable.includes(d.id)) {
        r.score += 1.5
        r.reasons.push(`acceptable for ${need.replaceAll('_', ' ')}`)
      } else if (h.avoid.includes(d.id)) {
        r.score -= 4
        r.cautions.push(`the knowledge base says to avoid it for ${need.replaceAll('_', ' ')}`)
      }
      if (need === 'heat') {
        const soft = softening(d)
        const margin = num(rec(intents['heat']?.data['selection'])['margin_c']) ?? 15
        if (req.useTempC !== undefined) {
          if (soft === undefined) {
            r.cautions.push('no softening temperature on record')
            r.score += (rel(d, 'heat') ?? 0) * 0.5
          } else if (soft >= req.useTempC + margin) {
            r.score += 3 + Math.min(3, (soft - req.useTempC - margin) / 40)
            r.reasons.push(`softens near ${soft} C, clears ${req.useTempC} C with ${margin} C margin`)
          } else {
            r.ok = false
            r.score -= 6
            r.cautions.push(`softens near ${soft} C, under ${req.useTempC} C plus ${margin} C margin`)
          }
        } else {
          const heat = rel(d, 'heat')
          if (heat !== undefined) {
            r.score += heat
            r.reasons.push(`heat rating ${heat} of 5`)
          }
        }
      }
      if (need === 'uv') {
        const lvl = rec(rec(d.data['properties'])['uv_resistance'])['level']
        if (lvl === 'high') {
          r.score += 3
          r.reasons.push('high UV resistance on record')
        }
      }
      if (need === 'flexible') {
        if (d.id.startsWith('tpu')) {
          r.score += 8
          r.reasons.push('flexible filament')
        } else r.score -= 2
      }
      if (need === 'chemical') {
        const lvl = rec(rec(d.data['properties'])['chemical_resistance'])['level']
        if (lvl === 'high') {
          r.score += 5
          r.reasons.push('high chemical resistance on record')
        } else r.cautions.push('no chemical resistance data on record, check the exact chemical')
      }
      if (need === 'food_contact') {
        const note = rec(d.data['food_contact'])['note']
        if (typeof note === 'string') r.cautions.push(note.split('. ')[0] ?? note)
      }
      if (need === 'strength') {
        const t = rel(d, 'tensile')
        const im = rel(d, 'impact')
        if (t !== undefined) r.score += t * 0.6
        if (im !== undefined) r.score += im * 0.4
        if (t !== undefined || im !== undefined) r.reasons.push(`strength ratings tensile ${t ?? '?'}, impact ${im ?? '?'} of 5`)
      }
      if (need === 'cheap') {
        const tier = PRICE_TIER[d.id] ?? (/cf|gf|pa|pc/.test(d.id) ? -1 : 0)
        r.score += tier
        if (tier >= 3) r.reasons.push('low typical spool price (assumed tier, no prices in the knowledge base)')
      }
    }
    const own = ownedG.get(d.id) ?? 0
    if (own >= 100) {
      r.score += 2
      r.reasons.push(`you own ${Math.round(own)} g`)
    } else if (own > 0) r.cautions.push(`only ${Math.round(own)} g on hand`)
    r.score = Math.round(r.score * 10) / 10
    out.push(r)
  }
  return out.sort((a, b) => Number(b.ok) - Number(a.ok) || b.score - a.score || a.id.localeCompare(b.id))
}

export function createMaterialRecommend() {
  return defineSkill({
    name: 'material_recommend',
    version: '1.0.0',
    permission: 'read',
    description:
      'Recommend materials for a use case, best first, with reasons and cautions from the knowledge base. Needs can combine: heat (give the use temperature in C), uv (sun or outdoors), flexible, chemical, food_contact, strength, cheap. Prefers spools the user owns (Spoolman) and flags what the user\'s printers would need for each material (enclosure, hardened nozzle, hotend temperature). Use it when the user asks what to print something in, before printer_match. Read only.',
    input: z.object({
      needs: z.array(z.enum(NEEDS)).min(1).describe('What the part must do: heat, uv, flexible, chemical, food_contact, strength, cheap'),
      useTemperatureC: z.number().min(0).max(300).optional().describe('Highest temperature the part will see, in C. A closed car in summer is about 80'),
      useCase: z.string().max(200).optional().describe('The part and where it lives, in the user\'s words'),
      ownedOnly: z.boolean().optional().describe('Only materials the user has a spool of'),
      limit: z.number().int().min(1).max(10).optional().describe('How many to return (default 5)'),
      printers: z.array(z.string()).optional(),
      fleet: z.string().optional().describe('A fleet group name, when the user named one'),
    }),
    args: (i) => [`--needs ${i.needs.join(',')}`, i.useTemperatureC !== undefined ? `--temp ${i.useTemperatureC}` : null, i.fleet ? `--fleet "${i.fleet}"` : null].filter(Boolean).join(' '),
    async run(i, ctx) {
      const intents: Record<string, KbDoc | undefined> = {}
      for (const n of i.needs) {
        const id = INTENT[n]
        if (id) intents[n] = ctx.kb.get('intent', id)
      }
      const sp = await readSpools(ctx)
      const owned = new Map<string, number>()
      for (const s of sp.spools) {
        const id = filamentDoc(ctx.kb, s.material)?.id
        if (id) owned.set(id, (owned.get(id) ?? 0) + (s.remainingG ?? 0))
      }
      const req: MaterialReq = { needs: i.needs, ...(i.useTemperatureC !== undefined ? { useTempC: i.useTemperatureC } : {}) }
      let ranked = rankMaterials(ctx.kb.all('filament'), intents, req, owned)
      if (i.ownedOnly) ranked = ranked.filter((r) => (owned.get(r.id) ?? 0) > 0)
      const top = ranked.slice(0, i.limit ?? 5)
      if (top.length === 0) return { ok: false, summary: i.ownedOnly ? 'None of the spools you own fit this use' : 'No material matched', output: { notes: sp.note ? [sp.note] : [] } }

      const { views, notes } = await loadPrinters(ctx, { printers: i.printers, fleet: i.fleet })
      const perMaterial = top.map((r) => {
        const doc = ctx.kb.get('filament', r.id)
        const ready: string[] = []
        const needs: { printer: string; needs: string[] }[] = []
        for (const v of views) {
          const caps = printerCaps(v.doc, doc)
          const all = [...caps.blockers, ...caps.needs]
          if (all.length === 0) ready.push(v.info.name)
          else needs.push({ printer: v.info.name, needs: all })
        }
        if (views.length > 0 && ready.length === 0) {
          r.score = Math.round((r.score - 1.5) * 10) / 10
          r.cautions.push('none of your printers can print it as they are')
        }
        return { r, ready, needs }
      })
      perMaterial.sort((a, b) => Number(b.r.ok) - Number(a.r.ok) || b.r.score - a.r.score)
      const rows: Cell[][] = perMaterial.map(({ r, ready, needs }, k) => [
        String(k + 1),
        r.name,
        r.ok ? { text: String(r.score), tone: 'ok' } : { text: 'no', tone: 'bad' },
        (owned.get(r.id) ?? 0) > 0 ? { text: `${Math.round(owned.get(r.id) ?? 0)} g`, tone: 'ok' } : { text: 'none', tone: 'dim' },
        ready.length ? ready.join(', ') : 'none as they are',
        [...r.reasons.slice(0, 2), ...r.cautions.slice(0, 2)].join('; '),
        needs.length ? needs.slice(0, 3).map((n) => `${n.printer}: ${n.needs.join(', ')}`).join(' | ') : '',
      ])
      const best = perMaterial[0]?.r
      const cites = new Set<string>()
      for (const { r } of perMaterial.slice(0, 3)) for (const s of r.sources.slice(0, 4)) cites.add(s)
      for (const n of i.needs) for (const s of (intents[n]?.sources ?? []).slice(0, 3)) cites.add(s)
      return {
        summary: best ? `Best: ${best.name}${(owned.get(best.id) ?? 0) >= 100 ? ' (you own it)' : ''}. ${best.reasons[0] ?? best.cautions[0] ?? ''}`.trim() : 'No recommendation',
        output: {
          needs: i.needs,
          useTemperatureC: i.useTemperatureC ?? null,
          ranked: perMaterial.map(({ r, ready, needs }) => ({ id: r.id, name: r.name, score: r.score, ok: r.ok, ownedG: Math.round(owned.get(r.id) ?? 0), reasons: r.reasons, cautions: r.cautions, printersReady: ready, printersNeed: needs })),
          notes: [...notes, ...(sp.note ? [sp.note] : []), ...(i.needs.includes('cheap') ? ['Price ranking uses assumed spool price tiers, not real prices'] : []), ...(i.needs.includes('chemical') ? ['Chemical resistance is on record for few materials; check the exact chemical'] : [])],
        },
        display: [{ kind: 'table', head: ['#', 'material', 'score', 'you own', 'printers ready', 'why', 'printers need'], rows }],
        untrusted: sp.spools.length > 0,
        citations: ctx.kb.cite(cites),
      }
    },
  })
}
