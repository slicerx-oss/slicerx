// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client turning down the question mimir waits on: mimir.dismiss answers the open question card with no pick, so
// mimir's run carries on (with what the client wrote, when it wrote something) instead of waiting for a person to walk
// over. A size sheet waiting instead, named by its sheetId, is set aside the way Return in the message box does it: mimir reads the words in
// its place, with any sizes the person had typed on it, and builds nothing from it (with no words it is canceled). It
// never picks an answer or confirms a sheet, and never stops the run. The chat registers its cards here while it is
// open; a call that names a question or sheet no longer open is refused, so a late call cannot turn down the next one.
import { ASK_SAID_MAX } from '@slicerx/pilot'
import { LinkError } from './methods-error'

export interface MimirCards {
  /** The chat's session. */
  sessionId(): string
  /** The question card waiting in the chat now, newest first; null when none waits. */
  open(): { askId: string; title: string; question: string } | null
  /** Turns the question down with no pick; `said` is what goes to mimir in its place. */
  dismiss(askId: string, said?: string): Promise<void>
  /** The size sheet waiting in the chat now, or null. */
  sheet?(): { sheetId: string; title: string } | null
  /** Sets the sheet aside for `said` (with the sizes typed on it), or cancels it with no words. */
  setAside?(sheetId: string, said?: string): Promise<void>
}

let cards: MimirCards | null = null

/** The chat whose question cards clients may turn down registers here; null takes it away. */
export function setMimirCards(c: MimirCards | null): void {
  cards = c
}

/**
 * `mimir.dismiss {askId?, sheetId?, said?}`: turns down the open question, or sets aside the size sheet waiting; answers
 * with the session and the question's or sheet's id.
 */
export async function dismissCard(args: Record<string, unknown>): Promise<unknown> {
  const askId = args['askId']
  const sheetId = args['sheetId']
  const said = args['said']
  if (askId !== undefined && (typeof askId !== 'string' || !askId || askId.length > 200)) throw new LinkError('invalid_input', 'askId is the id of the waiting question, from mimir.session (waiting.askId)')
  if (sheetId !== undefined && (typeof sheetId !== 'string' || !sheetId || sheetId.length > 200)) throw new LinkError('invalid_input', 'sheetId is the id of the waiting size sheet, from mimir.session (waiting.sheetId)')
  if (said !== undefined && (typeof said !== 'string' || said.length > ASK_SAID_MAX)) throw new LinkError('invalid_input', `said is text of at most ${ASK_SAID_MAX} characters`)
  if (!cards) throw new LinkError('not_ready', 'the mimir tab is not open in the app, or no model is connected to it yet; ask the person to open it')
  const open = askId === undefined && sheetId !== undefined ? null : cards.open()
  if (!open) {
    // no question: the size sheet waiting, set aside as Return in the message box sets it aside, only when the call
    // names it; a call with no ids (a 1.0 client) never touches a sheet
    const sheet = askId === undefined && sheetId !== undefined ? (cards.sheet?.() ?? null) : null
    if (!sheet || !cards.setAside) throw new LinkError('not_found', askId === undefined ? 'mimir is not waiting on a question or a size sheet' : `question ${askId} is no longer waiting; read mimir.session for the one that is`)
    if (sheetId !== undefined && sheetId !== sheet.sheetId) throw new LinkError('not_found', `sheet ${sheetId} is no longer waiting; read mimir.session for the one that is`)
    const words = typeof said === 'string' ? said.trim() : ''
    try {
      await cards.setAside(sheet.sheetId, words || undefined)
    } catch {
      throw new LinkError('not_found', `sheet ${sheet.sheetId} is no longer waiting; read mimir.session for the one that is`)
    }
    return { sessionId: cards.sessionId(), sheetId: sheet.sheetId, ...(words ? { setAside: true, said: words } : { canceled: true }) }
  }
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
