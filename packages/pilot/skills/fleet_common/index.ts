// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Helpers the printer, scheduling and inventory skills share: printer scope,
// knowledge lookups, Spoolman spools, capability checks and one-copy slicing.
import type { PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import type { KbDoc, KnowledgeBase } from '../../src/kb/kb'
import type { ToolShared } from '../../src/shared'
import type { ToolContext } from '../../src/tool'
import { resolvePrinters } from '../../src/tools/printers'
import { pickObject } from '../common'

export type Rec = Record<string, unknown>
export const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
export const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
export const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** The run's clock: the wall clock when it is still the run's day, else noon of that day (fixed clocks in evals). */
export function nowMs(ctx: ToolContext): number {
  const real = Date.now()
  return new Date(real).toISOString().slice(0, 10) === ctx.today ? real : Date.parse(`${ctx.today}T12:00:00Z`)
}

export function fmtWhen(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`
}

/** A date (end of that day, UTC) or a date-time as milliseconds. */
export function parseDue(v: string): number {
  return Date.parse(v.length <= 10 ? `${v}T23:59:59Z` : v)
}

/** "80", "75 to 85" from a number or a {min, max} record. */
export function fmtRange(v: unknown, unit = ''): string | undefined {
  const n = num(v)
  if (n !== undefined) return `${n}${unit}`
  const r = rec(v)
  const lo = num(r['min'])
  const hi = num(r['max'])
  if (lo !== undefined && hi !== undefined) return lo === hi ? `${lo}${unit}` : `${lo} to ${hi}${unit}`
  return undefined
}

/** The mid value of a number or a {min, max} record, for calculations. */
export function midOf(v: unknown): number | undefined {
  const n = num(v)
  if (n !== undefined) return n
  const r = rec(v)
  const lo = num(r['min'])
  const hi = num(r['max'])
  return lo !== undefined && hi !== undefined ? (lo + hi) / 2 : (lo ?? hi)
}

export function filamentDoc(kb: KnowledgeBase, name: string): KbDoc | undefined {
  return kb.get('filament', name) ?? kb.search(name, { kinds: ['filament'], limit: 1 })[0]?.doc
}

/** A stable key for a material name: the knowledge id when there is a record, else the lowercase name. */
export function materialKey(kb: KnowledgeBase, name: string): string {
  return filamentDoc(kb, name)?.id ?? name.trim().toLowerCase()
}

export function printerDoc(kb: KnowledgeBase, info: Pick<PrinterInfo, 'vendor' | 'model'>): KbDoc | undefined {
  const find = (q: string): KbDoc | undefined => kb.get('printer', q) ?? kb.search(q, { kinds: ['printer'], limit: 1 })[0]?.doc
  return find(`${info.vendor} ${info.model}`) ?? find(info.model)
}

export interface PrinterView {
  info: PrinterInfo
  status: PrinterStatus | null
  doc: KbDoc | undefined
}

/** Printers in scope (named, a fleet group, or all) with their live status and knowledge record. */
export async function loadPrinters(ctx: ToolContext, sel: { printers?: string[] | undefined; fleet?: string | undefined }): Promise<{ views: PrinterView[]; notes: string[] }> {
  const res = await resolvePrinters(ctx, sel)
  const all = await ctx.host.printers.list()
  const notes: string[] = []
  if (res.note) notes.push(res.note)
  if (sel.printers?.length) {
    const unknown = sel.printers.filter((id) => !all.some((p) => p.id === id))
    if (unknown.length) notes.push(`Unknown printer${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`)
  }
  const infos = all.filter((p) => res.ids.includes(p.id))
  const views = await Promise.all(
    infos.map(async (info) => ({ info, status: await ctx.host.printers.status(info.id).catch(() => null), doc: printerDoc(ctx.kb, info) })),
  )
  return { views, notes }
}

// ---------------------------------------------------------------------------
// Spoolman

export interface SpoolRec {
  id: number
  material: string
  vendor?: string
  name?: string
  color?: string
  remainingG?: number
  initialG?: number
  /** Price of the whole spool, when Spoolman has one. */
  price?: number
}

function parseSpool(raw: unknown): SpoolRec | null {
  const r = rec(raw)
  const f = rec(r['filament'])
  const id = num(r['id'])
  const material = text(r['material']) ?? text(f['material'])
  if (id === undefined || !material) return null
  const s: SpoolRec = { id, material }
  const vendor = text(r['vendor']) ?? text(rec(f['vendor'])['name'])
  const name = text(r['name']) ?? text(f['name'])
  const hex = text(f['color_hex'])
  const color = text(r['color']) ?? (hex ? `#${hex.replace(/^#/, '')}` : undefined)
  const remaining = num(r['remainingG']) ?? num(r['remaining_weight'])
  const initial = num(r['initialG']) ?? num(r['initial_weight']) ?? num(f['weight'])
  const price = num(r['price']) ?? num(f['price'])
  if (vendor) s.vendor = vendor
  if (name) s.name = name
  if (color) s.color = color
  if (remaining !== undefined) s.remainingG = remaining
  if (initial !== undefined) s.initialG = initial
  if (price !== undefined) s.price = price
  return s
}

/** The user's spools from Spoolman. An empty list with a note when the service is not there. */
export async function readSpools(ctx: ToolContext): Promise<{ spools: SpoolRec[]; note?: string }> {
  try {
    const out = await ctx.host.printers.callTool('spoolman', 'list_spools', {})
    const list = Array.isArray(out) ? out : []
    return { spools: list.map(parseSpool).filter((s): s is SpoolRec => s !== null) }
  } catch {
    return { spools: [], note: 'Spoolman is not connected, so grams on hand and spool prices are unknown' }
  }
}

export const spoolLabel = (s: SpoolRec): string => [s.vendor, s.name ?? s.material].filter(Boolean).join(' ')

/** Nominal spool size assumed when only a percent is known. */
export const NOMINAL_SPOOL_G = 1000

/** Grams left in a printer slot, from Spoolman when linked, else from the percent on a nominal spool. */
export function slotGrams(slot: { spoolmanId?: number | undefined; remainingPct?: number | undefined }, spools: SpoolRec[]): { grams: number; source: 'spoolman' | 'estimated' } | null {
  const sp = slot.spoolmanId === undefined ? undefined : spools.find((s) => s.id === slot.spoolmanId)
  if (sp?.remainingG !== undefined) return { grams: sp.remainingG, source: 'spoolman' }
  // -1 or 0 is how an AMS says it has no reading (a spool without a tag), so only a figure above 0 counts.
  if (slot.remainingPct !== undefined && slot.remainingPct > 0 && slot.remainingPct <= 100) return { grams: (slot.remainingPct / 100) * (sp?.initialG ?? NOMINAL_SPOOL_G), source: 'estimated' }
  return null
}

// ---------------------------------------------------------------------------
// Printer capabilities

export interface Caps {
  known: boolean
  enclosed: boolean | null
  maxTempC?: number
  stockNozzle: string
  sensors: string[]
  /** The printer cannot print the material as it is. */
  blockers: string[]
  /** A change the user has to make first (hardened nozzle, enclosure). */
  needs: string[]
}

export function printerCaps(printer: KbDoc | undefined, material: KbDoc | undefined): Caps {
  const caps: Caps = { known: Boolean(printer), enclosed: null, stockNozzle: '', sensors: [], blockers: [], needs: [] }
  if (!printer) return caps
  const hot = rec(printer.data['hotend'])
  const maxT = num(hot['max_temp_c'])
  if (maxT !== undefined) caps.maxTempC = maxT
  const stock = hot['stock_nozzle']
  caps.stockNozzle = typeof stock === 'string' ? stock : String(rec(stock)['material'] ?? '')
  caps.sensors = strs(printer.data['sensors'])
  const encType = String(rec(printer.data['enclosure'])['type'] ?? 'unknown')
  caps.enclosed = /enclosed|closed|full/.test(encType)
  if (!material) return caps
  const needT = num(rec(material.data['nozzle_temp_c'])['min'])
  if (maxT !== undefined && needT !== undefined && maxT < needT) caps.blockers.push(`hotend reaches ${maxT} C, ${material.name} needs ${needT} C`)
  if (rec(material.data['nozzle'])['hardened_required'] === true && !/hardened|tungsten/i.test(caps.stockNozzle)) {
    caps.needs.push(`hardened nozzle (stock is ${caps.stockNozzle.replaceAll('_', ' ') || 'unknown'})`)
  }
  const level = String(rec(material.data['enclosure'])['level'] ?? 'none')
  if (level === 'required' && !caps.enclosed) caps.needs.push(`enclosure (${encType.replaceAll('_', ' ')})`)
  return caps
}

// ---------------------------------------------------------------------------
// Time and grams for one copy of an object

export interface PerCopy {
  timeS: number
  grams: number
  layerCount?: number
  layerTimeS?: number[]
  source: 'existing slice' | 'sliced one copy' | 'input'
  note?: string
}

const density = (kb: KnowledgeBase, name: string | undefined): number | undefined => {
  const doc = name ? filamentDoc(kb, name) : undefined
  return num(rec(rec(doc?.data['properties'])['density_g_cm3'])['typical'])
}

/**
 * Print time and grams for one copy. Reuses a slice of a single-object plate
 * when there is one, else slices one copy on a temporary plate and restores the
 * project's plates afterwards. Grams are scaled when the material differs from
 * the project's, by density.
 */
export async function perCopy(ctx: ToolContext, shared: ToolShared, objectRef: string, material: string, cache?: Map<string, PerCopy | string>): Promise<PerCopy | string> {
  const obj = pickObject(ctx, objectRef)
  if (!obj) return `No object "${objectRef}" in the project`
  const key = `${obj.id}|${materialKey(ctx.kb, material)}`
  const hit = cache?.get(key)
  if (hit !== undefined) return hit
  const project = ctx.project
  if (!project) return 'No project is open'
  const projMat = project.machine()?.material
  let res: PerCopy | string
  const existing = project.plates().find((p) => p.items.length === 1 && p.items[0]?.objectId === obj.id && shared.slices.has(p.index))
  const item = existing?.items[0]
  const slice = existing ? shared.slices.get(existing.index) : undefined
  if (existing && item && slice) {
    const c = Math.max(1, item.copies)
    res = { timeS: slice.result.stats.timeS / c, grams: slice.result.stats.filamentG.reduce((a, b) => a + b, 0) / c, layerCount: slice.result.layerCount, source: 'existing slice', note: `from plate ${existing.index} (${c} ${c === 1 ? 'copy' : 'copies'})` }
  } else if (!ctx.host.slicer) {
    res = 'No slicer on this host. Give minutesPerCopy for each job.'
  } else {
    const saved = project.plates()
    project.setPlates([{ index: 1, items: [{ objectId: obj.id, copies: 1 }] }])
    try {
      const plate = await project.plate(1)
      const r = await ctx.host.slicer.slice({ plate, config: project.config(1), options: { emitGcode: false, emitPreview: false } }, { signal: ctx.signal })
      ctx.host.slicer.release(r.id)
      res = { timeS: r.stats.timeS, grams: r.stats.filamentG.reduce((a, b) => a + b, 0), layerCount: r.layerCount, source: 'sliced one copy' }
      if (r.layerTimeS.length === r.layerCount && r.layerCount > 0) res.layerTimeS = Array.from(r.layerTimeS)
    } catch (e) {
      res = `Slicing ${obj.name} failed: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      project.setPlates(saved)
    }
  }
  if (typeof res !== 'string') {
    const a = density(ctx.kb, material)
    const b = density(ctx.kb, projMat)
    if (a !== undefined && b !== undefined && Math.abs(a / b - 1) > 0.03) {
      res.grams *= a / b
      res.note = `${res.note ? `${res.note}; ` : ''}grams scaled from ${projMat} to ${material} by density`
    }
  }
  cache?.set(key, res)
  return res
}

/** Color match between a spool and a requested color: hex equality, or the word in the spool name. */
export function colorMatches(s: Pick<SpoolRec, 'color' | 'name'>, want: string | undefined): boolean {
  if (!want) return true
  const w = want.trim().toLowerCase()
  if (w.startsWith('#')) return (s.color ?? '').toLowerCase() === w
  return (s.name ?? '').toLowerCase().includes(w)
}
