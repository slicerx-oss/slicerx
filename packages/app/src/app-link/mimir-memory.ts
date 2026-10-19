// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's memory over the app link: mimir.memory reads what it keeps about the person (printers, filaments,
// preferences, what worked, sizes), with secrets hidden before anything leaves the app, and mimir.memory_remember adds
// one fact for a client the person allowed to change things. The memory store registers itself here; without one,
// both answer that memory is unavailable.
import { MEMORY_KINDS, NOTE_MAX, NOTE_MIN, noteProblem, redactSecrets, SECRET_DATA_KEY, secretInNote, type MemoryFact, type MemoryKind } from '@slicerx/pilot'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { appName } from '../edition'
import { LinkError } from './methods-error'

export { MEMORY_KINDS, type MemoryFact, type MemoryKind }
export type MemoryData = Record<string, string | number>

/** What a hidden secret reads as. */
export const HIDDEN = '[hidden]'
const hide = (text: string) => redactSecrets(text, HIDDEN)

/** The memory store, as the link reads and adds to it. */
export interface MemoryProvider {
  /** Every fact, or only those of one kind. */
  list(kind?: MemoryKind): Promise<MemoryFact[]>
  /** Keeps a new fact and answers with it as stored. */
  remember(fact: { kind: MemoryKind; text: string; data?: MemoryData }): Promise<MemoryFact>
}

let provider: MemoryProvider | null = null

/** The memory store registers here; null takes it away. */
export function setMemoryProvider(p: MemoryProvider | null): void {
  provider = p
}

// The limits the in-app save (memory.remember) and Settings > Memory use: a note of NOTE_MIN to NOTE_MAX characters on
// one line, and at most 6 data entries, each name up to 40 characters and each text value up to 80, all on one line.
const MAX_DATA = 6
const MAX_NAME = 40
const MAX_VALUE = 80
/** True when `s` has a line break or a hidden character (noteProblem's first check). */
const unsafe = (s: string): boolean => noteProblem(s) === 'one-line'

function store(): MemoryProvider {
  if (!provider) throw new LinkError('not_ready', `memory unavailable: ${ASSISTANT_NAME} keeps no memory in this ${appName()} window, or it is turned off`)
  return provider
}

function only(args: Record<string, unknown>, keys: string[], method: string): void {
  const extra = Object.keys(args).filter((k) => !keys.includes(k))
  if (extra.length) throw new LinkError('invalid_input', `${method} takes ${keys.join(', ')} only, not ${extra.join(', ')}`)
}

function kindArg(v: unknown, required: boolean): MemoryKind | undefined {
  if (v === undefined && !required) return undefined
  if (typeof v !== 'string' || !(MEMORY_KINDS as readonly string[]).includes(v)) throw new LinkError('invalid_input', `kind is one of ${MEMORY_KINDS.join(', ')}`)
  return v as MemoryKind
}

/** A fact as it may leave the app: secrets in its text and data hidden, and a data name that is a secret hidden with its value. */
function shown(f: MemoryFact): { fact: MemoryFact; hid: boolean } {
  const text = hide(f.text)
  let hid = text.refused
  const fact: MemoryFact = { id: f.id, kind: f.kind, text: text.text, updatedAt: f.updatedAt }
  if (f.data) {
    let named = 0
    fact.data = Object.fromEntries(
      Object.entries(f.data).map(([k, v]) => {
        if (redactSecrets(k).refused) {
          hid = true
          named++
          return [`${HIDDEN} ${named}`, HIDDEN]
        }
        if (SECRET_DATA_KEY.test(k)) {
          hid = true
          return [k, HIDDEN]
        }
        if (typeof v !== 'string') return [k, v]
        const r = hide(v)
        hid ||= r.refused
        return [k, r.text]
      }),
    )
  }
  return { fact, hid }
}

/** mimir.memory: the facts, newest first, optionally of one `kind`; `hidden` counts the facts that had a secret hidden. */
export async function readMemory(args: Record<string, unknown>) {
  only(args, ['kind'], 'mimir.memory')
  const kind = kindArg(args['kind'], false)
  const all = await store().list(kind)
  const facts: MemoryFact[] = []
  let hidden = 0
  for (const f of [...all].filter((f) => kind === undefined || f.kind === kind).sort((a, b) => b.updatedAt - a.updatedAt)) {
    const s = shown(f)
    if (s.hid) hidden++
    facts.push(s.fact)
  }
  return { facts, hidden }
}

function dataArg(v: unknown): MemoryData | undefined {
  if (v === undefined) return undefined
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new LinkError('invalid_input', 'data is an object of names to text or numbers')
  const entries = Object.entries(v)
  if (entries.length > MAX_DATA) throw new LinkError('invalid_input', `data has at most ${MAX_DATA} entries`)
  // Refusals name an entry by its position, never by its name, which may be a secret.
  for (const [n, [k, x]] of entries.entries()) {
    if (!k.trim() || k.length > MAX_NAME || unsafe(k)) throw new LinkError('invalid_input', `data entry ${n + 1} needs a name of 1 to ${MAX_NAME} characters on one line`)
    if (typeof x === 'number' ? !Number.isFinite(x) : typeof x !== 'string' || x.length > MAX_VALUE || unsafe(x)) {
      throw new LinkError('invalid_input', `data entry ${n + 1} is text of at most ${MAX_VALUE} characters on one line, or a number`)
    }
  }
  return v as MemoryData
}

/** mimir.memory_remember: keeps `{ kind, text, data? }`. Refused when it carries a secret; the answer is the fact read back. */
export async function rememberFact(args: Record<string, unknown>) {
  only(args, ['kind', 'text', 'data'], 'mimir.memory_remember')
  const kind = kindArg(args['kind'], true)!
  const raw = args['text']
  const text = typeof raw === 'string' ? raw.trim() : ''
  // the checks the in-app save makes (noteProblem): one line with no hidden characters, then the length; a secret is refused below
  const problem = noteProblem(text)
  if (problem === 'one-line') throw new LinkError('invalid_input', 'text is one line: no line breaks or hidden characters')
  if (problem === 'short' || problem === 'long') throw new LinkError('invalid_input', `text is ${NOTE_MIN} to ${NOTE_MAX} characters`)
  const data = dataArg(args['data'])
  const secret = secretInNote({ text, ...(data ? { data } : {}) })
  if (secret) throw new LinkError('refused', `${ASSISTANT_NAME} does not keep secrets: this looks like a key, an access code or a serial number. Leave it out and try again.`)
  const fact = await store().remember({ kind, text, ...(data ? { data } : {}) })
  return { fact: shown(fact).fact }
}
