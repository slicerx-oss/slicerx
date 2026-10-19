// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's memory of the person, read and added to over the app link (`mimir.memory`, `mimir.memory_remember`): their
// printers, filaments, preferences, what worked and the sizes that matter to them. The facts stay in the app, which
// hides secrets before a fact leaves it and refuses to keep one; this server keeps no copy. Adding a fact is an edit on
// the link, so a client the person allowed to read only is refused there.
import { assistantText } from '@slicerx/contracts'
import { defineTool, MEMORY_KINDS, noteProblem, type MemoryFact, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import type { AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

// One fact as the app answers it, with secrets already hidden: the memory store's own shape (@slicerx/pilot).
export { MEMORY_KINDS, type MemoryFact }

const OFF = ['app_link_off', 'app_closed', 'forbidden', 'unauthorized']
const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', refused: 'invalid_input', not_found: 'not_supported', not_ready: 'not_configured', busy: 'busy', read_only: 'not_supported', denied: 'not_supported' }

async function call<T>(link: AppLinkCaller | undefined, appName: string, method: string, args: Record<string, unknown>): Promise<T> {
  if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (start this server with --printers link).`, 'not_configured')
  try {
    return await link.call<T>(method, args)
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? '')
    const message = e instanceof Error ? e.message : String(e)
    if (OFF.includes(code)) throw new ToolInputError(`${appName} is closed, its app link is off, or this client is not allowed on it.`, 'not_configured', { appLink: code })
    throw new ToolInputError(message, CODES[code] ?? 'service_error', code ? { appLink: code } : undefined)
  }
}

/** Checks the data entries; a refusal names an entry by its position, never by its name, which may be a secret. */
// The app's limits for a note, as its own save takes one: 3 to 240 characters on one line, and at most 6 data
// entries, each name up to 40 characters and each text value up to 80, on one line.
const unsafe = (s: string): boolean => noteProblem(s) === 'one-line'
function checkData(d: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const entries = Object.entries(d)
  if (entries.length > 6) ctx.addIssue({ code: 'custom', message: 'data has at most 6 entries' })
  entries.forEach(([k, v], n) => {
    if (!k.trim() || k.length > 40 || unsafe(k)) ctx.addIssue({ code: 'custom', message: `data entry ${n + 1} needs a name of 1 to 40 characters on one line` })
    else if (typeof v === 'number' ? !Number.isFinite(v) : typeof v !== 'string' || v.length > 80 || unsafe(v)) ctx.addIssue({ code: 'custom', message: `data entry ${n + 1} is text of at most 80 characters on one line, or a number` })
  })
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

export function mimirMemoryTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const read = defineTool({
    name: 'mimir.memory',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: assistantText(`Read what mimir remembers about the person in ${appName}: their printers, filaments, preferences, outcomes (what worked) and sizes, newest first, each with its kind, text, optional data and when it changed. Access codes, serial numbers and keys are hidden before a fact leaves the app; hidden counts the facts that had one. Reads through the app link; the app must be open with the link on.`),
    input: z.object({ kind: z.enum(MEMORY_KINDS).optional().describe('Only facts of this kind; all of them when left out') }),
    async run(i) {
      const out = await call<{ facts: MemoryFact[]; hidden: number }>(link, appName, 'mimir.memory', i.kind ? { kind: i.kind } : {})
      const n = out.facts.length
      const hidden = out.hidden ? `; a secret was hidden in ${plural(out.hidden, 'fact')}` : ''
      return { summary: assistantText(n ? `mimir remembers ${plural(n, i.kind ? `${i.kind} fact` : 'fact')} in ${appName}${hidden}.` : `mimir remembers no ${i.kind ? `${i.kind} facts` : 'facts'} in ${appName} yet.`), output: out }
    },
  })
  const remember = defineTool({
    name: 'mimir.memory_remember',
    version: '1.0.0',
    source: 'command',
    // Like a saved profile change in the app: the person's policy can make it ask first.
    permission: 'profile',
    description: assistantText(`Add one fact to mimir's memory in ${appName}, such as the person's printer and nozzle, a filament they use, a preference, what worked for a print, or a size that matters to them. A fact with an access code, a serial number or a key is refused. It changes what mimir knows, so the app link asks the person for this client once and a client allowed to read only is refused. Answers with the fact as kept.`),
    input: z.object({
      kind: z.enum(MEMORY_KINDS).describe('printer, filament, preference, outcome (what worked) or size'),
      text: z.string().trim().min(3).max(240).refine((t) => !unsafe(t), 'text is one line: no line breaks or hidden characters').describe('The fact in plain words on one line, 3 to 240 characters, for example "Prints PETG at 240 C on the textured plate"'),
      data: z.record(z.string(), z.unknown()).superRefine(checkData).optional().describe('Values that go with the fact, up to 6, each text of at most 80 characters or a number, for example { "nozzleMm": 0.4 }'),
    }),
    async run(i) {
      const out = await call<{ fact: MemoryFact }>(link, appName, 'mimir.memory_remember', { kind: i.kind, text: i.text, ...(i.data ? { data: i.data as Record<string, string | number> } : {}) })
      return { summary: assistantText(`mimir will remember this ${out.fact.kind} fact in ${appName}: ${out.fact.text}`), output: out }
    },
  })
  return [read, remember] as PilotTool<never>[]
}
