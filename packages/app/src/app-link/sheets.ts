// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client's dimension sheet over the app link: sheet.ask puts the sizes a part is built from in front of the person,
// the same sheet mimir shows, and answers at once with its id; sheet.get reads back whether the person confirmed it
// (and the values they left) or declined it. Only the client that asked can read its sheet. One sheet at a time per
// client, three waiting at most, so no client can stack questions on the person.
import type { PilotSheet, PilotSheetAnswer } from '@slicerx/contracts'
import { createStore, useStore } from 'zustand'
import { LinkError } from './methods-error'

export interface ClientSheet {
  sheet: PilotSheet
  client: { id: string; name: string }
  state: 'waiting' | 'confirmed' | 'declined'
  answer?: PilotSheetAnswer
}

const MAX_WAITING = 3
let seq = 0

/** Sheets clients asked, oldest first; answered ones stay so their client can read them back. */
export const clientSheets = createStore<{ sheets: ClientSheet[] }>()(() => ({ sheets: [] }))

export function useWaitingSheets(): ClientSheet[] {
  return useStore(clientSheets, (s) => s.sheets).filter((x) => x.state === 'waiting')
}

export async function askSheet(args: Record<string, unknown>, client: { id: string; name: string }): Promise<unknown> {
  // the same checks mimir's own sheet gets: keys, bounds, a page for each looked-up value
  const { sheetTool } = await import('@slicerx/pilot')
  const parsed = sheetTool().input.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.issues.map((i) => `${i.path.join('.') || 'sheet'}: ${i.message}`).join('; '))
  const all = clientSheets.getState().sheets
  if (all.some((x) => x.state === 'waiting' && x.client.id === client.id)) throw new LinkError('busy', 'this client already has a sheet waiting for the person; read it back with sheet.get')
  if (all.filter((x) => x.state === 'waiting').length >= MAX_WAITING) throw new LinkError('busy', 'the person has sheets waiting already; try again after they answer')
  const data = parsed.data as unknown as Omit<PilotSheet, 'id'>
  const sheet: PilotSheet = { id: `csheet_${Date.now().toString(36)}${(++seq).toString(36)}`, title: data.title, views: data.views, dims: data.dims, ...(data.part ? { part: data.part } : {}) }
  // A client's answered sheets go once it asks again; the newest is the one it reads.
  clientSheets.setState((s) => ({ sheets: [...s.sheets.filter((x) => x.client.id !== client.id || x.state === 'waiting'), { sheet, client, state: 'waiting' }] }))
  return { sheetId: sheet.id, state: 'waiting' }
}

export function getSheet(args: Record<string, unknown>, client: { id: string; name: string }): unknown {
  const id = args['sheetId']
  const found = clientSheets.getState().sheets.find((x) => x.sheet.id === id && x.client.id === client.id)
  if (!found) throw new LinkError('not_found', 'no sheet with that id from this client; ask with sheet.ask')
  return { sheetId: found.sheet.id, state: found.state, ...(found.answer ? { answer: found.answer } : {}) }
}

/** The person's answer from the app: confirm with values (kept in bounds), or decline. */
export async function answerClientSheet(sheetId: string, values: Record<string, number> | null): Promise<void> {
  const { answerOf } = await import('@slicerx/pilot')
  clientSheets.setState((s) => ({
    sheets: s.sheets.map((x) => (x.sheet.id !== sheetId || x.state !== 'waiting' ? x : values ? { ...x, state: 'confirmed', answer: answerOf(x.sheet, values) } : { ...x, state: 'declined' })),
  }))
}
