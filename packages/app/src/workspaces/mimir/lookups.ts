// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What mimir looked up in this conversation, for the cards over the view. The chat writes the list from its
// transcript; closing a card only hides it there, so the record stays in the conversation and in its read-back.
import type { PilotLookup } from '@slicerx/contracts'
import { createStore, useStore } from 'zustand'

export interface LookupState {
  /** Every lookup in the conversation, oldest first. */
  all: PilotLookup[]
  /** Ids the person closed. */
  closed: string[]
}

export const lookupStore = createStore<LookupState>()(() => ({ all: [], closed: [] }))

/** At most this many cards show at once; older open ones fold into a "more" chip. */
export const MAX_CARDS = 2

/** The cards on screen, newest last, and how many older open ones are folded. */
export function shownLookups(s: LookupState): { cards: PilotLookup[]; folded: number } {
  const open = s.all.filter((l) => !s.closed.includes(l.id))
  return { cards: open.slice(-MAX_CARDS), folded: Math.max(0, open.length - MAX_CARDS) }
}

export function setLookups(all: PilotLookup[]): void {
  const s = lookupStore.getState()
  if (s.all.length === all.length && s.all.every((l, i) => l.id === all[i]?.id)) return
  lookupStore.setState({ all, closed: s.closed.filter((id) => all.some((l) => l.id === id)) })
}

export function closeLookup(id: string): void {
  lookupStore.setState((s) => (s.closed.includes(id) ? s : { closed: [...s.closed, id] }))
}

export function useLookups<T>(pick: (s: LookupState) => T): T {
  return useStore(lookupStore, pick)
}
