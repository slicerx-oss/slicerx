// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Knowledge tools over knowledge/ (compiled into kb.json). Class read. Every
// answer carries its source ids, which become citations in the reply.
import type { ToolDisplay } from '@slicerx/contracts'
import { z } from 'zod'
import { parseIntent } from '../intent'
import type { KbDoc, KbKind } from '../kb/kb'
import { defineTool, type PilotTool, type ToolContext, type ToolOutput } from '../tool'

/** Drops provenance fields the model does not need, to keep tool results small. */
export function slim(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.map((x) => slim(x, depth + 1))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      if (k === 'src' || k === 'confidence' || k === 'schema_version' || k === 'kind' || k === 'disagreements') continue
      out[k] = slim(x, depth + 1)
    }
    return out
  }
  return v
}

function range(v: unknown, unit: string): string | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const min = r['min']
  const max = r['max']
  const typ = r['typical']
  if (typeof min === 'number' && typeof max === 'number') return `${min} to ${max} ${unit}${typeof typ === 'number' ? `, typical ${typ}` : ''}`
  if (typeof typ === 'number') return `${typ} ${unit}`
  return null
}

function docResult(doc: KbDoc, ctx: ToolContext, display: ToolDisplay[], summary: string): ToolOutput {
  return {
    summary,
    output: { id: doc.id, name: doc.name, sources: doc.sources, record: slim(doc.data) },
    display,
    citations: ctx.kb.cite(doc.sources),
  }
}

function notFound(kind: KbKind, q: string, ctx: ToolContext): ToolOutput {
  const near = ctx.kb.search(q, { kinds: [kind], limit: 3 }).map((h) => h.doc.id)
  return {
    ok: false,
    summary: `No ${kind} entry for "${q}"`,
    output: { found: false, suggestions: near, hint: 'Try a suggestion, kb.search, or web.lookup if the knowledge base lacks it.' },
  }
}

export function kbTools(): PilotTool<never>[] {
  const filament = defineTool({
    name: 'kb.filament',
    version: '1.0.0',
    source: 'kb',
    permission: 'read',
    description: 'Look up a filament in the knowledge base: temperatures, cooling, plates, drying, nozzle needs, flow, retraction, pressure advance, failure modes, with sources.',
    input: z.object({ material: z.string().min(1).describe('Filament id, name or alias, such as "PETG", "petg_cf", "Bambu PLA Matte"') }),
    args: (i) => i.material,
    async run(i, ctx) {
      const doc = ctx.kb.get('filament', i.material) ?? ctx.kb.search(i.material, { kinds: ['filament'], limit: 1 })[0]?.doc
      if (!doc) return notFound('filament', i.material, ctx)
      const d = doc.data
      const rows: [string, string][] = []
      const n = range(d['nozzle_temp_c'], 'C')
      if (n) rows.push(['nozzle', n])
      const b = range(d['bed_temp_c'], 'C')
      if (b) rows.push(['bed', b])
      const cooling = d['cooling'] as Record<string, unknown> | undefined
      const fan = range(cooling?.['fan_max_pct'], '%')
      if (fan) rows.push(['fan max', fan])
      const drying = d['drying'] as Record<string, unknown> | undefined
      if (typeof drying?.['need'] === 'string') rows.push(['drying', drying['need']])
      return docResult(doc, ctx, [{ kind: 'kv', rows }], `${doc.name}${n ? `, nozzle ${n.replace(', typical', ' (typ')}${n.includes('typical') ? ')' : ''}` : ''}`)
    },
  })

  const printer = defineTool({
    name: 'kb.printer',
    version: '1.0.0',
    source: 'kb',
    permission: 'read',
    description: 'Look up a printer model in the knowledge base: build volume, hotend, bed, enclosure, motion limits, supported materials, profile baseline and notes, with sources.',
    input: z.object({ printer: z.string().min(1).describe('Printer id or name, such as "prusa_mk4s", "Voron 2.4", "X1 Carbon"') }),
    args: (i) => i.printer,
    async run(i, ctx) {
      const doc = ctx.kb.get('printer', i.printer) ?? ctx.kb.search(i.printer, { kinds: ['printer'], limit: 1 })[0]?.doc
      if (!doc) return notFound('printer', i.printer, ctx)
      const d = doc.data
      const rows: [string, string][] = []
      const bv = d['build_volume_mm'] as Record<string, unknown> | undefined
      if (bv) rows.push(['build volume', `${String(bv['x'])} x ${String(bv['y'])} x ${String(bv['z'])} mm`])
      const enc = d['enclosure'] as Record<string, unknown> | undefined
      if (enc && typeof enc['type'] === 'string') rows.push(['enclosure', enc['type'].replaceAll('_', ' ')])
      const motion = d['motion'] as Record<string, unknown> | undefined
      if (motion && typeof motion['max_speed_mm_s'] === 'number') rows.push(['max speed', `${motion['max_speed_mm_s']} mm/s`])
      return docResult(doc, ctx, [{ kind: 'kv', rows }], `${doc.name}${bv ? `, ${String(bv['x'])} x ${String(bv['y'])} x ${String(bv['z'])} mm` : ''}`)
    },
  })

  const troubleshoot = defineTool({
    name: 'kb.troubleshoot',
    version: '1.0.0',
    source: 'kb',
    permission: 'read',
    description: 'Find the troubleshooting guide for a print problem (layer shift, stringing, warping, under extrusion and so on): the diagnosis questions, causes ranked by likelihood with checks and fixes (setting keys where they apply), with sources.',
    input: z.object({
      symptom: z.string().min(2).describe('What went wrong, in the user\'s words'),
      printer: z.string().optional().describe('Printer family if known: bambu, prusa, klipper, creality'),
    }),
    args: (i) => `"${i.symptom}"${i.printer ? ` --printer ${i.printer}` : ''}`,
    async run(i, ctx) {
      const doc = ctx.kb.get('troubleshoot', i.symptom) ?? ctx.kb.search(i.symptom, { kinds: ['troubleshoot'], limit: 1 })[0]?.doc
      if (!doc) return notFound('troubleshoot', i.symptom, ctx)
      const causes = Array.isArray(doc.data['causes']) ? (doc.data['causes'] as Record<string, unknown>[]) : []
      const rank: Record<string, number> = { high: 0, medium: 1, low: 2 }
      const fam = i.printer?.toLowerCase()
      const sorted = causes
        .filter((c) => !fam || !Array.isArray(c['printers']) || (c['printers'] as string[]).some((p) => fam.includes(p) || p.includes(fam)))
        .sort((a, b) => (rank[String(a['likelihood'])] ?? 3) - (rank[String(b['likelihood'])] ?? 3))
      const table: ToolDisplay = {
        kind: 'table',
        head: ['cause', 'likelihood', 'category'],
        rows: sorted.slice(0, 6).map((c) => [String(c['name'] ?? c['id']), { text: String(c['likelihood'] ?? ''), tone: c['likelihood'] === 'high' ? 'warn' : 'dim' }, String(c['category'] ?? '')]),
      }
      const out = docResult(doc, ctx, [table], `${doc.name}: ${sorted.length} likely causes`)
      out.output = { id: doc.id, name: doc.name, sources: doc.sources, record: slim({ ...doc.data, causes: sorted }) }
      return out
    },
  })

  const workflow = defineTool({
    name: 'kb.workflow',
    version: '1.0.0',
    source: 'kb',
    permission: 'read',
    description: 'Find a how-to workflow: Bambu AMS, calibration (flow, pressure advance, input shaping), supports, seams, ironing, plate types, Prusa MMU, Klipper, PrusaLink, and similar, with sources.',
    input: z.object({ topic: z.string().min(2) }),
    args: (i) => `"${i.topic}"`,
    async run(i, ctx) {
      const doc = ctx.kb.get('workflow', i.topic) ?? ctx.kb.search(i.topic, { kinds: ['workflow'], limit: 1 })[0]?.doc
      if (!doc) return notFound('workflow', i.topic, ctx)
      return docResult(doc, ctx, [], doc.name)
    },
  })

  const search = defineTool({
    name: 'kb.search',
    version: '1.0.0',
    source: 'kb',
    permission: 'read',
    description: 'Search the whole knowledge base (filaments, printers, workflows, troubleshooting, settings catalog) when the right entry is not obvious. Returns the best matching entries.',
    input: z.object({ query: z.string().min(2), limit: z.number().int().min(1).max(8).optional() }),
    args: (i) => `"${i.query}"`,
    async run(i, ctx) {
      const hits = ctx.kb.search(i.query, { limit: i.limit ?? 5 })
      const settingHits = ctx.kb
        .settings()
        .filter((s) => i.query.toLowerCase().includes(s.key) || i.query.toLowerCase().includes(s.label.toLowerCase()))
        .slice(0, 5)
      if (hits.length === 0 && settingHits.length === 0) {
        return { ok: false, summary: `Nothing in the knowledge base for "${i.query}"`, output: { found: false, hint: 'Use web.lookup and cite the result.' } }
      }
      const top = hits[0]?.doc
      return {
        summary: `${hits.length} entries${top ? `, best: ${top.name}` : ''}`,
        output: {
          hits: hits.map((h) => ({ kind: h.doc.kind, id: h.doc.id, name: h.doc.name, score: Math.round(h.score * 100) / 100 })),
          top: top ? { kind: top.kind, id: top.id, record: slim(top.data), sources: top.sources } : null,
          settings: settingHits,
        },
        display: [{ kind: 'table', head: ['kind', 'entry', 'score'], rows: hits.map((h) => [h.doc.kind, h.doc.name, h.score.toFixed(2)]) }],
        citations: top ? ctx.kb.cite(top.sources) : [],
      }
    },
  })

  const intent = defineTool({
    name: 'kb.intent',
    version: '1.0.0',
    source: 'kb',
    permission: 'read',
    description: 'Turn a job request in plain words ("12 strong PETG brackets by Friday") into structured goals (count, part, material, strength, speed, detail, deadline, printers) and setting targets by Orca key with reasons. Call it first for any job request.',
    input: z.object({ text: z.string().min(2).describe('The user\'s request, verbatim') }),
    args: (i) => `"${i.text}"`,
    async run(i, ctx) {
      const m = ctx.context.machine
      const res = parseIntent(i.text, ctx.kb, ctx.today, m ? { nozzle: m.nozzle, material: m.material } : {})
      const rows: [string, string][] = []
      if (res.count) rows.push(['count', String(res.count)])
      if (res.part) rows.push(['part', res.part])
      rows.push(['material', res.material ?? `${res.materialSuggested?.id ?? 'unset'} (suggested)`])
      if (res.goals.length) rows.push(['goals', res.goals.map((g) => (g.level === 'standard' ? g.id : `${g.id} (${g.level})`)).join(', ')])
      if (res.deadline) rows.push(['deadline', `${res.deadline.date}, ${res.deadline.days} days`])
      const display: ToolDisplay[] = [{ kind: 'kv', rows }]
      if (res.targets.length) {
        const opText = (t: (typeof res.targets)[number]): string => (t.op === 'at_least' ? `>= ${String(t.value)}` : t.op === 'at_most' ? `<= ${String(t.value)}` : String(t.value))
        display.push({ kind: 'table', head: ['setting', 'target', 'goal'], rows: res.targets.map((t) => [t.key, opText(t), t.goal]) })
      }
      return {
        summary: [res.count ? `${res.count}` : null, res.goals.map((g) => g.id).join(' '), res.material ?? res.materialSuggested?.id, res.part, res.deadline ? `by ${res.deadline.date}` : null, `${res.targets.length} setting targets`].filter(Boolean).join(' '),
        output: res,
        display,
        citations: ctx.kb.cite(res.sources),
      }
    },
  })

  return [filament, printer, troubleshoot, workflow, search, intent] as PilotTool<never>[]
}
