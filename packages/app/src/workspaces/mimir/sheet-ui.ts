// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The dimension sheet the view shows. The chat writes the conversation's latest sheet here, with what answering it
// does; the view turns into the drawing and its sizes panel while the sheet waits, and after the build the panel
// comes back on request, where editing a tied row edits its step.
import type { PilotSheet, PilotSheetAnswer, PilotSheetBind } from '@slicerx/contracts'
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
  /** Edits the steps a built sheet's row is tied to. */
  drive(bound: { design: string; binds: PilotSheetBind[] }, key: string, value: number): Promise<{ ok: boolean; summary: string }>
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

export function setSheetActions(actions: SheetActions | null): void {
  sheetUi.setState({ actions })
}

/** Brings the panel up for a sheet in the conversation (its record's button). */
export function openSheet(sheetId: string): void {
  const s = sheetUi.getState()
  if (s.shown?.sheet.id !== sheetId) return
  sheetUi.setState({ open: true })
  // to its first field, once the panel is up
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="mimir-sheet-panel"] input:not([disabled])')?.focus())
}

export function closeSheet(): void {
  sheetUi.setState({ open: false })
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
