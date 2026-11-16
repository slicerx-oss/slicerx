// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// run.target: the printer and spools a chat's print goes to, from what the person said ("my A1", "black PETG"), else
// from their notes, else the only printer online. Only when none of that settles it does the person get a card with
// each online printer's loaded spools. Changes nothing outside the project: the plate's printer and which spool each
// filament prints on.
import { baseMaterial, COLOR_SLOT_MAX, colorDistance, matchSlots, type FilamentSlot, type MapFilament, type PrinterInfo, type PrinterStatus } from '@slicerx/contracts'
import { z } from 'zod'
import type { MemoryFact, MemoryStore } from '../memory/facts'
import { colorWord, colorWordHex } from '../run/colors'
import type { LandedPart, RunLanded } from '../run/print-run'
import { defineTool, type PilotTool } from '../tool'

/** Material families a spool or a note names, longest first so "PETG" is not read as "PET". */
const MATERIALS = ['PETG', 'PCTG', 'HIPS', 'PLA', 'ABS', 'ASA', 'TPU', 'PVA', 'PET', 'PA', 'PC', 'PP']

/** What the person asked one filament to print with. Keys are 1 based filament numbers, as the app counts them. */
interface Wanted extends MapFilament {
  /** The color word they named ("black"), when they named one. */
  word: string | null
  /** The color as the call gave it ("black", "#d9a441"), or '' for none. */
  said: string
}

export interface RunTargetResult {
  printerId: string
  printerName: string
  slots: { filament: number; slot: string; material: string; color: string }[]
  from: 'words' | 'memory' | 'only' | 'picked'
  /**
   * Filaments asked for that no loaded spool of their material and color takes, by number, as they were asked. They
   * keep their own color and are not moved; the person says whether to load them or print with other spools.
   */
  unmatched?: { filament: number; material: string; color: string }[]
  /** Every spool the printer has loaded, when a filament is unmatched, so the question can name them. */
  loaded?: { slot: string; material: string; color: string }[]
  /** Parts moved onto this printer's bed, by name and plate: they hung off it or sat in an excluded area. */
  moved?: LandedPart[]
  /** Parts with no room on this printer's bed, by name and plate; they stay where they were. */
  offBed?: LandedPart[]
}

/**
 * Words that name no printer in particular ("my printer", "the usual 3D-printer", "any printer"): read as no name, but
 * only when no printer goes by them.
 */
const FILLER = /^(?:(?:my|the|our|a|your|any)\s+)?(?:usual\s+)?(?:3d[\s-]*)?printers?$/i

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** Whether `part` appears in `all` as a run of whole words. */
function contains(all: readonly string[], part: readonly string[]): boolean {
  if (part.length === 0 || part.length > all.length) return false
  for (let i = 0; i + part.length <= all.length; i++) if (part.every((w, j) => all[i + j] === w)) return true
  return false
}

/** The printers with the most words matched, or none when none matched. */
function longest(found: readonly { p: PrinterInfo; n: number }[]): PrinterInfo[] {
  const most = Math.max(0, ...found.map((f) => f.n))
  return most === 0 ? [] : found.filter((f) => f.n === most).map((f) => f.p)
}

/**
 * The printers a request names: an exact id, then a name, then a model. A model counts when all its words are in the
 * request, the most words first, so "my A1" is the A1 and not the A1 mini. Only when no model fits that way does a
 * shorter request reach a longer model ("A1" finds an A1 mini when there is no A1).
 */
export function namedPrinters(request: string, printers: readonly PrinterInfo[]): PrinterInfo[] {
  const said = request.trim()
  const byId = printers.filter((p) => p.id === said)
  if (byId.length) return byId
  const lower = said.toLowerCase()
  const byName = printers.filter((p) => p.name.trim().toLowerCase() === lower)
  if (byName.length) return byName
  const all = words(said)
  const inName = longest(printers.map((p) => ({ p, n: contains(all, words(p.name)) ? words(p.name).length : 0 })))
  if (inName.length) return inName
  const inModel = longest(printers.map((p) => ({ p, n: contains(all, words(p.model)) ? words(p.model).length : 0 })))
  if (inModel.length) return inModel
  const meaningful = all.filter((w) => /\d/.test(w) || w.length > 3)
  return printers.filter((p) => contains(words(p.model), meaningful))
}

/** The material family named in some words, or null. */
function materialIn(text: string): string | null {
  const upper = text.toUpperCase().split(/[^A-Z0-9]+/)
  return MATERIALS.find((m) => upper.includes(m)) ?? null
}

/** A note's words and data values, as one line to read a printer or filament from. */
const noteText = (f: MemoryFact): string => [f.text, ...Object.values(f.data ?? {}).map(String)].join(' ')

const newestFirst = (facts: readonly MemoryFact[], kind: MemoryFact['kind']): MemoryFact[] => facts.filter((f) => f.kind === kind).sort((a, b) => b.updatedAt - a.updatedAt)

/** The spool's color in words for the person, "Black", or its hex when it has no plain name. */
const shownColor = (s: FilamentSlot): string => {
  const w = colorWord(s.color)
  return w ? w[0]!.toUpperCase() + w.slice(1) : (s.color ?? '')
}

const loaded = (s: FilamentSlot): boolean => Boolean(s.material || s.color)

/** Whether a slot holds what one filament asks for: the same material family, and the named color if there is one. */
function holds(s: FilamentSlot, w: Wanted): boolean {
  if (!s.material || baseMaterial(s.material) !== baseMaterial(w.type)) return false
  return w.word === null || colorWord(s.color) === w.word || colorDistance(s.color, w.color) < 60
}

/** Whether a spool can feed a filament at all: a loaded spool of its material family, or any loaded one when no material is known. */
const sameMaterial = (s: FilamentSlot | undefined, w: Wanted | undefined): boolean => Boolean(s?.material) && (!w?.type || baseMaterial(s!.material) === baseMaterial(w.type))

/**
 * Each filament's slot on one printer: matched by material and the closest color (as the Print sheet matches), and
 * kept only when the slot holds what was asked. `pinned` gives one filament a slot the person picked, only when that
 * slot holds its material: a filament never goes on a spool of another material. Every filament asked for ends up in
 * the map or in `missing`.
 */
function placeOn(wanted: readonly Wanted[], slots: readonly FilamentSlot[], pinned?: { filament: number; slot: string }): { map: Record<number, string>; missing: Wanted[] } {
  const pin = pinned && sameMaterial(slots.find((s) => s.id === pinned.slot), wanted.find((w) => w.index === pinned.filament)) ? pinned : undefined
  const free = pin ? slots.filter((s) => s.id !== pin.slot) : slots
  const rest = pin ? wanted.filter((w) => w.index !== pin.filament) : wanted
  const map: Record<number, string> = matchSlots(rest, free)
  const missing = rest.filter((w) => {
    const s = free.find((x) => x.id === map[w.index])
    if (s && holds(s, w)) return false
    delete map[w.index]
    return true
  })
  if (pin) map[pin.filament] = pin.slot
  return { map, missing }
}

/** What each filament asks for, from the call: a color with no material takes the material of the closest loaded spool. */
function wantedFrom(asked: readonly { index?: number | undefined; material?: string | undefined; color?: string | undefined }[], slots: readonly FilamentSlot[]): Wanted[] {
  return asked.map((a, i) => {
    const hex = a.color ? colorWordHex(a.color) : null
    const word = hex ? colorWord(hex) : null
    let type = a.material ? (materialIn(a.material) ?? a.material.trim().toUpperCase()) : ''
    if (!type && hex) type = [...slots].filter((s) => s.material).sort((x, y) => colorDistance(x.color, hex) - colorDistance(y.color, hex))[0]?.material ?? ''
    return { index: a.index ?? i + 1, type, color: hex ?? '', word, said: a.color?.trim() ?? '' }
  })
}

/** A filament the person remembered they print with, such as "Black PETG for most things". */
function rememberedFilament(facts: readonly MemoryFact[]): { material?: string; color?: string }[] {
  for (const f of newestFirst(facts, 'filament')) {
    const text = noteText(f)
    const material = materialIn(text)
    const hex = colorWordHex(text)
    if (material || hex) return [{ ...(material ? { material } : {}), ...(hex ? { color: hex } : {}) }]
  }
  return []
}

/** The online printer the person's newest printer note names, or null when no note names exactly one. */
function rememberedPrinter(facts: readonly MemoryFact[], online: readonly PrinterInfo[]): PrinterInfo | null {
  for (const f of newestFirst(facts, 'printer')) {
    const found = namedPrinters(noteText(f), online)
    if (found.length === 1) return found[0]!
  }
  return null
}

const label = (p: PrinterInfo, s: FilamentSlot): string => {
  const what = [s.material, shownColor(s)].filter(Boolean).join(', ')
  return `${p.name}, slot ${s.id}${what ? `: ${what}` : ''}`
}

/**
 * A plain sentence for the color words in the call that name no color, or '' when every one does. Those filaments are
 * matched by material only, and the person hears that rather than a spool that quietly ignores what they said.
 */
function unknownColors(asked: readonly { color?: string | undefined }[]): string {
  const unknown = [...new Set(asked.map((a) => a.color?.trim() ?? '').filter((c) => c && colorWordHex(c) === null))]
  if (!unknown.length) return ''
  const list = listed(unknown.map((c) => `"${c}"`))
  return unknown.length === 1 ? `${list} is not a color I know, so its spool was matched by material only.` : `${list} are not colors I know, so their spools were matched by material only.`
}

/** Words in a list: "a", "a and b", "a, b and c". */
const listed = (all: readonly string[]): string => (all.length < 2 ? (all[0] ?? '') : `${all.slice(0, -1).join(', ')} and ${all.at(-1)!}`)

/**
 * What the new printer's bed did to the parts, in plain words: the ones moved onto it, and the ones with no room on it,
 * which stay where they were. '' when nothing had to move.
 */
function landedWords(printer: string, landed: RunLanded | void): string {
  if (landed?.bedNotReady) return `${printer}'s bed was not ready, so parts were not checked against it.`
  const bed = landed?.genericBed ? 'the bed' : `${printer}'s bed`
  // a plate is named only when there is more than one
  const named = (parts: readonly LandedPart[] | undefined): string[] => [...new Set((parts ?? []).map((p) => (landed?.manyPlates && p.plate ? `${p.name} on ${p.plate}` : p.name)))]
  const moved = named(landed?.moved)
  const off = named(landed?.offBed)
  const one = off.length === 1
  return [
    moved.length ? `Moved ${listed(moved)} to fit ${bed}.` : '',
    off.length ? `${listed(off)} ${one ? 'does' : 'do'} not fit on ${bed}. Scale ${one ? 'it' : 'them'} down or pick another printer.` : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/** A filament as asked, "filament 3 (PLA, orange)", or its number alone for a list: "3 (PLA, orange)". */
const filamentWords = (w: Wanted, named: boolean): string => {
  const what = [w.type, w.said].filter(Boolean).join(', ')
  return `${named ? 'Filament ' : ''}${w.index}${what ? ` (${what})` : ''}`
}

/**
 * The filaments no loaded spool takes, and what the printer has loaded, in plain words: "Filaments 3 (PLA, orange)
 * and 4 (PLA, red) are not matched: Desk has no loaded spool of the same material and color. Loaded: slot A1 (PLA,
 * white) and slot A2 (PETG, blue)." '' when every filament has a spool.
 */
function unmatchedWords(printer: string, missing: readonly Wanted[], loadedSlots: readonly { slot: string; material: string; color: string }[]): string {
  if (!missing.length) return ''
  const one = missing.length === 1
  const who = one ? filamentWords(missing[0]!, true) : `Filaments ${listed(missing.map((w) => filamentWords(w, false)))}`
  const same = missing.some((w) => w.color) ? 'the same material and color' : 'the same material'
  const spools = listed(loadedSlots.map((r) => `slot ${r.slot} (${[r.material, r.color].filter(Boolean).join(', ')})`))
  return `${who} ${one ? 'is' : 'are'} not matched: ${printer} has no loaded spool of ${same}.${spools ? ` Loaded: ${spools}.` : ''}`
}

/** "PETG, Black" for the question. */
const wantedWords = (w: readonly Wanted[]): string =>
  w
    .map((x) => [x.word ? x.word[0]!.toUpperCase() + x.word.slice(1) : null, x.type || null].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' and ') || 'that filament'

export function runTools(opts: { memory?: MemoryStore | undefined } = {}): PilotTool<never>[] {
  const target = defineTool({
    name: 'run.target',
    version: '1.2.0',
    source: 'command',
    permission: 'slice',
    toolset: 'printers',
    title: 'Pick the printer and spool',
    description:
      'Set the printer and spools for this chat\'s print from the person\'s words ("my A1", "black PETG"), else their notes or the only fit online. Asks on a card only when that does not settle it. Call it before slicing.',
    input: z.object({
      printer: z.string().min(1).max(80).optional().describe('The printer as the person named it: its name, model or id'),
      filaments: z
        .array(
          z.object({
            index: z.number().int().min(1).max(COLOR_SLOT_MAX).optional().describe('The filament number on the plate, from 1; the order given when left out'),
            material: z.string().min(1).max(40).optional().describe('Such as PLA or PETG'),
            color: z.string().min(1).max(40).optional().describe('A color word such as black, or #RRGGBB'),
          }),
        )
        .max(16)
        .optional(),
    }),
    args: (i) => [i.printer ? `"${i.printer}"` : null, ...(i.filaments ?? []).map((f) => [f.color, f.material].filter(Boolean).join(' '))].filter(Boolean).join(', '),
    async approval(i) {
      return { title: 'Pick the printer and spool for this print?', lines: [i.printer ? `Printer: ${i.printer}` : 'Printer: as your notes or the printers online say'], actions: [] }
    },
    async run(i, ctx) {
      if (!ctx.run) return { ok: false, summary: 'This chat keeps no print run, so there is no printer to pick for it.' }
      const printers = await ctx.host.printers.list()
      const status = new Map<string, PrinterStatus>()
      await Promise.all(
        printers.map(async (p) => {
          const s = await ctx.host.printers.status(p.id).catch(() => null)
          if (s) status.set(p.id, s)
        }),
      )
      const online = printers.filter((p) => {
        const s = status.get(p.id)
        return s !== undefined && s.state !== 'offline'
      })
      const slotsOf = (p: PrinterInfo): FilamentSlot[] => status.get(p.id)?.slots ?? []
      const odd = unknownColors(i.filaments ?? [])
      const withOdd = (text: string): string => [text, odd].filter(Boolean).join(' ')
      // the name against every printer, online or not, so a printer that is off is never swapped for another
      const anyNamed = i.printer ? namedPrinters(i.printer, printers) : []
      const named = i.printer && (anyNamed.length > 0 || !FILLER.test(i.printer.trim())) ? i.printer : undefined
      const facts = opts.memory && (!named || !i.filaments?.length) ? await opts.memory.list().catch(() => []) : []

      // the printer: the person's words, else their notes, else the only one online
      let printer: PrinterInfo | null = null
      let from: RunTargetResult['from'] = 'words'
      let why = ''
      let among = online
      // a name that matches no printer at all, which the only-fit rule below still looks past
      let unmatched = ''
      if (named) {
        const found = anyNamed.filter((p) => online.includes(p))
        if (found.length === 1) printer = found[0]!
        else if (found.length > 1) {
          among = found
          why = `${found.length} printers match "${named}".`
        } else if (anyNamed.length) {
          const names = anyNamed.map((p) => p.name)
          why = `${names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`} ${names.length === 1 ? 'is' : 'are'} offline.`
        } else {
          why = `No printer matches "${named}".`
          unmatched = named
        }
      } else {
        printer = rememberedPrinter(facts, online)
        from = 'memory'
        if (!printer && online.length === 1) {
          printer = online[0]!
          from = 'only'
        }
        if (!printer) why = online.length ? `${online.length} printers are online.` : ''
      }

      // the spools: what the person named, else what their notes say they print with
      // a filament asked for with no color is matched by the project's own color for it (and its material when none
      // is named), as if the call had named them: never by its number, which says nothing about what the spool holds
      const project = ctx.run.filaments?.() ?? []
      const own = (a: NonNullable<typeof i.filaments>[number], k: number) => {
        const f = a.color ? undefined : project.find((p) => p.index === (a.index ?? k + 1))
        return f?.color ? { ...a, color: f.color, ...(a.material || !f.type ? {} : { material: f.type }) } : a
      }
      const asked = i.filaments?.length ? i.filaments.map(own) : rememberedFilament(facts)
      // no printer named (or none the name matches) or remembered, but only one printer online holds every spool asked
      // for: that one
      let fitNote = ''
      if (!printer && (!named || unmatched) && asked.length && online.length > 1) {
        const fits = online.filter((p) => {
          const slots = slotsOf(p)
          const wanted = wantedFrom(asked, slots)
          return wanted.length > 0 && slots.some(loaded) && placeOn(wanted, slots).missing.length === 0
        })
        if (fits.length === 1) {
          printer = fits[0]!
          from = unmatched ? 'only' : 'words'
          why = ''
          if (unmatched) fitNote = `No printer matches "${unmatched}", so I picked ${printer.name}, the only one with that filament.`
        }
      }
      let placed: { map: Record<number, string>; missing: Wanted[] } = { map: {}, missing: [] }
      if (printer) {
        const slots = slotsOf(printer)
        const wanted = wantedFrom(asked, slots)
        if (wanted.length && !slots.some(loaded)) why = `${printer.name} has not reported its spools yet.`
        else if (wanted.length) {
          placed = placeOn(wanted, slots)
          if (placed.missing.length) why = `${printer.name} has no ${wantedWords(placed.missing)} loaded.`
        }
        if (why) among = online
      }

      // the printer is settled and only spools are missing: the card offers the spools that can take the first missing
      // filament, its material on any printer online; with none, the filaments come back unmatched and the person is asked
      const spoolsOnly = printer !== null && placed.missing.length > 0
      const first = placed.missing[0]?.index ?? wantedFrom(asked, printer ? slotsOf(printer) : []).at(0)?.index ?? 1
      const fits = (p: PrinterInfo, s: FilamentSlot): boolean => !spoolsOnly || sameMaterial(s, wantedFrom(asked, slotsOf(p)).find((w) => w.index === first))
      if (printer && why && spoolsOnly && !among.some((p) => slotsOf(p).some((s) => loaded(s) && fits(p, s)))) why = ''
      if (printer && why && spoolsOnly && !ctx.ask) why = ''

      if (!printer || why) {
        const choices = among.flatMap((p) => slotsOf(p).filter((s) => loaded(s) && fits(p, s)).map((s) => ({ id: `pick:${p.id}:${s.id}`, label: label(p, s) })))
        if (!choices.length) return { ok: false, summary: withOdd(online.length ? `${why} No printer online has a spool loaded.`.trim() : 'No printer is online.') }
        if (!ctx.ask) return { ok: false, summary: withOdd(`${why} Ask the person which printer and spool to use.`.trim()) }
        const picked = await ctx.ask({ title: 'Which printer and spool?', question: withOdd(`${why} Pick the spool to print with.`.trim()), choices: [...choices, { id: 'pick:none', label: 'None of these' }] })
        // a dismissed question has no pick, so it ends here like None of these
        const m = /^pick:(.+):([^:]+)$/.exec(picked.id)
        printer = m ? (among.find((p) => p.id === m[1]) ?? null) : null
        if (!m || !printer) return { ok: false, summary: 'No printer picked. Nothing changed.' }
        from = 'picked'
        const slots = slotsOf(printer)
        const wanted = wantedFrom(asked, slots)
        placed = placeOn(wanted, slots, { filament: first, slot: m[2]! })
      }

      const slots = slotsOf(printer)
      const map = placed.map
      // a bed of another size or with excluded areas lands the parts again; the reply says what moved and what has no room
      const landed = await ctx.run.setTarget?.({ printerId: printer.id, slots: map, printerSlots: slots, model: { vendor: printer.vendor, model: printer.model } })
      ctx.run.update({ printerId: printer.id, slots: map })
      const rows = Object.entries(map)
        .map(([k, id]) => {
          const s = slots.find((x) => x.id === id)
          return { filament: Number(k), slot: id, material: s?.material ?? '', color: s ? (colorWord(s.color) ?? s.color ?? '') : '' }
        })
        .sort((a, b) => a.filament - b.filament)
      const missing = [...placed.missing].sort((a, b) => a.index - b.index)
      const loadedSlots = missing.length ? slots.filter(loaded).map((s) => ({ slot: s.id, material: s.material ?? '', color: colorWord(s.color) ?? s.color ?? '' })) : []
      const out: RunTargetResult = {
        printerId: printer.id,
        printerName: printer.name,
        slots: rows,
        from,
        ...(missing.length ? { unmatched: missing.map((w) => ({ filament: w.index, material: w.type, color: w.said })), loaded: loadedSlots } : {}),
        ...(landed?.moved.length ? { moved: landed.moved } : {}),
        ...(landed?.offBed.length ? { offBed: landed.offBed } : {}),
      }
      const spools = rows.map((r) => `slot ${r.slot} (${[r.material, r.color].filter(Boolean).join(', ')})`).join(', ')
      return { summary: withOdd([fitNote, `Printing on ${printer.name}${spools ? ` from ${spools}` : ''}.`, unmatchedWords(printer.name, missing, loadedSlots), landedWords(printer.name, landed)].filter(Boolean).join(' ')), output: out }
    },
  })
  return [target as PilotTool<never>]
}
