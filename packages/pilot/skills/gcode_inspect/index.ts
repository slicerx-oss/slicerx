// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// gcode_inspect: explains what a G-code file will do and diffs two files.
// Text comes from a sliced plate or from the user; either way it is untrusted
// and only numbers and short labels are reported.
import type { Cell } from '@slicerx/contracts'
import { z } from 'zod'
import type { KbDoc } from '../../src/kb/kb'
import type { ToolShared } from '../../src/shared'
import { defineSkill, type ToolContext } from '../../src/tool'
import { diffGcode, parseGcode, type GcodeStats } from './parse'

type Rec = Record<string, unknown>
const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Largest G-code text accepted inline, characters. Sliced plates have no limit here. */
const MAX_TEXT = 20_000_000

async function plateText(shared: ToolShared, ctx: ToolContext, plate: number): Promise<string> {
  const entry = shared.slices.get(plate)
  if (!entry) throw new Error(`Plate ${plate} is not sliced yet. Run slice first.`)
  if (!entry.data) {
    if (!ctx.host.slicer) throw new Error('No slicer on this host')
    const g = await ctx.host.slicer.exportGcode(entry.result.id, { kind: 'blob' })
    if (!g.blob) throw new Error('The slicer returned no G-code')
    // Cache it where the printer tools look, so a later upload sends these bytes.
    entry.gcode = g
    entry.data = await g.blob.arrayBuffer()
  }
  return new TextDecoder().decode(entry.data)
}

export interface GcodeRisk {
  text: string
  sources: string[]
  /** The numbers behind the text, for callers that word it their own way. `basis` says where the flow limit came
   * from: the filament profile the file was sliced with, or the knowledge base's figure for the material. */
  fact: { kind: 'flow'; material: string; mm3s: number; limit: number; basis: 'profile' | 'material'; highFlow?: number } | { kind: 'temp'; material: string; c: number; lo?: number; hi?: number }
}

/**
 * Checks against the filament: sustained flow above its max volumetric speed, nozzle temperatures outside its
 * range. `profileMaxFlow` is the max volumetric speed of the profile the file was sliced with, when the caller
 * knows it; the file's own config comment is read otherwise.
 */
export function gcodeRisks(s: GcodeStats, mat: KbDoc | undefined, profileMaxFlow?: number): GcodeRisk[] {
  const out: GcodeRisk[] = []
  const cap = profileMaxFlow ?? s.profileMaxFlowMm3s ?? undefined
  const name = mat?.name ?? 'the filament'
  if (cap !== undefined && cap > 0) {
    // The slicer holds every move to the profile's limit, and that limit is the printer maker's figure for its own
    // hotend, so the generic figure for the material does not apply. Only a file that goes past its own limit (edited
    // by hand, or sliced without it) is worth a word. The 5 percent covers flow ratio and rounding in the file.
    if (s.flow.p95Mm3s > cap * 1.05) out.push({ text: `Flow reaches ${s.flow.p95Mm3s} mm3/s for most of the print, over the ${cap} mm3/s max volumetric speed of the filament profile. Expect under extrusion.`, sources: [], fact: { kind: 'flow', material: name, mm3s: s.flow.p95Mm3s, limit: cap, basis: 'profile' } })
  }
  if (!mat) return out
  const ext = obj(mat.data['extrusion'])
  const mvs = obj(ext['max_volumetric_speed_mm3s'])
  const std = num(obj(mvs['standard_hotend'])['max'])
  const hf = num(obj(mvs['high_flow_hotend'])['max'])
  const mvsSrc = Array.isArray(mvs['src']) ? (mvs['src'] as unknown[]).filter((x): x is string => typeof x === 'string') : mat.sources.slice(0, 2)
  // Sustained flow only: brief peaks over a reference figure are normal, so Orca and Bambu Studio do not warn on them.
  if (cap === undefined && std !== undefined && s.flow.p95Mm3s > std) {
    out.push({ text: `Flow reaches ${s.flow.p95Mm3s} mm3/s for most of the print, over the ${std} mm3/s ${mat.name} limit for a standard hotend${hf !== undefined ? ` (${hf} mm3/s on a high flow hotend)` : ''}. Expect under extrusion unless the hotend is high flow.`, sources: mvsSrc, fact: { kind: 'flow', material: mat.name, mm3s: s.flow.p95Mm3s, limit: std, basis: 'material', ...(hf !== undefined ? { highFlow: hf } : {}) } })
  }
  const t = obj(mat.data['nozzle_temp_c'])
  const lo = num(t['min'])
  const hi = num(t['max'])
  const tSrc = Array.isArray(t['src']) ? (t['src'] as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 2) : []
  // Only the temperatures the print extrudes at: start G-code also sets probing, wipe and standby temperatures.
  for (const v of s.temps.nozzlePrinting.length ? s.temps.nozzlePrinting : s.temps.nozzle) {
    if ((lo !== undefined && v < lo - 10) || (hi !== undefined && v > hi)) out.push({ text: `Nozzle set to ${v} C, outside the ${mat.name} range of ${lo ?? '?'} to ${hi ?? '?'} C.`, sources: tSrc, fact: { kind: 'temp', material: mat.name, c: v, ...(lo !== undefined ? { lo } : {}), ...(hi !== undefined ? { hi } : {}) } })
  }
  return out
}

function statRows(s: GcodeStats): [string, Cell][] {
  return [
    ['time', s.slicerTimeS !== null ? `${Math.round(s.slicerTimeS / 60)} min (slicer), ${Math.round(s.movesTimeS / 60)} min from moves` : `${Math.round(s.movesTimeS / 60)} min from moves (no acceleration, rough)`],
    ['layers', `${s.layers}, top at ${s.maxZMm} mm`],
    ['temperatures', `nozzle ${s.temps.nozzle.join(', ') || 'not set'} C, bed ${s.temps.bed.join(', ') || 'not set'} C${s.temps.chamber.length ? `, chamber ${s.temps.chamber.join(', ')} C` : ''}`],
    ['print speed', `typical ${s.feed.typicalPrintMmS} mm/s, max ${s.feed.maxPrintMmS} mm/s, travel up to ${s.feed.maxTravelMmS} mm/s`],
    ['flow', `peak ${s.flow.peakMm3s} mm3/s, 95th percentile ${s.flow.p95Mm3s} mm3/s`],
    ['retraction', `${s.retractions.count} retractions, typical ${s.retractions.typicalMm} mm, ${s.retractions.totalMm} mm in total${s.retractions.firmware ? `, ${s.retractions.firmware} firmware` : ''}`],
    ['fan', `max ${s.fan.maxPct}%, ${s.fan.changes} changes`],
    ['filament', `${(s.extrusion.filamentMm / 1000).toFixed(2)} m of ${s.extrusion.filamentDiameterMm} mm, ${s.extrusion.relative ? 'relative' : 'absolute'} E`],
  ]
}

export function createGcodeInspect(shared: ToolShared) {
  return defineSkill({
    name: 'gcode_inspect',
    version: '1.0.0',
    permission: 'read',
    description:
      'Explain what a G-code file will do: layers, temperatures, typical and peak print speed, volumetric flow (checked against the filament limit), retraction count and length, fan, and time by feature from ;TYPE: or FEATURE comments. Diff two files to show the differences that matter. Reads a sliced plate (plate) or text the user pasted (text); compare against another plate or text. Read only. Use it for "why is this downloaded G-code two hours faster than mine?".',
    input: z.object({
      plate: z.number().int().min(1).optional().describe('Sliced plate to read; run slice first'),
      text: z.string().max(MAX_TEXT).optional().describe('G-code text, when the user pasted or attached a file'),
      comparePlate: z.number().int().min(1).optional().describe('Second sliced plate to diff against'),
      compareText: z.string().max(MAX_TEXT).optional().describe('Second G-code text to diff against'),
      material: z.string().optional().describe('Filament id or name for the flow and temperature checks; default the loaded material'),
      maxFlowMm3s: z.number().positive().max(1000).optional().describe('Max volumetric speed of the filament profile the file was sliced with, mm3/s; default the plate config or the file'),
    }),
    args: (i) => [i.plate ? `--plate ${i.plate}` : null, i.text !== undefined ? `--text (${i.text.length} chars)` : null, i.comparePlate ? `--compare-plate ${i.comparePlate}` : null, i.compareText !== undefined ? `--compare-text (${i.compareText.length} chars)` : null].filter(Boolean).join(' '),
    async run(i, ctx) {
      let a: string
      let b: string | null = null
      try {
        if (i.text !== undefined) a = i.text
        else a = await plateText(shared, ctx, i.plate ?? [...shared.slices.keys()][0] ?? 1)
        if (i.compareText !== undefined) b = i.compareText
        else if (i.comparePlate !== undefined) b = await plateText(shared, ctx, i.comparePlate)
      } catch (e) {
        return { ok: false, summary: e instanceof Error ? e.message : String(e) }
      }
      ctx.progress('reading G-code', 0)
      const sa = parseGcode(a)
      const sb = b === null ? null : parseGcode(b)
      ctx.progress('done', 1)
      const matName = i.material ?? ctx.project?.machine()?.material ?? ctx.context.machine?.material
      const mat = matName ? ctx.kb.get('filament', matName) ?? ctx.kb.search(matName, { kinds: ['filament'], limit: 1 })[0]?.doc : undefined
      // A plate sliced here was held to its own filament profile's limit.
      const plateCap = (plate: number | undefined): number | undefined => {
        if (plate === undefined || !ctx.project) return undefined
        const v = ctx.project.config(plate)['filament_max_volumetric_speed']
        const vs = (Array.isArray(v) ? v : [v]).map(Number).filter((x) => Number.isFinite(x) && x > 0)
        return vs.length ? Math.max(...vs) : undefined
      }
      const capA = i.maxFlowMm3s ?? (i.text === undefined ? plateCap(i.plate ?? [...shared.slices.keys()][0] ?? 1) : undefined)
      const capB = i.compareText === undefined ? plateCap(i.comparePlate) : undefined
      const risksA = gcodeRisks(sa, mat, capA)
      // The A and B labels are for a comparison only.
      const risks = sb ? [...risksA.map((r) => ({ ...r, text: `A: ${r.text}` })), ...gcodeRisks(sb, mat, capB).map((r) => ({ ...r, text: `B: ${r.text}` }))] : risksA
      const sources = new Set(risks.flatMap((r) => r.sources))
      const brief = (s: GcodeStats): Record<string, unknown> => ({
        layers: s.layers,
        timeS: s.slicerTimeS ?? s.movesTimeS,
        timeSource: s.slicerTimeS !== null ? 'slicer comment' : 'moves, rough',
        temps: s.temps,
        feed: s.feed,
        flow: s.flow,
        retractions: s.retractions,
        fan: s.fan,
        filamentM: Math.round(s.extrusion.filamentMm / 10) / 100,
        timeByFeature: s.timeByFeature.slice(0, 10),
        generator: s.generator,
      })
      if (sa.moves === 0) return { ok: false, summary: 'No moves found; this does not look like G-code', untrusted: true }
      if (sb) {
        const rows = diffGcode(sa, sb)
        const matters = rows.filter((r) => r.matters)
        return {
          summary: matters.length ? `${matters.length} difference${matters.length === 1 ? '' : 's'} that matter: ${matters.slice(0, 2).map((r) => r.matters).join('; ')}` : 'The two files do about the same thing',
          output: { a: brief(sa), b: brief(sb), differences: matters.map((r) => ({ metric: r.metric, a: r.a, b: r.b, why: r.matters })), risks: risks.map((r) => r.text) },
          display: [
            { kind: 'table', head: ['', 'A', 'B', 'why it matters'], rows: rows.map((r): Cell[] => [r.metric, r.a, r.b, r.matters ? { text: r.matters, tone: 'hl' } : '']) },
            ...(risks.length ? [{ kind: 'log' as const, lines: risks.map((r) => ({ text: r.text, tone: 'warn' as const })) }] : []),
          ],
          untrusted: true,
          citations: ctx.kb.cite(sources),
        }
      }
      return {
        summary: `${sa.layers} layers, ${Math.round((sa.slicerTimeS ?? sa.movesTimeS) / 60)} min, nozzle ${sa.temps.nozzle.join('/') || '?'} C, typical ${sa.feed.typicalPrintMmS} mm/s${risks.length ? `, ${risks.length} warning${risks.length === 1 ? '' : 's'}` : ''}`,
        output: { ...brief(sa), risks: risks.map((r) => r.text), facts: risksA.map((r) => r.fact) },
        display: [
          { kind: 'kv', rows: statRows(sa) },
          ...(sa.timeByFeature.length ? [{ kind: 'table' as const, head: ['feature', 'time', 'share'], rows: sa.timeByFeature.slice(0, 10).map((f): Cell[] => [f.feature, `${Math.round(f.s / 60)} min`, `${f.pct}%`]) }] : []),
          ...(risks.length ? [{ kind: 'log' as const, lines: risks.map((r) => ({ text: r.text, tone: 'warn' as const })) }] : []),
        ],
        untrusted: true,
        citations: ctx.kb.cite(sources),
      }
    },
  })
}
