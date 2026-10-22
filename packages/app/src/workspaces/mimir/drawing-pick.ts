// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the sheet's drawing shows on a phone. A phone has no room for four views, so the drawing opens on Top and
// Isometric side by side, drawn large, and a picker in its header swaps them for Front or Right, one at a time. The
// picker offers Front or Right only when the sheet draws a callout in it, and with neither it is not shown. A 44 px
// control folds the drawing down to its header, giving the sizes in the chat the room. The pick and the fold start over
// with each new sheet. The desktop keeps its four views and uses none of this.
import { createStore, useStore } from 'zustand'
import { usePhoneLayout } from '../../lib/phone-layout'
import type { ViewName } from './sheet-draw'

/** A picker choice: Top and Isometric together, or Front or Right alone. */
export type PhonePane = 'main' | 'front' | 'side'

/** The picker's choices, in its order. */
export const PHONE_PANES: readonly PhonePane[] = ['main', 'front', 'side']

/** The views each choice draws, left to right. */
export const PANE_VIEWS: Record<PhonePane, readonly ViewName[]> = { main: ['top', 'iso'], front: ['front'], side: ['side'] }

/** The picker's plain names for its choices. */
export const PANE_NAMES: Record<PhonePane, string> = { main: 'Top and iso', front: 'Front', side: 'Right' }

/** The choice a new sheet opens on. The iso view carries every callout, so each row's number is on screen from the start. */
export const FIRST_PANE: PhonePane = 'main'

export interface DrawingPick {
  /** The sheet the pick belongs to. */
  sheetId: string | null
  pane: PhonePane
  /** Folded down to its header. */
  folded: boolean
}

export const START: DrawingPick = { sheetId: null, pane: FIRST_PANE, folded: false }

/** The pick for a sheet: the one held when it is the same sheet, else a fresh one on the first choice, unfolded. */
export function pickFor(s: DrawingPick, sheetId: string): DrawingPick {
  return s.sheetId === sheetId ? s : { ...START, sheetId }
}

/**
 * The choices the picker offers for a sheet, from the views each row's callout is drawn in (`viewsFor`): Top and iso
 * always, and Front or Right only when it draws a callout, so no choice opens on a view with nothing to edit.
 */
export function panesFor(shows: ReadonlyMap<string, readonly ViewName[]>): PhonePane[] {
  const drawn = new Set([...shows.values()].flat())
  return PHONE_PANES.filter((p) => p === FIRST_PANE || PANE_VIEWS[p].some((v) => drawn.has(v)))
}

/** The choice on screen: the one picked while the picker offers it, else Top and iso. */
export function paneOffered(pane: PhonePane, offered: readonly PhonePane[]): PhonePane {
  return offered.includes(pane) ? pane : FIRST_PANE
}

/** Shows a choice. One the picker does not offer, or the one showing, leaves the pick as it is. */
export function pickPane(s: DrawingPick, pane: PhonePane, offered: readonly PhonePane[] = PHONE_PANES): DrawingPick {
  return offered.includes(pane) && s.pane !== pane ? { ...s, pane } : s
}

/** Folds the drawing down to its header, or opens it again on the choice it had. */
export function toggleFold(s: DrawingPick): DrawingPick {
  return { ...s, folded: !s.folded }
}

/**
 * The choice to show while a row is picked: the one showing when it draws the row's callout, else the first in the
 * picker's order that does, so a picked row always has its callout on screen. With none that has it, no change.
 */
export function paneShowing(current: PhonePane, has: (v: ViewName) => boolean): PhonePane {
  const draws = (p: PhonePane) => PANE_VIEWS[p].some(has)
  if (draws(current)) return current
  return PHONE_PANES.find(draws) ?? current
}

export const drawingPick = createStore<DrawingPick>()(() => START)

/** Shows a choice of a sheet's drawing on a phone, when the picker offers it. */
export function showPane(sheetId: string, pane: PhonePane, offered: readonly PhonePane[] = PHONE_PANES): void {
  drawingPick.setState((st) => pickPane(pickFor(st, sheetId), pane, offered), true)
}

/** Folds a sheet's drawing on a phone, or opens it again. */
export function foldDrawing(sheetId: string): void {
  drawingPick.setState((st) => toggleFold(pickFor(st, sheetId)), true)
}

/** The phone's pick for a sheet. `phone` is false on a desktop, where all four views show and nothing folds. */
export function usePhoneDrawing(sheetId: string): { phone: boolean; pane: PhonePane; folded: boolean } {
  const phone = usePhoneLayout()
  // primitives, so a render reads the same snapshot until the pick changes
  const pane = useStore(drawingPick, (st) => pickFor(st, sheetId).pane)
  const folded = useStore(drawingPick, (st) => pickFor(st, sheetId).folded)
  return { phone, pane, folded: phone && folded }
}
