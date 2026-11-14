// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The dimension sheet the view shows. The chat writes the conversation's latest sheet here, with what answering it
// does; the view turns into the drawing and its sizes panel while the sheet waits, and after the build the panel
// comes back on request, where editing a tied row edits its step.
import type { Pilot, PilotSheet, PilotSheetAnswer, PilotSheetBind } from '@slicerx/contracts'
import { createStore, useStore } from 'zustand'

export interface ShownSheet {
  sheet: PilotSheet
  answer: PilotSheetAnswer | null
  bound: { design: string; binds: PilotSheetBind[] } | null
  /** From a saved conversation: shown, never answered. */
  replay: boolean
}

export interface SheetActions {
  confirm(sheetId: string, values: Record<string, number>): Promise<void>
  cancel(sheetId: string): Promise<void>
  /** Edits the steps a built sheet's row is tied to; `before` is the row's size before the edit, which a kept but broken edit is put back to, and `value` is what the row shows after a failed edit when that is not `before`. */
  drive(bound: { design: string; binds: PilotSheetBind[] }, key: string, value: number, before?: number): Promise<{ ok: boolean; summary: string; detail?: string; value?: number }>
}

export interface SheetUiState {
  shown: ShownSheet | null
  /** The panel is up after the build (the person asked for it). */
  open: boolean
  /** The values a built sheet's rows hold now, after edits in the panel. */
  live: Record<string, number>
  /** The sizes typed on the waiting sheet, in the panel or on its record in the chat. */
  draft: Record<string, number>
  actions: SheetActions | null
}

export const sheetUi = createStore<SheetUiState>()(() => ({ shown: null, open: false, live: {}, draft: {}, actions: null }))

/** How the view shows the sheet: the drawing and panel while it waits, the panel alone after the build, or not at all. */
export type SheetMode = 'confirm' | 'drive' | null

export function sheetMode(s: SheetUiState): SheetMode {
  const shown = s.shown
  if (!shown || shown.replay) return null
  if (!shown.answer) return 'confirm'
  return s.open && shown.answer.confirmed && shown.bound ? 'drive' : null
}

/** The chat's latest sheet; a new sheet closes the panel and starts its values over. */
export function setShownSheet(shown: ShownSheet | null): void {
  const s = sheetUi.getState()
  const same = s.shown?.sheet.id === shown?.sheet.id
  if (same && s.shown?.answer === shown?.answer && s.shown?.bound === shown?.bound) return
  const values = shown?.answer?.confirmed ? shown.answer.values : {}
  sheetUi.setState({ shown, ...(same ? {} : { open: false, live: values, draft: {} }), ...(same && !s.shown?.answer && shown?.answer ? { live: values } : {}) })
}

/**
 * The waiting sheet's values with the sizes typed on it, for setting it aside with words: the typed sizes go along so
 * mimir hears of them. Null when nothing was typed, or no sheet waits, or the view shows another sheet than `sheetId`.
 */
export function typedValues(s: SheetUiState, sheetId?: string): Record<string, number> | null {
  if (sheetMode(s) !== 'confirm' || !s.shown || (sheetId !== undefined && s.shown.sheet.id !== sheetId)) return null
  const keys = new Set(s.shown.sheet.dims.map((d) => d.key))
  const typed = Object.entries(s.draft).filter(([k, v]) => keys.has(k) && s.shown!.sheet.dims.find((d) => d.key === k)!.value !== v)
  return typed.length ? { ...Object.fromEntries(s.shown.sheet.dims.map((d) => [d.key, d.value])), ...Object.fromEntries(typed) } : null
}

/**
 * Sets the waiting sheet aside for `said` with the sizes typed on it, as Return in the message box and a client's
 * mimir.dismiss both do; with no words it is canceled.
 */
export function setSheetAside(pilot: Pick<Pilot, 'answerSheet'>, sheetId: string, said?: string): Promise<void> {
  return pilot.answerSheet?.(sheetId, said ? typedValues(sheetUi.getState(), sheetId) : null, said) ?? Promise.reject(new Error('No sheet here'))
}

export function setSheetActions(actions: SheetActions | null): void {
  sheetUi.setState({ actions })
}

/** The sheet whose record's Edit sizes opened the panel, for handing focus back when it closes. */
let openedFrom: string | null = null

/** Brings the panel up for a sheet in the conversation (its record's button). */
export function openSheet(sheetId: string): void {
  const s = sheetUi.getState()
  if (s.shown?.sheet.id !== sheetId) return
  openedFrom = sheetId
  sheetUi.setState({ open: true })
  // to its first field, once the panel is up
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="mimir-sheet-panel"] input:not([disabled])')?.focus())
}

/** Puts the panel away (Done, or Escape inside it) and hands focus back to the Edit sizes that opened it. */
export function closeSheet(): void {
  const from = openedFrom
  openedFrom = null
  sheetUi.setState({ open: false })
  if (!from) return
  // once the panel is gone and the record shows again; the conversation stays where it was
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="mimir-sheet-record"][data-sheet-id="${CSS.escape(from)}"] [data-testid="mimir-sheet-open"]`)?.focus({ preventScroll: true }))
}

export function setLive(key: string, value: number): void {
  sheetUi.setState((s) => ({ live: { ...s.live, [key]: value } }))
}

/** A size typed on the waiting sheet. */
export function setDraft(key: string, value: number): void {
  sheetUi.setState((s) => ({ draft: { ...s.draft, [key]: value } }))
}

export function useSheetUi<T>(pick: (s: SheetUiState) => T): T {
  return useStore(sheetUi, pick)
}
