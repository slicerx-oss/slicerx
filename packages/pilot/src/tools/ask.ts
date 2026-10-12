// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// pilot.ask, pilot.sheet and lookup.show: a question with fixed answers that waits for the person's pick, a sheet of
// the sizes a part is built from that waits for the person to confirm or edit them, and a record shown as a card with
// its source. None changes anything; they are how mimir checks with the person and shows what it found.
import type { PilotDim, PilotSheetBind } from '@slicerx/contracts'
import { z } from 'zod'
import { defineTool, type PilotTool } from '../tool'

export function askTool(): PilotTool<never> {
  return defineTool({
    name: 'pilot.ask',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'Ask the person a short question with two to four fixed answers and wait for the pick. Use it to confirm something before building on it, such as which model a photo shows. Returns the picked choice id.',
    input: z.object({
      title: z.string().min(2).max(40),
      question: z.string().min(3).max(160),
      choices: z.array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(40) })).min(2).max(4),
    }),
    args: (i) => `"${i.question}"`,
    async run(i, ctx) {
      if (!ctx.ask) return { ok: false, summary: 'Nobody here can answer a question' }
      const picked = await ctx.ask({ title: i.title, question: i.question, choices: i.choices })
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
})

export function sheetTool(): PilotTool<never> {
  return defineTool({
    name: 'pilot.sheet',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      'Before building a part, show the person every size it is built from (width, length, height, wall, holes, clearance and so on) and wait for them to confirm or edit. Give each its best value, unit and source: asked, lookup (with the page), photo, or guess. Use it whenever a size matters and you are not sure of it. Returns the values to build with and which ones the person changed. A sheet with one row asks for one number.',
    input: z
      .object({
        title: z.string().min(2).max(60),
        views: z.array(z.enum(['front', 'top', 'side', 'iso'])).min(1).max(4).default(['iso']),
        dims: z.array(dim).min(1).max(30),
      })
      .refine((i) => new Set(i.dims.map((d) => d.key)).size === i.dims.length, 'each dimension needs its own key')
      .refine((i) => i.dims.every((d) => (d.min === undefined || d.value >= d.min) && (d.max === undefined || d.value <= d.max)), 'a value is outside its own min and max')
      .refine((i) => i.dims.every((d) => d.source !== 'lookup' || d.sourceUrl !== undefined), 'a looked-up value needs its sourceUrl'),
    args: (i) => `"${i.title}", ${i.dims.length} sizes`,
    async run(i, ctx) {
      if (!ctx.sheet) return { ok: false, summary: 'Nobody here can confirm a sheet' }
      const answer = await ctx.sheet({ title: i.title, views: i.views, dims: i.dims as PilotDim[] })
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
