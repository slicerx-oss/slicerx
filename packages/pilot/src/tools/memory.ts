// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// memory.remember and memory.recall: short notes about the person (their printers, filaments, preferences, sizes and
// what worked) kept on their computer. Saving is profile class, so the app asks first unless the person turned that off
// for notes; a note that looks like a secret is refused before the card either way. Recalling is read class. The
// edition turns both off with ai.brain.memory.local.
import { z } from 'zod'
import { DATA_MAX_KEYS, DATA_NAME_MAX, DATA_VALUE_MAX, dataLabel, MEMORY_KINDS, NOTE_MAX, NOTE_MIN, NOTE_UNSAFE, oneLine, pickFacts, redactSecrets, secretInNote, type MemoryFact, type MemoryStore } from '../memory/facts'
import { defineTool, type PilotTool } from '../tool'

const REFUSED = 'Not saved: that looks like a key, token, access code or serial. Those stay in the app, never in notes.'

/** Where a note goes, as the chip says it: on this computer, and along with each chat when the chat runs on the cloud. */
export const KEPT_HERE = 'Kept on this computer for later chats.'
export const KEPT_CLOUD = 'Kept on this computer, and sent with chats to the cloud to answer them.'
const ONE_LINE = 'One line only: no line breaks or hidden characters'
const safe = (s: string): boolean => !NOTE_UNSAFE.test(s)

const rememberInput = z.object({
  kind: z.enum(MEMORY_KINDS).describe('printer, filament, preference, outcome (what worked or failed) or size (one of their own things)'),
  text: z.string().trim().min(NOTE_MIN).max(NOTE_MAX).refine(safe, ONE_LINE).describe('One short sentence in plain words, such as "Prints PETG at 240 C on the A1"'),
  data: z
    .record(z.string().max(DATA_NAME_MAX).refine(safe, ONE_LINE), z.union([z.string().max(DATA_VALUE_MAX).refine(safe, ONE_LINE), z.number()]))
    .refine((d) => Object.keys(d).length <= DATA_MAX_KEYS, `At most ${DATA_MAX_KEYS} values`)
    .optional()
    .describe('Up to 6 key values, such as { model: "A1", nozzleMm: 0.4 }'),
})

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * `ask` false saves without the card (Settings > Memory > Save notes without asking); it is read at each save. `cloud`
 * true when the chat's model runs off this computer (mimir cloud or the person's own key), so the card says the notes
 * go along with chats; read at each save.
 */
export function memoryTools(store: MemoryStore, now: () => number = () => Date.now(), ask: () => boolean = () => true, cloud: () => boolean = () => false): PilotTool<never>[] {
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
    shownInput: (i) => ({ kind: i.kind, text: redactSecrets(i.text).text, ...(i.data ? { data: secretInNote(i) ? '[withheld]' : i.data } : {}) }),
    withoutAsking: () => (ask() ? null : 'Saving without asking, as set in Settings.'),
    async approval(i) {
      if (secretInNote(i)) throw new Error(REFUSED)
      // everything that is saved and read back later is on the card, the data too
      const data = Object.entries(i.data ?? {}).map(([k, v]) => dataLabel(k, v))
      return { title: 'Remember this?', lines: [i.text, ...data, cloud() ? KEPT_CLOUD : KEPT_HERE], actions: [] }
    },
    async run(i, ctx) {
      if (!ctx.token) return { ok: false, summary: 'Not approved' }
      if (secretInNote(i)) return { ok: false, summary: REFUSED }
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
      // each note on one line, whatever the store holds (a synced note was never checked by this tool), and read back
      // as data like any other text from outside
      const facts = pickFacts(await store.list(), i.query).map((f) => ({ ...f, text: oneLine(f.text), ...(f.data ? { data: Object.fromEntries(Object.entries(f.data).map(([k, v]) => [oneLine(k), typeof v === 'number' ? v : oneLine(v)])) } : {}) }))
      return { summary: `${facts.length} note${facts.length === 1 ? '' : 's'}`, output: facts, untrusted: true }
    },
  })

  return [remember as PilotTool<never>, recall as PilotTool<never>]
}
