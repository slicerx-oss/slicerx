// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// pilot.ask and lookup.show: a question with fixed answers that waits for the person's pick, and a record shown as a
// card with its source. Neither changes anything; they are how mimir checks with the person and shows what it found.
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
      source: z.object({ title: z.string().min(1).max(80), url: z.url() }),
    }),
    args: (i) => `"${i.title}"`,
    async run(i) {
      return { summary: i.title, output: { shown: true }, lookup: { title: i.title, fields: i.fields, source: i.source } }
    },
  }) as PilotTool<never>
}
