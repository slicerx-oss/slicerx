// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// pilot.ask, pilot.sheet and lookup.show: a question with fixed answers that waits for the person's pick, a sheet of
// the sizes a part is built from that waits for the person to confirm or edit them, and a record shown as a card with
// its source. None changes anything; they are how mimir checks with the person and shows what it found.
import type { PilotDim, PilotDimAt, PilotSheet, PilotSheetBind, PilotSheetSolid } from '@slicerx/contracts'
import { dimText, kindOf, SIZE_KINDS } from '@slicerx/contracts/size-kind'
import { z } from 'zod'
import { defineTool, wasDismissed, type PilotTool } from '../tool'

/** What the model is told when it asks about sizes on a card where the sheet is offered. */
export const SIZES_ON_SHEET = 'Not shown: sizes go on the dimension sheet, not a question card. Call pilot.sheet now with a suggested value for each size (source guess unless you know it); the person edits them there.'

const choices = z.array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(40) })).min(2).max(4)
const question = { title: z.string().min(2).max(40), question: z.string().min(3).max(160), choices }

/**
 * `sizesOnSheet`: the sheet is offered beside it (the mimir tab), so the ask takes `sizes`, which mimir sets on a
 * question asking for the part's sizes: that one goes to the sheet instead. The words of a question decide nothing.
 */
export function askTool(opts: { sizesOnSheet?: boolean } = {}): PilotTool<never> {
  return defineTool<{ title: string; question: string; choices: { id: string; label: string }[]; sizes?: boolean | undefined }>({
    name: 'pilot.ask',
    version: '1.2.0',
    source: 'command',
    permission: 'read',
    description:
      'Ask the person a short question with two to four fixed answers and wait for the pick. Use it to confirm something before building on it, such as which model a photo shows. Returns the picked choice id; said, when the person wrote instead of picking: their words are the answer and turn no choice down, so go on from them and never ask the same thing again (when they leave it to you, as with "sensible defaults", pick the choice that gives what the request asked for); or dismissed when the person turned the question down. If dismissed, every choice on it is turned down: do not ask it again, and do not list its choices or repeat its question in your reply, in any wording. Carry on with what the request still allows, and if you truly need something, ask a different, narrower question.',
    localDescription:
      'Ask the person a short question (title, question) with two to four fixed choices and wait for the pick, to confirm something before building on it (such as which model a photo shows). Returns the picked choice id; said when they wrote instead: their words are the answer and turn no choice down, so go on and never ask the same thing again (left to you, pick the choice that gives what the request asked for); or dismissed when they turned it down: then every choice on it is turned down: never ask it again, list its choices or repeat its question in your reply, in any wording. Carry on with what the request still allows; if you truly need something, ask a different, narrower question.',
    input: opts.sizesOnSheet ? z.object({ ...question, sizes: z.boolean().optional().describe("true: it asks for the part's sizes") }) : z.object(question),
    args: (i) => `"${i.question}"`,
    async run(i, ctx) {
      if (!ctx.ask) return { ok: false, summary: 'Nobody here can answer a question' }
      // a redirect, not a failure: it never counts toward moving the run to the larger model
      if (opts.sizesOnSheet && i.sizes === true) return { summary: SIZES_ON_SHEET, output: { shown: false, use: 'pilot.sheet' } }
      const answer = await ctx.ask({ title: i.title, question: i.question, choices: i.choices })
      // turning a question down is an answer, not a failure: the run carries on from it. Words written in place of a pick
      // close the card the same way, but they are the person's answer and turn no choice down, so the model reads them
      // as said with no dismissed mark: one that read a turn-down asked again after "use sensible defaults, then build it".
      if (wasDismissed(answer.id)) {
        if (answer.said) return { summary: `Answered in words: "${answer.said}"`, output: { picked: null, said: answer.said } }
        return { summary: 'Dismissed', output: { picked: null, dismissed: true } }
      }
      const picked = answer.id
      const label = i.choices.find((c) => c.id === picked)?.label ?? picked
      return { summary: label, output: { picked, label } }
    },
  }) as PilotTool<never>
}

export function lookupTool(): PilotTool<never> {
  return defineTool({
    name: 'lookup.show',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'Show the person something you looked up as a card in the view: a title, up to 4 label and value rows and the page it came from, linked. It stays in the conversation too.',
    input: z.object({
      title: z.string().min(2).max(60),
      fields: z.array(z.tuple([z.string().min(1).max(32), z.string().min(1).max(80)])).min(1).max(4),
      source: z.object({ title: z.string().min(1).max(80), url: z.url({ protocol: /^https?$/ }) }),
    }),
    args: (i) => `"${i.title}"`,
    async run(i) {
      return { summary: i.title, output: { shown: true }, lookup: { title: i.title, fields: i.fields, source: i.source } }
    },
  }) as PilotTool<never>
}

// The sheet's part and places as one compact object each, not a union per kind: a model reads the kinds and their
// fields from the descriptions, and a missing field is refused with its name and the shape it needs (sheetProblems).
// Bounds are checked there too, so the schema a model reads carries no bound on every coordinate.
const num = z.number()
// coordinates as plain lists: their lengths are checked with the rest (sheetProblems), which keeps the schema short
const xyz = z.array(num)
const xy = z.array(num)
const outline = z.array(xy)
const plane = z.enum(['xy', 'xz', 'yz'])
const at = z
  .object({ a: xyz.optional(), b: xyz.optional(), off: xyz.optional(), c: xyz.optional(), from: xyz.optional(), to: xyz.optional(), r: num.optional() })
  .describe('Where the size sits, in the part\'s mm, Z up. A length: a and b its ends, off the move out to draw it, e.g. {"a":[0,0,0],"b":[80,0,0]}. An angle: corner c, directions from and to, arc radius r.')
const solid = z
  .object({
    kind: z.enum(['extrude', 'revolve', 'sweep', 'loft']).optional(),
    plane: plane.optional(),
    points: outline.optional(),
    holes: z.array(outline).optional(),
    from: num.optional(),
    to: num.optional(),
    axis: z.object({ point: xy, direction: xy }).optional(),
    angle: num.optional(),
    profile: z.object({ d: num.optional(), hole: num.optional(), points: outline.optional() }).optional(),
    path: z.array(xyz).optional(),
    round: num.optional(),
    sections: z.array(z.object({ at: num, d: num.optional(), points: outline.optional() })).optional(),
  })
  .describe(
    'One solid, in mm, Z up. Plane xy: points are (x, y), built along Z; xz: (x, z) along Y; yz: (y, z) along X. By kind: ' +
      'extrude (the default): plane, points (outline), from, to, holes optional, e.g. {"plane":"xy","points":[[0,0],[80,0],[80,60],[0,60]],"from":0,"to":30}. ' +
      'revolve: plane, points (the profile on one side of the axis), axis {point, direction} in the plane, angle optional (360), e.g. {"kind":"revolve","plane":"xz","points":[[5,0],[20,0],[20,40],[5,40]],"axis":{"point":[0,0],"direction":[0,1]}}. ' +
      'sweep: profile {d, hole optional} or {points}, path [[x,y,z],...], round optional (bend radius), e.g. {"kind":"sweep","profile":{"d":20,"hole":16},"path":[[0,0,0],[0,0,50],[50,0,50]],"round":25}. ' +
      'loft: plane, sections (2 or more, each at and d or points, along the plane\'s third axis), e.g. {"kind":"loft","plane":"xy","sections":[{"at":0,"d":60},{"at":100,"d":30}]}.',
  )

type SolidIn = z.infer<typeof solid>
type AtIn = z.infer<typeof at>
type Issue = { path: (string | number)[]; message: string }
type V2 = [number, number]
type V3 = [number, number, number]

const MM = 10_000
const SHAPE = {
  plane: '"xy", "xz" or "yz"',
  points: '[[x, y], ...] in mm, 3 or more',
  num: 'a number in mm',
  axis: '{"point": [x, y], "direction": [x, y]}',
  profile: '{"d": diameter in mm} (with "hole" for a bore) or {"points": [[x, y], ...]}',
  path: '[[x, y, z], ...] in mm, 2 or more',
  sections: '[{"at": mm, "d": mm} or {"at": mm, "points": [[x, y], ...]}, ...], 2 or more',
  at: '{"a": [x, y, z], "b": [x, y, z], "off": [x, y, z]} in mm, or {"c", "from", "to", "r"} for an angle',
}
const inMm = (v: number): boolean => Number.isFinite(v) && Math.abs(v) <= MM
/** A point of `n` coordinates, each in range. */
const pt = (p: readonly number[] | undefined, n: number): boolean => !!p && p.length === n && p.every(inMm)
const outlineOk = (o: readonly (readonly number[])[] | undefined): boolean => !!o && o.length >= 3 && o.length <= 200 && o.every((p) => pt(p, 2))

/** What a part's solid is missing or has wrong, each named with the shape it needs. */
function solidProblems(x: SolidIn, n: number): Issue[] {
  const kind = x.kind ?? 'extrude'
  const name = `part ${n + 1} (${kind})`
  const out: Issue[] = []
  const need = (field: string, shape: string): void => void out.push({ path: ['part', n, field], message: `${name} needs ${field}: ${shape}` })
  if (kind !== 'sweep' && !x.plane) need('plane', SHAPE.plane)
  if (kind === 'extrude' || kind === 'revolve') if (!outlineOk(x.points)) need('points', SHAPE.points)
  if (kind === 'extrude') {
    for (const f of ['from', 'to'] as const) if (x[f] === undefined || !inMm(x[f])) need(f, SHAPE.num)
    if (x.holes && (x.holes.length > 20 || !x.holes.every(outlineOk))) need('holes', `up to 20 outlines, each ${SHAPE.points}`)
  }
  if (kind === 'revolve') {
    if (!x.axis || !pt(x.axis.point, 2) || !pt(x.axis.direction, 2) || (x.axis.direction[0] === 0 && x.axis.direction[1] === 0)) need('axis', SHAPE.axis)
    if (x.angle !== undefined && Math.abs(x.angle) > 360) need('angle', 'degrees from -360 to 360')
  }
  if (kind === 'sweep') {
    const p = x.profile
    const round = p?.d !== undefined && p.points === undefined && p.d >= 0.1 && p.d <= MM && (p.hole === undefined || (p.hole >= 0.1 && p.hole < p.d))
    // an outline carries no bore, so its hole is dropped, but one out of range is still refused
    const shaped = p?.points !== undefined && p.d === undefined && outlineOk(p.points) && (p.hole === undefined || (p.hole >= 0.1 && p.hole <= MM))
    if (!round && !shaped) need('profile', SHAPE.profile)
    if (!x.path || x.path.length < 2 || x.path.length > 100 || !x.path.every((q) => pt(q, 3))) need('path', SHAPE.path)
    if (x.round !== undefined && (x.round < 0 || x.round > MM)) need('round', 'a bend radius in mm, 0 or more')
  }
  if (kind === 'loft') {
    if (!x.sections || x.sections.length < 2 || x.sections.length > 20) need('sections', SHAPE.sections)
    else
      x.sections.forEach((sec, k) => {
        const ok = inMm(sec.at) && (sec.d !== undefined ? sec.points === undefined && sec.d >= 0.1 && sec.d <= MM : outlineOk(sec.points))
        if (!ok) out.push({ path: ['part', n, 'sections', k], message: `${name} section ${k + 1} needs at (mm) and either d (a diameter in mm) or points [[x, y], ...], not both` })
      })
  }
  return out
}

const atOk = (a: AtIn): boolean => {
  const v = (p: readonly number[] | undefined): boolean => pt(p, 3)
  if (a.c !== undefined || a.from !== undefined || a.to !== undefined || a.r !== undefined) return v(a.c) && v(a.from) && v(a.to) && a.r !== undefined && a.r >= 0.1 && a.r <= MM
  // a length's offset may be left out: the drawing then moves its callout off the part on its own
  return v(a.a) && v(a.b) && (a.off === undefined || v(a.off))
}

/** A row's place as the sheet carries it: a straight size or an angle, nothing else. */
function placeOf(a: AtIn): PilotDimAt {
  const v = (p: number[] | undefined) => p as V3
  return a.c ? { c: v(a.c), from: v(a.from), to: v(a.to), r: a.r! } : { a: v(a.a), b: v(a.b), off: a.off ? v(a.off) : [0, 0, 0] }
}

/** A part's solid as the sheet carries it: only its own kind's fields. */
function solidOf(x: SolidIn): PilotSheetSolid {
  const o = (p: number[][] | undefined) => p as V2[]
  const opt = <K extends string, V>(k: K, v: V | undefined): Partial<Record<K, V>> => (v === undefined ? {} : ({ [k]: v } as Record<K, V>))
  switch (x.kind) {
    case 'revolve':
      return { kind: 'revolve', plane: x.plane!, points: o(x.points), axis: { point: x.axis!.point as V2, direction: x.axis!.direction as V2 }, ...opt('angle', x.angle) }
    case 'sweep': {
      const p = x.profile!
      return { kind: 'sweep', profile: p.d !== undefined ? { d: p.d, ...opt('hole', p.hole) } : { points: o(p.points) }, path: x.path as V3[], ...opt('round', x.round) }
    }
    case 'loft':
      return { kind: 'loft', plane: x.plane!, sections: x.sections!.map((sec) => (sec.d !== undefined ? { at: sec.at, d: sec.d } : { at: sec.at, points: o(sec.points) })) }
    default:
      return { ...opt('kind', x.kind), plane: x.plane!, points: o(x.points), ...opt('holes', x.holes?.map(o)), from: x.from!, to: x.to! }
  }
}

const dim = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  label: z.string().min(1).max(60),
  value: num,
  unit: z.enum(['mm', 'deg', '%']),
  kind: z.enum(SIZE_KINDS).optional(),
  min: num.optional(),
  max: num.optional(),
  source: z.enum(['asked', 'lookup', 'photo', 'guess']).describe('asked: the person said it; lookup: from a page (give sourceTitle and sourceUrl); photo: measured from their photo; guess: your best guess'),
  sourceTitle: z.string().min(1).max(80).optional(),
  sourceUrl: z.url({ protocol: /^https?$/ }).optional(),
  note: z.string().max(160).optional(),
  at: at.optional(),
})

/** The units a row of each stated kind may give, and the kind a unit other than mm means. */
const UNITS_OF_KIND: Record<(typeof SIZE_KINDS)[number], readonly ('mm' | 'deg' | '%')[]> = { count: ['mm'], angle: ['mm', 'deg'], length: ['mm', '%'] }
const KIND_OF_UNIT = { mm: 'length', deg: 'angle', '%': 'length' } as const

type SheetIn = { title: string; views: PilotSheet['views']; dims: z.infer<typeof dim>[]; part?: SolidIn[] | undefined; design?: string | undefined; fits?: boolean | undefined }

/** Every field the sheet's part and places are missing or have wrong, with the row or part named. */
export function sheetProblems(i: SheetIn): Issue[] {
  const out: Issue[] = []
  if (i.part && (i.part.length < 1 || i.part.length > 40)) out.push({ path: ['part'], message: 'part takes 1 to 40 solids' })
  i.part?.forEach((x, n) => out.push(...solidProblems(x, n)))
  i.dims.forEach((d, n) => {
    // a kind and a unit that disagree (a length in degrees, a count in percent) would show the row wrong, so it is refused
    if (d.kind && !UNITS_OF_KIND[d.kind].includes(d.unit)) out.push({ path: ['dims', n, 'kind'], message: `row ${n + 1} (${d.label}) is kind ${d.kind} but unit ${d.unit}; give unit ${UNITS_OF_KIND[d.kind].join(' or ')}, or kind ${KIND_OF_UNIT[d.unit]}` })
    for (const f of ['value', 'min', 'max'] as const) if (d[f] !== undefined && !(Math.abs(d[f]) <= 100_000)) out.push({ path: ['dims', n, f], message: `row ${n + 1} (${d.label}) ${f} is outside -100000 to 100000` })
    if (d.at && !atOk(d.at)) out.push({ path: ['dims', n, 'at'], message: `row ${n + 1} (${d.label}) needs at: ${SHAPE.at}` })
  })
  return out
}

/** The checked input as the sheet carries it: each row's place and each solid with only its own fields. */
export function sheetOf(i: SheetIn): Omit<PilotSheet, 'id'> {
  return {
    title: i.title,
    views: i.views,
    dims: i.dims.map(({ at: a, ...d }) => ({ ...d, ...(a ? { at: placeOf(a) } : {}) }) as PilotDim),
    ...(i.part ? { part: i.part.map(solidOf) } : {}),
    ...(i.design ? { design: i.design } : {}),
    ...(i.fits ? { fits: true } : {}),
  }
}

/** A row with no place, as a refusal names it. */
const unplacedRow = (d: { label: string }, n: number): string => `row ${n + 1} (${d.label}) needs at: ${SHAPE.at}`

export function sheetTool(): PilotTool<never> {
  return defineTool({
    name: 'pilot.sheet',
    version: '1.4.0',
    source: 'command',
    permission: 'read',
    description:
      'Before building a part, show the person every size it is built from (width, length, height, wall, holes, clearance and so on). Set fits when a size must fit something the person has or something the part holds (a shelf it clamps, a phone it carries, a screw it takes), where a wrong size wastes a print: that sheet waits for them to confirm or edit. Without fits (a display model, a part at its default size) the sheet shows and you build with its sizes at once; the person changes one after. In a follow-up on a part already built no sheet waits. Give each its best value, unit and source: asked, lookup (with the page), photo, or guess, and kind count or angle for a row that is a count or an angle. Use it whenever a size matters and you are not sure of it. Returns the values to build with and which ones the person changed, or that they canceled (then build nothing and ask what to change), or that they set it aside by writing to you (then do what they wrote). A sheet with one row asks for one number. Every row of a sheet of several sizes needs at, where it sits on the part, so each row gets its numbered callout. For a new part give part, the part as it will be built, never boxes standing in for it: extruded outlines (a hollow wall as its outline with the inside as a hole, posts, ribs, the lid beside the base as it prints), and a revolve, sweep or loft for a round, bent or tapered body (a pipe bend is a sweep with round). For a part already built give design, its id: the sheet then draws that design as built, so part can be left out, and at is in the design\'s own coordinates, as geom.info and geom.faces read them. With neither, the sheet draws the design this run is building, every part as assembled, or before anything is built shows the sizes as a list with no drawing and no callouts. A row: {"key": "length", "label": "Length", "value": 80, "unit": "mm", "source": "guess", "at": {"a": [0, 0, 0], "b": [80, 0, 0]}}; a count takes unit mm and kind count.',
    localDescription:
      'Before building a part, show a sheet (title, views) with every size it is built from (dims: width, length, height, wall, holes, clearance). Use it whenever a size matters and you are unsure. Give each its best value, unit, source and kind for a count or angle. Returns the values to build with and which changed, or a cancel (then build nothing, ask what to change). One row asks for one number. Several rows each need at. New part: part, its solids as built (hollow walls as outline plus hole, lid beside base), never stand-in boxes. Built part: design, its id.',
    input: z
      .object({
        title: z.string().min(2).max(60),
        views: z.array(z.enum(['front', 'top', 'side', 'iso'])).min(1).max(4).default(['top', 'front', 'side', 'iso']),
        dims: z.array(dim).min(1).max(30),
        part: z.array(solid).optional(),
        design: z.string().min(1).max(80).optional().describe('Id of a built design the sheet shows; at is then in its coordinates'),
        fits: z.boolean().optional().describe('A size must fit something the person has: only then the sheet waits for a confirm'),
      })
      .refine((i) => new Set(i.dims.map((d) => d.key)).size === i.dims.length, 'each dimension needs its own key')
      .refine((i) => i.dims.every((d) => (d.min === undefined || d.value >= d.min) && (d.max === undefined || d.value <= d.max)), 'a value is outside its own min and max')
      .refine((i) => i.dims.every((d) => d.source !== 'lookup' || d.sourceUrl !== undefined || d.sourceTitle !== undefined), 'a looked-up value needs its sourceTitle, or its sourceUrl')
      .superRefine((i, ctx) => {
        for (const p of sheetProblems(i)) ctx.addIssue({ code: 'custom', path: p.path, message: p.message })
      }),
    args: (i) => `"${i.title}", ${i.dims.length} sizes`,
    async run(i, ctx) {
      if (!ctx.sheet) return { ok: false, summary: 'Nobody here can confirm a sheet' }
      // a sheet that names no part draws the design the run is building, whole, with every part as assembled; with
      // none built yet, it shows as a list of sizes with no drawing rather than going back
      const current = !i.part?.length && !i.design ? ctx.currentDesign?.() : undefined
      if (current && (!ctx.sheetDesign || ctx.sheetDesign(current))) i = { ...i, design: current }
      const drawn = !!i.part?.length || !!i.design
      // a design that is not on the plate would show the sheet with no drawing, so mimir hears of it instead
      if (i.design && ctx.sheetDesign && !ctx.sheetDesign(i.design)) return { ok: false, inputRefused: true, summary: `Not shown: no built design ${i.design} on the plate; use the design id geom.info gives, or give part instead.` }
      // a count (windows: 4) is no length on the part, so it shows in the list with no callout
      const unplaced = i.dims.length > 1 && drawn ? i.dims.flatMap((d, n) => (d.at || kindOf(d.key, d.kind) === 'count' ? [] : [unplacedRow(d, n)])) : []
      if (unplaced.length) return { ok: false, inputRefused: true, summary: `Not shown: every row needs at, where it sits on the part, so its callout shows on the drawing. ${unplaced.join('; ')}. Send it again with them.` }
      const answer = await ctx.sheet(sheetOf(i))
      // words written while it waited set it aside: they are the person's answer, as for a dismissed question
      if (!answer.confirmed && answer.said) {
        // sizes they had typed on the sheet before writing come along, so they are not lost, each read as the sheet shows
        // it: a count given in mm with no unit, an angle in degrees
        const typed = answer.changed.map((k) => {
          const d = i.dims.find((x) => x.key === k)!
          return `${d.label} ${dimText(d, answer.values[k]!)} (was ${d.value})`
        })
        const sizes = typed.length ? ` They had typed on it: ${typed.join(', ')}; keep those.` : ''
        return { ok: false, summary: `Set aside; the person wrote instead: "${answer.said}".${sizes} Build nothing from this sheet: do what they wrote, and show a new sheet if sizes still need confirming (words never confirm one).`, output: answer }
      }
      if (!answer.confirmed) return { ok: false, summary: 'Canceled; build nothing until the sizes are confirmed', output: answer }
      // nobody was asked: the sizes stand as shown, and the person changes one after
      if (answer.auto) return { summary: `Shown; build with these sizes now (it fits nothing the person has, so it does not wait). Say the size in the reply; the person can change it after`, output: answer }
      const n = answer.changed.length
      // a list with no drawing reaches the person, but each row's callout needs the part: the next sheet gives it
      const listed = !drawn && i.dims.length > 1 ? `. It showed as a list with no drawing: give part (the part as it will be built) or design on the next sheet, so each row gets its callout` : ''
      return { summary: (n ? `Confirmed, ${n} size${n === 1 ? '' : 's'} changed` : 'Confirmed as shown') + listed, output: answer }
    },
  }) as PilotTool<never>
}

export function sheetBindTool(): PilotTool<never> {
  return defineTool({
    name: 'pilot.sheet_bind',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      'After building from a sheet, never before, tie its rows to the steps they set, so editing a row later edits that step: for each row its key, the step (from 1) in the design, and how the step number follows the row (scale and offset; a symmetric extrude is half a width). Rows that shape a sketch rather than one number stay unbound; editing those asks you to build again. With no row to tie, skip it.',
    input: z.object({
      design: z.string().min(1).max(80),
      binds: z
        .array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), step: z.number().int().min(1).max(1000), scale: z.number().min(-1000).max(1000).optional(), offset: z.number().min(-100_000).max(100_000).optional() }))
        .min(1, 'give at least one row; tie rows once the part is built, and skip this call when no row sets one step')
        .max(30),
    }),
    args: (i) => `${i.binds.length} rows to ${i.design}`,
    async run(i, ctx) {
      if (!ctx.bindSheet?.(i.design, i.binds as PilotSheetBind[])) return { ok: false, summary: 'No sheet to bind in this conversation' }
      return { summary: `Tied ${i.binds.length} row${i.binds.length === 1 ? '' : 's'} to the design`, output: { bound: i.binds.length } }
    },
  }) as PilotTool<never>
}
