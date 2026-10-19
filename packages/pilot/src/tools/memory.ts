// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// memory.remember and memory.recall: short notes about the person (their printers, filaments, preferences, sizes and
// what worked) kept on their computer. Saving is profile class, so the app asks first; a note that looks like a
// secret is refused before the card. Recalling is read class. The edition turns both off with ai.brain.memory.local.
import { z } from 'zod'
import { MEMORY_KINDS, pickFacts, redactSecrets, type MemoryFact, type MemoryStore } from '../memory/facts'
import { defineTool, type PilotTool } from '../tool'

const REFUSED = 'Not saved: that looks like a key, token, access code or serial. Those stay in the app, never in notes.'

const rememberInput = z.object({
  kind: z.enum(MEMORY_KINDS).describe('printer, filament, preference, outcome (what worked or failed) or size (one of their own things)'),
  text: z.string().trim().min(3).max(240).describe('One short sentence in plain words, such as "Prints PETG at 240 C on the A1"'),
  data: z.record(z.string().max(40), z.union([z.string().max(80), z.number()])).optional().describe('A few key values, such as { model: "A1", nozzleMm: 0.4 }'),
})

type RememberInput = z.infer<typeof rememberInput>

function secretIn(i: RememberInput): boolean {
  return [i.text, ...Object.values(i.data ?? {}).map(String)].some((s) => redactSecrets(s).refused)
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

export function memoryTools(store: MemoryStore, now: () => number = () => Date.now()): PilotTool<never>[] {
  const remember = defineTool({
    name: 'memory.remember',
    version: '1.0.0',
    source: 'command',
    permission: 'profile',
    title: 'Remember a note',
    description: 'Save one short note about the person for later chats: a printer or filament they have, a preference, a size of their own things, or what worked. Only what they said or confirmed. Never a key, token, access code or serial. The app asks before saving.',
    input: rememberInput,
    args: (i) => `${i.kind} "${i.text}"`,
    async approval(i) {
      if (secretIn(i)) throw new Error(REFUSED)
      return { title: 'Remember this?', lines: [i.text, 'Kept on this computer for later chats.'], actions: [] }
    },
    async run(i, ctx) {
      if (!ctx.token) return { ok: false, summary: 'Not approved' }
      if (secretIn(i)) return { ok: false, summary: REFUSED }
      const old = (await store.list()).find((f) => f.kind === i.kind && same(f.text, i.text))
      const f: MemoryFact = { id: old?.id ?? `mem_${globalThis.crypto.randomUUID()}`, kind: i.kind, text: i.text, updatedAt: now(), ...(i.data ? { data: i.data } : {}) }
      await store.put(f)
      return { summary: `Remembered: ${i.text}`, output: { id: f.id } }
    },
  })

  const recall = defineTool({
    name: 'memory.recall',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    title: 'Recall notes',
    description: "Look up the person's saved notes (printers, filaments, preferences, sizes, what worked) that match a question. Notes are their own words; the app's current machine and tool results win where they differ.",
    input: z.object({ query: z.string().min(1).max(200) }),
    args: (i) => `"${i.query}"`,
    async run(i) {
      const facts = pickFacts(await store.list(), i.query)
      return { summary: `${facts.length} note${facts.length === 1 ? '' : 's'}`, output: facts }
    },
  })

  return [remember as PilotTool<never>, recall as PilotTool<never>]
}
