// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// memory.remember and memory.recall: short notes about the person (their printers, filaments, preferences, sizes and
// what worked) kept on their computer. Saving is profile class, so the app asks first; a note that looks like a
// secret is refused before the card. Recalling is read class. The edition turns both off with ai.brain.memory.local.
import { z } from 'zod'
import { MEMORY_KINDS, NOTE_UNSAFE, pickFacts, redactSecrets, type MemoryFact, type MemoryStore } from '../memory/facts'
import { defineTool, type PilotTool } from '../tool'

const REFUSED = 'Not saved: that looks like a key, token, access code or serial. Those stay in the app, never in notes.'

const MAX_DATA_KEYS = 6
const ONE_LINE = 'One line only: no line breaks or hidden characters'
const safe = (s: string): boolean => !NOTE_UNSAFE.test(s)

const rememberInput = z.object({
  kind: z.enum(MEMORY_KINDS).describe('printer, filament, preference, outcome (what worked or failed) or size (one of their own things)'),
  text: z.string().trim().min(3).max(240).refine(safe, ONE_LINE).describe('One short sentence in plain words, such as "Prints PETG at 240 C on the A1"'),
  data: z
    .record(z.string().max(40).refine(safe, ONE_LINE), z.union([z.string().max(80).refine(safe, ONE_LINE), z.number()]))
    .refine((d) => Object.keys(d).length <= MAX_DATA_KEYS, `At most ${MAX_DATA_KEYS} values`)
    .optional()
    .describe('Up to 6 key values, such as { model: "A1", nozzleMm: 0.4 }'),
})

type RememberInput = z.infer<typeof rememberInput>

// "accessCode" read as "access Code", so a name-and-value pattern sees the name
const spaced = (k: string): string => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')

/** Whether any part of the note looks like a secret: the text, each data key and value, and each key with its value. */
function secretIn(i: RememberInput): boolean {
  const parts = [i.text]
  for (const [k, v] of Object.entries(i.data ?? {})) parts.push(k, String(v), `${k}: ${v}`, `${spaced(k)}: ${v}`)
  return parts.some((s) => redactSecrets(s).refused)
}

/** A data key as a plain label for the card: nozzleMm becomes "Nozzle mm". */
function label(k: string): string {
  const words = spaced(k).trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
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
    // the row and the session log never echo a refused secret: the text with secrets cut out, and no data
    args: (i) => `${i.kind} "${redactSecrets(i.text).text}"`,
    shownInput: (i) => ({ kind: i.kind, text: redactSecrets(i.text).text, ...(i.data ? { data: secretIn(i) ? '[withheld]' : i.data } : {}) }),
    async approval(i) {
      if (secretIn(i)) throw new Error(REFUSED)
      // everything that is saved and read back later is on the card, the data too
      const data = Object.entries(i.data ?? {}).map(([k, v]) => `${label(k)}: ${v}`)
      return { title: 'Remember this?', lines: [i.text, ...data, 'Kept on this computer for later chats.'], actions: [] }
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
      // the notes are the person's own words, read back as data like any other text from outside
      return { summary: `${facts.length} note${facts.length === 1 ? '' : 's'}`, output: facts, untrusted: true }
    },
  })

  return [remember as PilotTool<never>, recall as PilotTool<never>]
}
