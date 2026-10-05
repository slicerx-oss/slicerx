// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// risk_report: flags what is likely to fail on a plate before slicing:
// warping, tall thin parts, overhangs without support, open mesh edges and
// small first layer contact, each with a fix and its sources. Thin walls,
// floating islands and long bridges come from the engine's own checks of the
// plate (the warnings of a slice), read from the project or a fresh slice.
import type { Cell, SliceWarning } from '@slicerx/contracts'
import { z } from 'zod'
import type { KbDoc, KnowledgeBase } from '../../src/kb/kb'
import { defineSkill } from '../../src/tool'
import { round } from '../common'
import { thresholdForLayer } from '../supports/index'
import { openEdges, overhangStats, placedParts, plateOf, type OverhangStats } from '../orientation_search/geometry'

type Rec = Record<string, unknown>
const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export type RiskLevel = 'high' | 'medium' | 'low'

export interface Risk {
  id: 'warp' | 'tall_thin' | 'overhang' | 'open_edges' | 'first_layer' | 'thin_wall' | 'floating' | 'long_bridge'
  object: string
  /** The object's id, when the host gave one. */
  objectId?: string
  /** Where on the bed, mm, for a finding the engine placed (thin walls, floating islands, bridges). */
  at?: [number, number]
  level: RiskLevel
  detail: string
  fix: string
  /** Settings the fix uses, for settings.apply. */
  settings?: Record<string, number | string | boolean>
  sources: string[]
}

export interface RiskInput {
  object: { name: string; id?: string; bboxMm: [number, number, number] }
  /** Warp tendency from the filament's enclosure need: 3 required, 2 recommended, 1 none. */
  warpTendency: number
  materialName: string
  /** False for open frame printers, null when unknown. */
  enclosed: boolean | null
  printerName: string
  overhang: OverhangStats | null
  openEdges: number | null
  supportsOn: boolean
  brimOn: boolean
  /** Orca support threshold angle, degrees from horizontal. */
  supportAngle: number
}

export interface RiskSources {
  warp: string[]
  tall: string[]
  overhang: string[]
  firstLayer: string[]
}

const RANK: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2 }
const LEVEL_NAME: Record<RiskLevel, string> = { high: 'High', medium: 'Medium', low: 'Low' }
const RISK_NAME: Record<Risk['id'], string> = {
  warp: 'Warping',
  tall_thin: 'Tall and thin',
  overhang: 'Overhangs',
  open_edges: 'Open edges',
  first_layer: 'Small bed contact',
  thin_wall: 'Thin walls',
  floating: 'Floating island',
  long_bridge: 'Long bridge',
}
const WARP_NAME: Record<number, string> = { 1: 'low', 2: 'medium', 3: 'high' }

/** Warp tendency from the filament record: the enclosure level is the knowledge base's own measure of shrink and warp. */
export function warpTendency(doc: KbDoc | undefined): number {
  const level = String(obj(doc?.data['enclosure'])['level'] ?? 'none')
  return level === 'required' ? 3 : level === 'recommended' ? 2 : 1
}

/**
 * The checks, as pure code. Levels:
 * warp      tendency x footprint diagonal / 150 mm, x1.6 on an open printer for
 *           materials that want an enclosure; high from 2.4, medium from 1.2.
 * tall thin height over the smallest footprint side; high from 6, medium from 3.5.
 * overhang  area past the support angle with supports off; high from 5 cm2, medium from 0.5.
 * open edges any edge used by one triangle; high from 50.
 * contact   bed contact under 1.5 cm2 on a part over 15 mm tall, or under a fifth of the footprint.
 */
export function assessRisks(r: RiskInput, src: RiskSources): Risk[] {
  const out: Risk[] = []
  const [x, y, z] = r.object.bboxMm
  const name = r.object.name
  const own = r.object.id ? { objectId: r.object.id } : {}
  const diag = Math.hypot(x, y)
  const open = r.enclosed === false && r.warpTendency >= 2
  const warp = r.warpTendency * (diag / 150) * (open ? 1.6 : 1)
  if (warp >= 1.2) {
    const level: RiskLevel = warp >= 2.4 ? 'high' : 'medium'
    out.push({
      id: 'warp',
      object: name,
      ...own,
      level,
      detail: `${r.materialName} ${r.warpTendency >= 3 ? 'shrinks a lot as it cools' : r.warpTendency === 2 ? 'shrinks as it cools' : 'shrinks a little'}, and the footprint is ${round(x, 0)} x ${round(y, 0)} mm${open ? ` on ${r.printerName}, an open printer` : ''}.`,
      fix: `${r.brimOn ? 'Keep the brim and make it 5 to 8 mm wide' : 'Add an outer brim 5 to 8 mm wide'}${open ? ', print in an enclosure or on an enclosed printer, and keep drafts off it' : r.warpTendency >= 2 ? ', keep the door and lid closed' : ''}. Clean the plate and use glue where the material calls for it.`,
      settings: { brim_type: 'outer_only', brim_width: 8 },
      sources: src.warp,
    })
  }
  const minSide = Math.max(1, Math.min(x, y))
  const slender = z / minSide
  if (slender >= 3.5) {
    out.push({
      id: 'tall_thin',
      object: name,
      ...own,
      level: slender >= 6 ? 'high' : 'medium',
      detail: `${round(z, 0)} mm tall on a ${round(minSide, 0)} mm side (${round(slender, 1)} to 1): the nozzle can knock it over or it wobbles near the top.`,
      fix: 'Lay it down if the load allows (try auto orient), or add a brim, slow the travel and use Normal Lift z hop.',
      settings: { brim_type: 'outer_only', brim_width: 5, z_hop_types: 'Normal Lift' },
      sources: src.tall,
    })
  }
  if (r.overhang && r.overhang.overhangCm2 > 0.5 && !r.supportsOn) {
    out.push({
      id: 'overhang',
      object: name,
      ...own,
      level: r.overhang.overhangCm2 >= 5 ? 'high' : 'medium',
      detail: `${r.overhang.overhangCm2} cm2 of overhang flatter than ${r.supportAngle} deg in ${r.overhang.regions} region${r.overhang.regions === 1 ? '' : 's'}, highest ${r.overhang.maxHeightMm} mm up, and supports are off.`,
      fix: 'Try auto orient first; if overhangs remain, turn on supports and pick the type and angle.',
      settings: { enable_support: true },
      sources: src.overhang,
    })
  }
  if (r.openEdges !== null && r.openEdges > 0) {
    out.push({
      id: 'open_edges',
      object: name,
      ...own,
      level: r.openEdges >= 50 ? 'high' : 'medium',
      detail: `${r.openEdges} open edge${r.openEdges === 1 ? '' : 's'}: the mesh is not closed, so walls can come out missing or doubled.`,
      fix: 'Repair the mesh before slicing, and check the preview for gaps.',
      sources: [],
    })
  }
  const footprint = x * y
  const contactMm2 = r.overhang ? r.overhang.contactCm2 * 100 : footprint
  if (z > 15 && (contactMm2 < 150 || contactMm2 < footprint * 0.2)) {
    out.push({
      id: 'first_layer',
      object: name,
      ...own,
      level: contactMm2 < 50 ? 'high' : 'medium',
      detail: `Only ${round(contactMm2 / 100, 1)} cm2 touches the bed under a ${round(z, 0)} mm tall part${r.overhang ? '' : ' (from the bounding box)'}.`,
      fix: r.brimOn ? 'The brim helps; widen it to 8 mm, or turn the part so a larger face is down.' : 'Add a 5 to 8 mm outer brim, or turn the part so a larger face is down.',
      settings: { brim_type: 'outer_only', brim_width: 6 },
      sources: src.firstLayer,
    })
  }
  return out.sort((a, b) => RANK[a.level] - RANK[b.level])
}

/** "... near X 12.3 Y 4.5 mm ..." in an engine message. */
function spot(message: string): [number, number] | undefined {
  const m = /\bX (-?\d+(?:\.\d+)?)[ ,]+Y (-?\d+(?:\.\d+)?)/.exec(message)
  return m ? [Number(m[1]), Number(m[2])] : undefined
}

/** An engine message as what it found and what to do: the first sentence, then the rest. */
function split(message: string): [string, string] {
  const i = message.search(/\.\s/)
  return i < 0 ? [message, ''] : [message.slice(0, i + 1), message.slice(i + 2).trim()]
}

/**
 * The engine's plate checks as risks: thin walls (features narrower than the walls can print),
 * floating islands (a region that starts in mid-air with supports off) and long bridges (longer than
 * max_bridge_length with supports off). Summary lines without a place and the engine's long overhang
 * finding (this report measures overhangs itself) are left out. `object` names the one object when
 * the plate holds one; otherwise the finding is for the plate and carries its place.
 */
export function engineRisks(warnings: readonly SliceWarning[], object: { name: string; id?: string } | null, src: Pick<RiskSources, 'overhang'>): Risk[] {
  const out: Risk[] = []
  for (const w of warnings) {
    const at = spot(w.message)
    if (!at) continue
    const [detail, fix] = split(w.message)
    const own = object ? { object: object.name, ...(object.id ? { objectId: object.id } : {}) } : { object: 'the plate' }
    if (w.code === 'thin_wall') {
      const classic = /wall generator to Arachne/.test(w.message)
      out.push({ id: 'thin_wall', ...own, at, level: 'medium', detail, fix, ...(classic ? { settings: { wall_generator: 'arachne' } } : {}), sources: [] })
    } else if (w.code === 'floating_region' && /mid-air/.test(w.message)) {
      out.push({ id: 'floating', ...own, at, level: 'high', detail, fix, settings: { enable_support: true }, sources: src.overhang })
    } else if (w.code === 'long_bridge') {
      const span = Number(/spans (\d+(?:\.\d+)?) mm/.exec(w.message)?.[1] ?? 0)
      out.push({ id: 'long_bridge', ...own, at, level: span >= 30 ? 'high' : 'medium', detail, fix, settings: { enable_support: true }, sources: src.overhang })
    }
  }
  return out
}

/** Source ids of a troubleshoot cause, or of the whole record. */
function causeSources(doc: KbDoc | undefined, causeId?: string): string[] {
  if (!doc) return []
  if (causeId) {
    const c = (Array.isArray(doc.data['causes']) ? (doc.data['causes'] as unknown[]) : []).map(obj).find((x) => x['id'] === causeId)
    const s = strs(c?.['src'])
    if (s.length) return s
  }
  return strs(doc.data['src']).length ? strs(doc.data['src']) : doc.sources.slice(0, 3)
}

export function riskSources(kb: KnowledgeBase, material: KbDoc | undefined): RiskSources {
  const warping = kb.get('troubleshoot', 'warping')
  const spaghetti = kb.get('troubleshoot', 'spaghetti')
  const adhesion = kb.get('workflow', 'adhesion')
  const overhangs = kb.get('troubleshoot', 'poor_overhangs')
  const supports = kb.get('workflow', 'supports')
  const encl = strs(obj(material?.data['enclosure'])['src'])
  return {
    warp: [...new Set([...causeSources(warping, 'c_no_brim'), ...causeSources(warping, 'c_drafts'), ...encl.slice(0, 2)])],
    tall: [...new Set([...causeSources(spaghetti, 'c_nozzle_knock'), ...strs(adhesion?.data['src']).slice(0, 1)])],
    overhang: [...new Set([...strs(supports?.data['src']).slice(0, 2), ...causeSources(overhangs).slice(0, 2)])],
    firstLayer: [...new Set([...causeSources(warping, 'c_no_brim'), ...strs(adhesion?.data['src']).slice(0, 1)])],
  }
}

export function createRiskReport() {
  return defineSkill({
    name: 'risk_report',
    version: '1.0.0',
    permission: 'read',
    description:
      'Check a plate for what is likely to fail before slicing: warping (footprint size, the material\'s shrink and enclosure need, open printers), tall thin parts, overhangs with supports off, open mesh edges and small first layer contact. Each risk gets a level, a fix, the settings the fix would use and knowledge base sources. Read only. Use it for "anything likely to fail on this plate?" or before a long or overnight print.',
    input: z.object({
      plate: z.number().int().min(1).optional().describe('Plate number; default the plate of the object, or the first plate'),
      objectId: z.string().optional().describe('Check one object; default every object on the plate'),
      material: z.string().optional().describe('Filament id or name; default the loaded material'),
      printer: z.string().optional().describe('Printer knowledge id or name; default the current printer'),
    }),
    args: (i) => [i.objectId ?? null, i.plate ? `--plate ${i.plate}` : null, i.material ? `--material ${i.material}` : null].filter(Boolean).join(' '),
    async run(i, ctx) {
      const project = ctx.project
      if (!project) return { ok: false, summary: 'No project is open' }
      const machine = project.machine() ?? ctx.context.machine
      const matName = i.material ?? machine?.material ?? 'pla'
      const mat = ctx.kb.get('filament', matName) ?? ctx.kb.search(matName, { kinds: ['filament'], limit: 1 })[0]?.doc
      const printerName = i.printer ?? machine?.printer ?? ''
      const pdoc = printerName ? ctx.kb.get('printer', printerName) ?? ctx.kb.search(printerName, { kinds: ['printer'], limit: 1 })[0]?.doc : undefined
      const encType = String(obj(pdoc?.data['enclosure'])['type'] ?? '')
      const enclosed = encType ? /enclosed|closed|full/.test(encType) : null
      const plateIdx = i.plate ?? plateOf(project, i.objectId)
      const plate = project.plates().find((p) => p.index === plateIdx)
      const ids = i.objectId ? [i.objectId] : (plate?.items.map((it) => it.objectId) ?? project.objects().map((o) => o.id))
      const objects = project.objects().filter((o) => ids.includes(o.id) || ids.includes(o.name))
      if (objects.length === 0) return { ok: false, summary: 'No object to check' }
      const cfg = project.config(plateIdx ?? 1)
      const supportsOn = cfg.enable_support === true
      const brimOn = typeof cfg.brim_type === 'string' && cfg.brim_type !== 'no_brim'
      // Orca's threshold is the slope below which a face gets support; the mesh check takes the complement.
      const angleRaw = cfg['support_threshold_angle']
      const threshold = typeof angleRaw === 'number' && angleRaw > 0 ? angleRaw : thresholdForLayer(typeof cfg.layer_height === 'number' ? cfg.layer_height : 0.2)
      const angle = 90 - threshold
      const src = riskSources(ctx.kb, mat)
      const risks: Risk[] = []
      const checked: Cell[][] = []
      let meshless = 0
      for (const o of objects) {
        const parts = await placedParts(project, o)
        if (!parts) meshless++
        const oh = parts ? overhangStats(parts, angle) : null
        const edges = parts ? openEdges(parts) : null
        risks.push(
          ...assessRisks(
            { object: { name: o.name, id: o.id, bboxMm: o.bboxMm }, warpTendency: warpTendency(mat), materialName: mat?.name ?? matName, enclosed, printerName: pdoc?.name ?? printerName, overhang: oh, openEdges: edges, supportsOn, brimOn, supportAngle: threshold },
            src,
          ),
        )
        const dash = { text: 'not checked', tone: 'dim' as const }
        checked.push([o.name, `${o.bboxMm.map((v) => round(v, 0)).join(' x ')} mm`, oh ? `${oh.overhangCm2} cm2` : dash, oh ? `${oh.contactCm2} cm2` : dash, edges === null ? dash : edges === 0 ? 'none' : String(edges)])
      }
      // Thin walls, floating islands and long bridges: the engine's checks of this plate.
      const notes: string[] = []
      let warnings: readonly SliceWarning[] | null = (await project.warnings?.(plateIdx ?? 1)) ?? null
      if (warnings === null && ctx.host.slicer) {
        const r = await ctx.host.slicer.slice({ plate: await project.plate(plateIdx ?? 1), config: cfg, options: { emitGcode: false, emitPreview: false } }, ctx.signal ? { signal: ctx.signal } : {})
        ctx.host.slicer.release(r.id)
        warnings = r.warnings
      }
      if (warnings === null) notes.push('Thin walls, floating islands and long bridges are found when the plate is sliced; slice it and run this again.')
      else risks.push(...engineRisks(warnings, objects.length === 1 && objects[0] ? { name: objects[0].name, id: objects[0].id } : null, src))
      risks.sort((a, b) => RANK[a.level] - RANK[b.level])
      if (meshless) notes.push(`${meshless} object${meshless === 1 ? ' has' : 's have'} no mesh access here, so overhangs, open edges and bed contact were judged from the bounding box or skipped.`)
      if (enclosed === null) notes.push('The printer is not in the knowledge base, so the enclosure is unknown.')
      const sources = new Set<string>(risks.flatMap((r) => r.sources))
      const high = risks.filter((r) => r.level === 'high').length
      const rows: Cell[][] = risks.map((r) => [{ text: LEVEL_NAME[r.level], tone: r.level === 'high' ? 'bad' : r.level === 'medium' ? 'warn' : 'dim' }, r.object, RISK_NAME[r.id], r.detail, r.fix])
      return {
        summary: risks.length ? `${risks.length} risk${risks.length === 1 ? '' : 's'}${high ? `, ${high} high` : ''}: ${risks.slice(0, 2).map((r) => `${RISK_NAME[r.id].toLowerCase()} on ${r.object}`).join(', ')}` : 'No likely failures found',
        output: {
          material: mat?.id ?? matName,
          printer: pdoc?.id ?? printerName,
          enclosed,
          risks: risks.map((r) => ({ id: r.id, object: r.object, ...(r.objectId ? { objectId: r.objectId } : {}), ...(r.at ? { at: r.at } : {}), level: r.level, detail: r.detail, fix: r.fix, ...(r.settings ? { settings: r.settings } : {}) })),
          notes,
        },
        display: [
          ...(rows.length ? [{ kind: 'table' as const, head: ['Level', 'Object', 'Risk', 'Why', 'Fix'], rows }] : [{ kind: 'text' as const, text: 'Nothing likely to fail from the checks mimir can run.' }]),
          {
            kind: 'kv',
            rows: [
              ['Material', mat?.name ?? matName],
              ['Warp tendency', `${WARP_NAME[warpTendency(mat)] ?? 'low'} (${warpTendency(mat)} of 3)`],
              ['Printer', `${pdoc?.name ?? (printerName || 'unknown')}${enclosed === null ? '' : enclosed ? ', enclosed' : ', open frame'}`],
            ],
          },
          { kind: 'table', head: ['Object', 'Size', 'Overhang area', 'Bed contact', 'Open edges'], rows: checked },
          { kind: 'log', lines: notes.map((t) => ({ text: t, tone: 'dim' as const })) },
        ],
        citations: ctx.kb.cite(sources),
      }
    },
  })
}
