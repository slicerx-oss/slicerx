// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's conversations in the app, read back over the app link: the sessions, and for one session what was said and
// what mimir did each turn (its tool calls and how they ended, its questions and the answers, what it looked up). The
// chat that keeps them registers its log here; nothing is registered until it does. Text is cut to a readable length
// and nothing else in the app is reachable from here.
import type { PilotEvent, SessionStore } from '@slicerx/contracts'
import { reduceTranscript, startTurn, emptyTranscript, type Transcript, type Turn } from '@slicerx/pilot/reduce'
import { LinkError } from './methods-error'

export interface SessionSource {
  store: SessionStore
  /** The person's messages in a session, in order; the runtime logs only its own events. */
  messages?(sessionId: string): { text: string; attachments: string[] }[]
}

let source: SessionSource | null = null

/** The chat that keeps mimir's conversations registers them; null takes them away. */
export function setSessionSource(s: SessionSource | null): void {
  source = s
}

const MAX_TEXT = 4_000
const MAX_TURNS = 50
const MAX_SESSIONS = 100

const cut = (t: string, n = MAX_TEXT): string => (t.length > n ? `${t.slice(0, n)}...` : t)

/** One turn as a client reads it. */
function compact(turn: Turn, user: { text: string; attachments: string[] } | undefined) {
  const out: Record<string, unknown>[] = []
  for (const b of turn.blocks) {
    switch (b.kind) {
      case 'say':
        out.push({ kind: 'said', text: cut(b.text) })
        break
      case 'tools':
        for (const r of b.rows) out.push({ kind: 'tool', tool: r.tool, state: r.state, ...(r.summary ? { summary: cut(r.summary, 500) } : {}) })
        break
      case 'plan':
        out.push({ kind: 'plan', steps: b.steps.map((s) => cut(s, 200)) })
        break
      case 'error':
        out.push({ kind: 'error', message: cut(b.message, 500) })
        break
      case 'summary':
        out.push({ kind: 'summary', title: b.title, rows: b.rows })
        break
      default: {
        // Kinds the chat added later (questions, lookups) keep their own fields, minus anything long.
        const { id: _id, ...rest } = b as { id: string; kind: string } & Record<string, unknown>
        if (b.kind === 'think' || b.kind === 'perm') break
        out.push(JSON.parse(JSON.stringify(rest, (_k, v: unknown) => (typeof v === 'string' ? cut(v, 1_000) : v))) as Record<string, unknown>)
      }
    }
  }
  return { ...(user ? { said: cut(user.text), ...(user.attachments.length ? { attachments: user.attachments } : {}) } : {}), steps: out }
}

/**
 * How mimir checked sizes in a session, for the dimension bench: questions it asked (choices and sheets), lookups it
 * showed, sheets confirmed, and how many sizes the person changed on them. Counted from the events, so kinds the chat
 * adds later count as they come.
 */
function statsOf(events: readonly PilotEvent[]) {
  let questions = 0
  let sheets = 0
  let lookups = 0
  let confirmed = 0
  let changed = 0
  for (const e of events as readonly { type: string; answer?: { confirmed?: boolean; changed?: string[] } }[]) {
    if (e.type === 'ask') questions++
    else if (e.type === 'sheet') sheets++
    else if (e.type === 'lookup') lookups++
    else if (e.type === 'sheet_answered') {
      if (e.answer?.confirmed) confirmed++
      changed += e.answer?.changed?.length ?? 0
    }
  }
  return { questions: questions + sheets, sheets, lookups, sheetsConfirmed: confirmed, sizesChanged: changed }
}

/** `mimir.sessions`: the conversations, newest first. */
export async function listSessions(): Promise<unknown> {
  if (!source) return { sessions: [] }
  const all = await source.store.list()
  return { sessions: [...all].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, MAX_SESSIONS).map((s) => ({ id: s.id, title: cut(s.title, 200), status: s.status, startedAt: s.startedAt, ...(s.ms !== undefined ? { ms: s.ms } : {}) })) }
}

/** `mimir.session {id}`: one conversation, turn by turn, the latest `MAX_TURNS`. */
export async function readSession(args: Record<string, unknown>): Promise<unknown> {
  const id = args['id']
  if (typeof id !== 'string' || !id || id.length > 200) throw new LinkError('invalid_input', 'id is a session id from mimir.sessions')
  if (!source || !(await source.store.list()).some((s) => s.id === id)) throw new LinkError('not_found', `no mimir session ${id}`)
  const events = await source.store.read(id)
  // Each run starts with a start event; the person's messages line up with the runs in order.
  const runs: PilotEvent[][] = []
  for (const e of events) {
    if (e.type === 'start' || runs.length === 0) runs.push([])
    runs[runs.length - 1]!.push(e)
  }
  const said = source.messages?.(id) ?? []
  const turns = runs.map((run, i) => {
    // An event this build's transcript does not know (a log from a newer chat) is skipped, not fatal.
    let tr: Transcript = startTurn(emptyTranscript(), { user: said[i]?.text ?? null }, 0)
    for (const e of run) tr = reduceTranscript(tr, e, 0) ?? tr
    const t = tr.turns.at(-1)!
    return compact(t, said[i])
  })
  return { id, stats: statsOf(events), turns: turns.slice(-MAX_TURNS), ...(turns.length > MAX_TURNS ? { earlier: turns.length - MAX_TURNS } : {}) }
}
