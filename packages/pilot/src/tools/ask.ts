// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// pilot.ask, pilot.sheet and lookup.show: a question with fixed answers that waits for the person's pick, a sheet of
// the sizes a part is built from that waits for the person to confirm or edit them, and a record shown as a card with
// its source. None changes anything; they are how mimir checks with the person and shows what it found.
import type { PilotDim, PilotSheetBind, PilotSheetSolid } from '@slicerx/contracts'
import { z } from 'zod'
import { defineTool, wasDismissed, type PilotTool } from '../tool'

export function askTool(): PilotTool<never> {
  return defineTool({
    name: 'pilot.ask',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      'Ask the person a short question with two to four fixed answers and wait for the pick. Use it to confirm something before building on it, such as which model a photo shows. Returns the picked choice id, or dismissed when the person turned the question down. If dismissed, every choice on it is turned down: do not ask it again, and do not list its choices or repeat its question in your reply, in any wording. Carry on with what the request still allows, and if you truly need something, ask a different, narrower question. If they wrote something, treat it as their answer.',
    localDescription:
      'Ask the person a short question (title, question) with two to four fixed choices and wait for the pick, to confirm something before building on it (such as which model a photo shows). Returns the picked choice id, or dismissed when the person turned it down; then every choice on it is turned down: never ask it again, list its choices or repeat its question in your reply, in any wording. Carry on with what the request still allows; if you truly need something, ask a different, narrower question. Anything they wrote is their answer.',
    input: z.object({
      title: z.string().min(2).max(40),
      question: z.string().min(3).max(160),
      choices: z.array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(40) })).min(2).max(4),
    }),
    args: (i) => `"${i.question}"`,
    async run(i, ctx) {
      if (!ctx.ask) return { ok: false, summary: 'Nobody here can answer a question' }
      const answer = await ctx.ask({ title: i.title, question: i.question, choices: i.choices })
      // turning a question down is an answer, not a failure: the run carries on from it
      if (wasDismissed(answer.id)) {
        if (answer.said) return { summary: `Dismissed, wrote: "${answer.said}"`, output: { picked: null, dismissed: true, said: answer.said } }
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
    description: 'Show the person something you looked up as a card in the view, with its source link: a title, up to four label and value rows, and the page it came from. It also stays in the conversation.',
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

const mm = z.number().min(-10_000).max(10_000)
const vec = z.tuple([mm, mm, mm])
const at = z
  .union([z.object({ a: vec, b: vec, off: vec }), z.object({ c: vec, from: vec, to: vec, r: z.number().min(0.1).max(10_000) })])
  .describe('Where the size sits on the drawing, in the part\'s own mm (Z up): a straight size from a to b drawn moved out by off, or an angle at c from direction from to direction to with an arc r out')
const outline = z.array(z.tuple([mm, mm])).min(3).max(200)
const plane = z.enum(['xy', 'xz', 'yz']).describe('xy: points are (x, y), extruded along Z; xz: (x, z) along Y; yz: (y, z) along X')
const pt2 = z.tuple([mm, mm])
const size = z.number().min(0.1).max(10_000)
const extrude = z.object({
  kind: z.literal('extrude').optional(),
  plane,
  points: outline,
  holes: z.array(outline).max(20).optional(),
  from: mm,
  to: mm,
})
// a pipe bend, a round stem or a vase, drawn as it will be built where no extruded outline can be
const flatPlane = z.enum(['xy', 'xz', 'yz'])
const revolve = z.object({ kind: z.literal('revolve'), plane: flatPlane, points: outline, axis: z.object({ point: pt2, direction: pt2 }), angle: z.number().min(-360).max(360).optional() })
const sweep = z.object({
  kind: z.literal('sweep'),
  // round of diameter d with an optional bore, or an outline
  profile: z.object({ d: size.optional(), hole: size.optional(), points: outline.optional() }).refine((p) => (p.d === undefined) !== (p.points === undefined), 'give d or points'),
  path: z.array(vec).min(2).max(100),
  round: z.number().min(0).max(10_000).optional(),
})
const loft = z.object({ kind: z.literal('loft'), plane: flatPlane, sections: z.array(z.object({ at: mm, d: size.optional(), points: outline.optional() }).refine((x) => (x.d === undefined) !== (x.points === undefined), 'give d or points')).min(2).max(20) })
const solid = z.union([revolve, sweep, loft, extrude])

const dim = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  label: z.string().min(1).max(60),
  value: z.number().min(-100_000).max(100_000),
  unit: z.enum(['mm', 'deg', '%']),
  min: z.number().min(-100_000).max(100_000).optional(),
  max: z.number().min(-100_000).max(100_000).optional(),
  source: z.enum(['asked', 'lookup', 'photo', 'guess']).describe('asked: the person said it; lookup: from a page (give sourceTitle and sourceUrl); photo: measured from their photo; guess: your best guess'),
  sourceTitle: z.string().min(1).max(80).optional(),
  sourceUrl: z.url({ protocol: /^https?$/ }).optional(),
  note: z.string().max(160).optional(),
  at: at.optional(),
})

export function sheetTool(): PilotTool<never> {
  return defineTool({
    name: 'pilot.sheet',
    version: '1.1.0',
    source: 'command',
    permission: 'read',
    description:
      'Before building a part, show the person every size it is built from (width, length, height, wall, holes, clearance and so on) and wait for them to confirm or edit. Give each its best value, unit and source: asked, lookup (with the page), photo, or guess. Use it whenever a size matters and you are not sure of it. Returns the values to build with and which ones the person changed, or that they canceled (then build nothing and ask what to change), or that they set it aside by writing to you (then do what they wrote). A sheet with one row asks for one number. Every row of a sheet of several sizes needs at, where it sits on the part, so each row gets its numbered callout. For a new part give part, the part as it will be built, never boxes standing in for it: extruded outlines (a hollow wall as its outline with the inside as a hole, posts, ribs, the lid beside the base as it prints), and a revolve, sweep or loft for a round, bent or tapered body (a pipe bend is a sweep with round). For a part already built give design, its id: the sheet then draws that design as built, so part can be left out, and at is in the design\'s own coordinates, as geom.info and geom.faces read them.',
    localDescription:
      'Before building a part, show the person a sheet (title, views) with every size it is built from (dims: width, length, height, wall, holes, clearance) and wait for them to confirm or edit; use it whenever a size matters and you are unsure. Give each its best value, unit and source. Returns the values to build with and which changed, or a cancel (then build nothing, ask what to change). One row asks for one number. Several rows each need at, where it sits on the part. New part: part as built (hollow walls as outline plus hole, posts, lid beside base; revolve, sweep or loft for round, bent or tapered bodies), never stand-in boxes. Built part: design, its id, with at in its coordinates.',
    input: z
      .object({
        title: z.string().min(2).max(60),
        views: z.array(z.enum(['front', 'top', 'side', 'iso'])).min(1).max(4).default(['top', 'front', 'side', 'iso']),
        dims: z.array(dim).min(1).max(30),
        part: z.array(solid).min(1).max(40).optional(),
        design: z.string().min(1).max(80).optional().describe('The id of a design already built that this sheet changes: the drawing shows it as built, and at is in its coordinates'),
      })
      .refine((i) => new Set(i.dims.map((d) => d.key)).size === i.dims.length, 'each dimension needs its own key')
      .refine((i) => i.dims.every((d) => (d.min === undefined || d.value >= d.min) && (d.max === undefined || d.value <= d.max)), 'a value is outside its own min and max')
      .refine((i) => i.dims.every((d) => d.source !== 'lookup' || d.sourceUrl !== undefined), 'a looked-up value needs its sourceUrl'),
    args: (i) => `"${i.title}", ${i.dims.length} sizes`,
    async run(i, ctx) {
      if (!ctx.sheet) return { ok: false, summary: 'Nobody here can confirm a sheet' }
      // the person edits sizes on the drawing, so a sheet of several sizes needs the part to draw, and a place on it for
      // every row, so each row has its callout
      if (i.dims.length > 1 && !i.part?.length && !i.design) return { ok: false, summary: 'Not shown: a sheet of several sizes needs part, the part as it will be built (extruded outlines, or a revolve, sweep or loft for a round, bent or tapered body), or design, the id of the built design it changes, and at on each row, so it can draw the four views with callouts. Send it again with them.' }
      // a design that is not on the plate would show the sheet with no drawing, so mimir hears of it instead
      if (i.design && ctx.sheetDesign && !ctx.sheetDesign(i.design)) return { ok: false, summary: `Not shown: no built design ${i.design} on the plate; use the design id geom.info gives, or give part instead.` }
      const unplaced = i.dims.length > 1 ? i.dims.filter((d) => !d.at).map((d) => d.key) : []
      if (unplaced.length) return { ok: false, summary: `Not shown: every row needs at, where it sits on the part, so its callout shows on the drawing; ${unplaced.join(', ')} ${unplaced.length === 1 ? 'has' : 'have'} none. Send it again with them.` }
      const answer = await ctx.sheet({ title: i.title, views: i.views, dims: i.dims as PilotDim[], ...(i.part ? { part: i.part as PilotSheetSolid[] } : {}), ...(i.design ? { design: i.design } : {}) })
      // words written while it waited set it aside: they are the person's answer, as for a dismissed question
      if (!answer.confirmed && answer.said) {
        // sizes they had typed on the sheet before writing come along, so they are not lost
        const typed = answer.changed.map((k) => {
          const d = i.dims.find((x) => x.key === k)!
          return `${d.label} ${answer.values[k]} ${d.unit} (was ${d.value})`
        })
        const sizes = typed.length ? ` They had typed on it: ${typed.join(', ')}; keep those.` : ''
        return { ok: false, summary: `Set aside; the person wrote instead: "${answer.said}".${sizes} Build nothing from this sheet: do what they wrote, and show a new sheet if sizes still need confirming (words never confirm one).`, output: answer }
      }
      if (!answer.confirmed) return { ok: false, summary: 'Canceled; build nothing until the sizes are confirmed', output: answer }
      const n = answer.changed.length
      return { summary: n ? `Confirmed, ${n} size${n === 1 ? '' : 's'} changed` : 'Confirmed as shown', output: answer }
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
      'After building from a sheet, tie its rows to the steps they set, so editing a row later edits that step: for each row its key, the step (from 1) in the design, and how the step number follows the row (scale and offset; a symmetric extrude is half a width). Rows that shape a sketch rather than one number stay unbound; editing those asks you to build again.',
    input: z.object({
      design: z.string().min(1).max(80),
      binds: z
        .array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), step: z.number().int().min(1).max(1000), scale: z.number().min(-1000).max(1000).optional(), offset: z.number().min(-100_000).max(100_000).optional() }))
        .min(1)
        .max(30),
    }),
    args: (i) => `${i.binds.length} rows to ${i.design}`,
    async run(i, ctx) {
      if (!ctx.bindSheet?.(i.design, i.binds as PilotSheetBind[])) return { ok: false, summary: 'No sheet to bind in this conversation' }
      return { summary: `Tied ${i.binds.length} row${i.binds.length === 1 ? '' : 's'} to the design`, output: { bound: i.binds.length } }
    },
  }) as PilotTool<never>
}
