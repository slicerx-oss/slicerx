// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// multicolor_assign: plan which filament goes to which region or height band,
// in what order the colors change, and how to keep the purge small. Planner
// only: the core has no painting API yet, so nothing here is applied.
import type { Cell, SettingValue, ToolDisplay } from '@slicerx/contracts'
import { z } from 'zod'
import { defineSkill } from '../../src/tool'
import { amsFit, filamentDoc, oneLine, printerDoc, arr, obj } from '../d_common/index'
import { pickObject } from '../common'

const filament = z.object({ material: z.string().min(1), color: z.string().min(1).describe('Hex or plain color name') })
const region = z.object({
  region: z.string().min(1).max(80).describe('What gets the filament, such as "lettering" or "base"'),
  filament,
  fromZ: z.number().min(0).optional().describe('Height band start in mm, for color by height'),
  toZ: z.number().min(0).optional().describe('Height band end in mm'),
})

const PAINT_GAP = 'The core has no painting API yet, so mimir cannot paint regions or set color changes in the project. Apply this plan by hand in the slicer, or wait for the paint API.'

export function createMulticolorAssign() {
  return defineSkill({
    name: 'multicolor_assign',
    version: '0.1.0',
    permission: 'slice',
    description:
      'Plan a multicolor print: which filament each region or height band gets, the order of color changes with layer numbers for height bands, whether the printer has enough slots and can feed each material, and how to cut purge waste (flush multiplier, prime tower). This is a plan only. The core has no paint API yet, so nothing is applied to the project and you must say so.',
    input: z.object({
      objectId: z.string().optional().describe('Object to color; defaults to the first object'),
      regions: z.array(region).min(2).max(12).describe('Each region or height band with its filament'),
      printerId: z.string().optional().describe('Printer to check slots and material feed against'),
    }),
    args: (i) => `${i.regions.length} regions${i.printerId ? ` --printer ${i.printerId}` : ''}`,
    async run(i, ctx) {
      const object = pickObject(ctx, i.objectId)
      const cfg: Record<string, SettingValue> = ctx.project ? { ...ctx.project.config(ctx.project.plates()[0]?.index ?? 1), ...ctx.project.overrides() } : {}
      const num = (k: string, d: number): number => {
        const v = cfg[k]
        const x = Array.isArray(v) ? v[0] : v
        return typeof x === 'number' ? x : d
      }
      const lh = num('layer_height', 0.2)
      const first = num('initial_layer_print_height', lh)
      const layerAt = (z: number): number => Math.max(1, Math.ceil((z - first) / lh) + 1)
      const key = (f: { material: string; color: string }): string => `${f.material.toLowerCase()}|${f.color.toLowerCase()}`
      const filaments: { material: string; color: string }[] = []
      for (const r of i.regions) if (!filaments.some((f) => key(f) === key(r.filament))) filaments.push(r.filament)
      const bands = i.regions.filter((r) => r.fromZ !== undefined || r.toZ !== undefined).map((r) => ({ ...r, from: r.fromZ ?? 0, to: r.toZ ?? object?.bboxMm[2] ?? r.fromZ ?? 0 })).sort((a, b) => a.from - b.from)
      const painted = i.regions.filter((r) => r.fromZ === undefined && r.toZ === undefined)
      const order: { layer: number; z: number; to: string }[] = []
      let prev: string | null = null
      for (const b of bands) {
        if (prev !== null && key(b.filament) === prev) continue
        if (prev !== null) order.push({ layer: layerAt(b.from), z: b.from, to: `${b.filament.material} ${b.filament.color}` })
        prev = key(b.filament)
      }
      const warnings: string[] = []
      const sources = new Set<string>(['bambu_wiki_reduce_waste'])
      for (let a = 1; a < bands.length; a++) {
        const p = bands[a - 1]
        const b = bands[a]
        if (p && b && b.from < p.to - 1e-6) warnings.push(`Bands "${p.region}" and "${b.region}" overlap between ${b.from} and ${p.to} mm`)
      }
      if (object) for (const b of bands) if (b.to > object.bboxMm[2] + 1e-6) warnings.push(`"${b.region}" ends at ${b.to} mm, above the ${object.bboxMm[2]} mm object`)
      // Printer capacity and feed.
      if (i.printerId) {
        const info = (await ctx.host.printers.list()).find((p) => p.id === i.printerId)
        if (!info) warnings.push(`No printer "${i.printerId}"`)
        else {
          const st = await ctx.host.printers.status(info.id).catch(() => null)
          const pdoc = printerDoc(ctx, info.vendor, info.model)
          if (pdoc) for (const s of pdoc.sources.slice(0, 1)) sources.add(s)
          const sys = obj(arr(pdoc?.data["multi_material"])[0])
          const cap = st?.slots.length || (typeof sys["max_units"] === "number" && typeof sys["slots_per_unit"] === "number" ? sys["max_units"] * sys["slots_per_unit"] : 0)
          if (info.filamentSystem === undefined && filaments.length > 1) warnings.push(`${info.name} has no multi filament system, so ${filaments.length} filaments need manual swaps at each change`)
          else if (cap && filaments.length > cap) warnings.push(`${filaments.length} filaments, but ${info.name} has ${cap} slots`)
          if (info.filamentSystem === 'ams' && /bambu/i.test(info.vendor)) {
            for (const f of filaments) {
              const d = filamentDoc(ctx, f.material)
              if (amsFit(d).ams === 'not_compatible') warnings.push(`${d?.name ?? f.material} cannot go through the AMS. Feed it from an external spool.`)
              if (d) for (const s of amsFit(d).sources.slice(0, 1)) sources.add(s)
            }
          }
        }
      }
      const changeCount = order.length
      const settings = [
        { key: 'flush_multiplier', value: 0.9, reason: 'Bambu says the default flush volumes run slightly high and 0.8 to 0.9 is a quick saving. Check that colors stay clean.' },
        { key: 'enable_prime_tower', value: true, reason: 'A prime tower gives the nozzle a clean place to purge on every color change.' },
      ].filter((s) => ctx.kb.setting(s.key))
      const flush = {
        estimateGrams: null,
        note: 'Flush volume depends on each color pair (dark to light needs more than light to dark). The slicer computes it after the colors are set; the knowledge base has no per pair numbers to estimate from.',
      }
      const rows: Cell[][] = i.regions.map((r) => [oneLine(r.region, 40), `${r.filament.material} ${r.filament.color}`, r.fromZ === undefined && r.toZ === undefined ? 'painted region' : `${r.fromZ ?? 0} to ${r.toZ ?? object?.bboxMm[2] ?? '?'} mm`])
      const display: ToolDisplay[] = [
        { kind: 'text', text: PAINT_GAP },
        { kind: 'table', head: ['region', 'filament', 'where'], rows },
      ]
      if (order.length) display.push({ kind: 'table', head: ['change at layer', 'height mm', 'switch to'], rows: order.map((o) => [String(o.layer), String(o.z), o.to]) })
      if (warnings.length) display.push({ kind: 'log', lines: warnings.map((text) => ({ text, tone: 'warn' as const })) })
      return {
        summary: `Plan only, nothing applied: ${filaments.length} filaments, ${changeCount} height changes${painted.length ? `, ${painted.length} painted regions` : ''}. Applying needs the paint API`,
        output: {
          applied: false,
          blocked: PAINT_GAP,
          object: object ? { id: object.id, name: object.name, bboxMm: object.bboxMm } : null,
          layerHeight: lh,
          filaments,
          colorChangeOrder: order,
          paintedRegions: painted.map((r) => ({ region: r.region, filament: r.filament })),
          flush,
          suggestedSettings: settings,
          warnings,
        },
        display,
        citations: ctx.kb.cite(sources),
      }
    },
  })
}
