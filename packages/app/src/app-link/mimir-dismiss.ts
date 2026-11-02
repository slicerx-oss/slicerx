// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client turning down the question mimir waits on: mimir.dismiss answers the open question card with no pick, so
// mimir's run carries on (with what the client wrote, when it wrote something) instead of waiting for a person to walk
// over. It never picks an answer and never stops the run. The chat registers its cards here while it is open; a call
// that names a question no longer open is refused, so a late call cannot turn down the next one.
import { ASK_SAID_MAX } from '@slicerx/pilot'
import { LinkError } from './methods-error'

export interface MimirCards {
  /** The chat's session. */
  sessionId(): string
  /** The question card waiting in the chat now, newest first; null when none waits. */
  open(): { askId: string; title: string; question: string } | null
  /** Turns the question down with no pick; `said` is what goes to mimir in its place. */
  dismiss(askId: string, said?: string): Promise<void>
}

let cards: MimirCards | null = null

/** The chat whose question cards clients may turn down registers here; null takes it away. */
export function setMimirCards(c: MimirCards | null): void {
  cards = c
}

/** `mimir.dismiss {askId?, said?}`: turns down the open question; answers with the session and the question's id. */
export async function dismissCard(args: Record<string, unknown>): Promise<unknown> {
  const askId = args['askId']
  const said = args['said']
  if (askId !== undefined && (typeof askId !== 'string' || !askId || askId.length > 200)) throw new LinkError('invalid_input', 'askId is the id of the waiting question, from mimir.session (waiting.askId)')
  if (said !== undefined && (typeof said !== 'string' || said.length > ASK_SAID_MAX)) throw new LinkError('invalid_input', `said is text of at most ${ASK_SAID_MAX} characters`)
  if (!cards) throw new LinkError('not_ready', 'the mimir tab is not open in the app, or no model is connected to it yet; ask the person to open it')
  const open = cards.open()
  if (!open) throw new LinkError('not_found', 'mimir is not waiting on a question')
  if (askId !== undefined && askId !== open.askId) throw new LinkError('not_found', `question ${askId} is no longer waiting; read mimir.session for the one that is`)
  const words = typeof said === 'string' ? said.trim() : ''
  try {
    await cards.dismiss(open.askId, words || undefined)
  } catch {
    // answered or canceled in the meantime
    throw new LinkError('not_found', `question ${open.askId} is no longer waiting; read mimir.session for the one that is`)
  }
  return { sessionId: cards.sessionId(), askId: open.askId, dismissed: true, ...(words ? { said: words } : {}) }
}
