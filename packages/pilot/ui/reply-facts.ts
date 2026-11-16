// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Keep this file free of DOM and CSS imports: the phone app imports it.
// What a build reply's part card shows beside the part: its tags (size, scale, part count), its warnings (always in
// view) and the groups under its Details line. Each fact comes from the turn's tool results or the plan the host keeps,
// sorted by where it came from; nothing here reads the reply's own words.
import type { Citation } from '@slicerx/contracts'
import { changesDesign, partSize, type CreatedPart } from './part'
import type { ToolRowModel, Transcript } from './reduce'

/** The plan a part was built from, as the host keeps it: the fields the card reads. */
export interface ReplyPlan {
  units?: 'mm' | 'in' | undefined
  features: readonly { name: string }[]
  assumptions?: readonly string[] | undefined
  colors?: Readonly<Record<string, string>> | undefined
  /** N of 1:N, as a number or as digits ("150", "1:150"). */
  scale?: number | string | undefined
  /** The real thing's details the part leaves out, each a noun phrase. */
  leftOut?: readonly string[] | undefined
}

/** What the card asks the host: the plan a design was built from, and whether a part is off the bed now. */
export interface FactsHost {
  /** The plan by the id the turn's design.plan gave (null when the turn made none), or the one tied to the design. */
  plan?: ((planId: string | null, design: string) => ReplyPlan | null | undefined) | undefined
  offBed?: ((id: string) => boolean) | undefined
}

export type DetailGroupId = 'parts' | 'colors' | 'guessed' | 'leftOut' | 'printNote' | 'source'

/** One line in a Details group; a source carries its page. */
export interface DetailItem {
  text: string
  url?: string
}

export interface DetailGroup {
  id: DetailGroupId
  label: string
  items: DetailItem[]
  /** Short names read as one line ("Tower, base, roof"); otherwise one item per line. */
  inline: boolean
}

export interface ReplyFacts {
  tags: string[]
  warnings: string[]
  groups: DetailGroup[]
}

// The words a person sees on the card, each in one place. American spelling, no dashes as punctuation.

/** The quiet line that opens the groups. */
export const DETAILS_LABEL = 'Details'
/** The warning list's name for a screen reader. */
export const WARNINGS_LABEL = 'Warnings'
/** Each group's label, in the order the groups show. */
export const GROUP_LABELS: Readonly<Record<DetailGroupId, string>> = {
  parts: 'Parts',
  colors: 'Colors',
  guessed: 'Guessed',
  leftOut: 'Left out',
  printNote: 'Print note',
  source: 'Source',
}
/** "1:150". */
export const scaleTag = (n: number): string => `1:${fmt(n)}`
/** "7 parts". */
export const partsTag = (n: number): string => `${n} parts`
/** A design.check item that failed: "Overall size is off the plan: wanted 64 x 64 x 180 mm, got 64 x 64 x 172 mm." */
export const checkWarning = (name: string, want: string, got: string): string => `${cap(name)} is off the plan: wanted ${want}, got ${got}.`
/** A size the person kept under the printer's smallest: "Tower wall is 0.5 mm, under the 0.8 mm this printer can print." */
export const underWarning = (name: string, planned: number, floor: number, units: string): string => `${cap(name)} is ${fmt(planned)} ${units}, under the ${fmt(floor)} ${units} this printer can print.`
/** The part is off the bed now. */
export const offBedWarning = (name: string): string => `The ${name} is off the bed. Move it onto the bed to print it.`
/** A color and the parts in it: "Red: bands, roof". */
export const colorLine = (color: string, parts: readonly string[]): string => `${cap(color)}: ${parts.join(', ')}`
/** A sheet row the person did not change, which stays a guess: "Wall 2 mm". */
export const guessLine = (label: string, value: number, unit: 'mm' | 'deg' | '%'): string => `${label} ${fmt(value)}${unit === '%' ? '%' : unit === 'deg' ? ' degrees' : ' mm'}`
/** A check item that passed with a warning: "Minimum wall: reads 0.4 mm at the rim's edge". */
export const passedNote = (name: string, warning: string): string => `${cap(name)}: ${warning}`

const ORDER: readonly DetailGroupId[] = ['parts', 'colors', 'guessed', 'leftOut', 'printNote', 'source']
const INLINE: ReadonlySet<DetailGroupId> = new Set(['parts', 'leftOut'])

function fmt(v: number): string {
  return String(Math.round(v * 100) / 100)
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

/** A tool's line as a sentence: a capital first and a period last. */
function sentence(s: string): string {
  const t = cap(s.trim())
  return /[.!?]$/.test(t) ? t : `${t}.`
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [])

/** N of 1:N from a plan's scale, or null when it has none it can read. */
export function planScale(scale: ReplyPlan['scale']): number | null {
  if (typeof scale === 'number') return Number.isFinite(scale) && scale > 0 ? scale : null
  if (typeof scale !== 'string') return null
  const m = /^(?:1\s*:\s*)?(\d+(?:\.\d+)?)$/.exec(scale.trim())
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

/** The card's tags: the size, the scale when the plan has one, and the part count when there is more than one. */
export function replyTags(part: CreatedPart, plan?: ReplyPlan | null): string[] {
  const scale = planScale(plan?.scale)
  return [partSize(part), ...(scale !== null ? [scaleTag(scale)] : []), ...(part.parts && part.parts > 1 ? [partsTag(part.parts)] : [])]
}

const rowsOf = (turn: Transcript['turns'][number]): ToolRowModel[] => turn.blocks.flatMap((b) => (b.kind === 'tools' ? b.rows : []))

/** The last ok row of a tool in the turn, with its output. */
function lastRow(rows: readonly ToolRowModel[], tool: string, has: (o: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  for (let k = rows.length - 1; k >= 0; k--) {
    const r = rows[k]!
    const o = obj(r.output)
    if (r.tool === tool && r.state === 'ok' && o && has(o)) return o
  }
  return null
}

/**
 * The facts of the turn that built `part`, sorted by source:
 * - warnings: design.check's failed items (its newest check in the turn), each size design.plan's answer says the
 *   person kept under the printer's smallest (underFloors), the warnings a design step returned (such as a body that now
 *   needs supports) and the part being off the bed now (the host's word);
 * - Parts: the plan's features, or the design's own parts when there is no plan; Colors: the plan's colors; Guessed:
 *   the plan's assumptions and the sheet's rows still at their guess; Left out: the plan's leftOut; Print note: what a
 *   passed check item or the check itself noted; Source: the turn's citations.
 * A group with nothing in it is left out.
 */
export function replyFacts(turn: Transcript['turns'][number], part: CreatedPart, host: FactsHost = {}): ReplyFacts {
  const rows = rowsOf(turn)
  const planned = lastRow(rows, 'design.plan', (o) => o['accepted'] === true && typeof o['planId'] === 'string')
  const plan = host.plan?.(planned ? (planned['planId'] as string) : null, part.id) ?? null
  const units = plan?.units ?? 'mm'

  const warnings: string[] = []
  const check = lastRow(rows, 'design.check', (o) => Array.isArray(o['items']))
  const items = check ? (check['items'] as unknown[]).map(obj).filter((i): i is Record<string, unknown> => i !== null) : []
  for (const i of items) if (i['pass'] === false && typeof i['name'] === 'string') warnings.push(checkWarning(i['name'], String(i['want'] ?? ''), String(i['got'] ?? '')))
  for (const u of Array.isArray(planned?.['underFloors']) ? (planned['underFloors'] as unknown[]) : []) {
    const o = obj(u)
    if (o && typeof o['name'] === 'string' && typeof o['planned'] === 'number' && typeof o['floor'] === 'number') warnings.push(underWarning(o['name'], o['planned'], o['floor'], units))
  }
  for (const r of rows) if (r.state === 'ok' && (changesDesign(r.tool) || r.tool.startsWith('geom.'))) warnings.push(...strings(obj(r.output)?.['warnings']).map(sentence))
  if (host.offBed?.(part.id)) warnings.push(offBedWarning(part.name))

  const groups: Partial<Record<DetailGroupId, DetailItem[]>> = {}
  const add = (id: DetailGroupId, texts: readonly string[]) => {
    const list = texts.filter((t) => t.trim() !== '')
    if (list.length) groups[id] = [...(groups[id] ?? []), ...list.map((text) => ({ text }))]
  }

  // Parts: the plan's features, else the design's parts as its newest step left them
  if (plan?.features.length) add('parts', plan.features.map((f) => f.name))
  else {
    const built = [...rows].reverse().find((r) => r.state === 'ok' && changesDesign(r.tool) && Array.isArray(obj(r.output)?.['parts']))
    add('parts', ((obj(built?.output)?.['parts'] as unknown[]) ?? []).map((p) => String(obj(p)?.['name'] ?? '')))
  }

  // Colors: each color with the planned features in it, in the order the plan first names them
  const byColor = new Map<string, string[]>()
  for (const [feature, color] of Object.entries(plan?.colors ?? {})) byColor.set(color, [...(byColor.get(color) ?? []), feature])
  add('colors', [...byColor].map(([color, features]) => colorLine(color, features)))

  // Guessed: what the plan assumed, then each sheet row the person left at its guess
  add('guessed', [...(plan?.assumptions ?? [])])
  for (const b of turn.blocks) {
    if (b.kind !== 'sheet') continue
    const changed = new Set(b.answer?.changed ?? [])
    add('guessed', b.sheet.dims.filter((d) => d.source === 'guess' && !changed.has(d.key)).map((d) => guessLine(d.label, b.answer?.values[d.key] ?? d.value, d.unit)))
  }

  add('leftOut', [...(plan?.leftOut ?? [])])

  // Print note: plain notes only, from the check: an item that passed with a warning, and the check's own notes
  add('printNote', [...items.filter((i) => i['pass'] === true && typeof i['warning'] === 'string' && typeof i['name'] === 'string').map((i) => passedNote(i['name'] as string, i['warning'] as string)), ...strings(check?.['notes'])])

  const cites: Citation[] = turn.blocks.flatMap((b) => (b.kind === 'citations' ? b.items : []))
  if (cites.length) groups.source = cites.map((c) => ({ text: c.title, ...(c.url ? { url: c.url } : {}) }))

  return {
    tags: replyTags(part, plan),
    warnings: [...new Set(warnings)],
    groups: ORDER.flatMap((id) => (groups[id]?.length ? [{ id, label: GROUP_LABELS[id], items: groups[id]!, inline: INLINE.has(id) }] : [])),
  }
}

/** The groups' inline text: "Tower, lantern room, base", the first name capitalized and the rest as given. */
export function inlineText(items: readonly DetailItem[]): string {
  return cap(items.map((i) => i.text).join(', '))
}
