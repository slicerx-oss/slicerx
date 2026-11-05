// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client's change to a saved preset waits for the person. Presets are not part of the open project, and the app
// link's grant covers only the project, so every copy into a preset or undo of one asks the person in the app
// (prompt.tsx), each time. The call waits for the answer; one question per client, three waiting at most. A question
// nobody answers in time is declined.
import { createStore, useStore } from 'zustand'
import { LinkError } from './methods-error'

export interface PresetAsk {
  id: number
  client: { id: string; name: string }
  /** `Set Layer height in Fast draft to 0.12 mm?` */
  title: string
  /** One or two plain lines: the value it has now and the value it gets. */
  lines: string[]
  answer: (yes: boolean) => void
}

const MAX_WAITING = 3
/** Shorter than the hub's longest call (120 s), so the client hears the decline instead of a timeout. */
export const PRESET_ASK_MS = 110_000
let seq = 0

export const presetAsks = createStore<{ asks: PresetAsk[] }>()(() => ({ asks: [] }))

export function usePresetAsks(): PresetAsk[] {
  return useStore(presetAsks, (s) => s.asks)
}

const drop = (id: number) => presetAsks.setState((s) => ({ asks: s.asks.filter((a) => a.id !== id) }))

/** Asks the person; resolves true when they allow it. Refused at once while this client or too many already wait. */
export function askPresetWrite(client: { id: string; name: string }, title: string, lines: string[]): Promise<boolean> {
  const waiting = presetAsks.getState().asks
  if (waiting.some((a) => a.client.id === client.id)) throw new LinkError('busy', 'this client already has a preset change waiting for the person')
  if (waiting.length >= MAX_WAITING) throw new LinkError('busy', 'the person has preset changes waiting already; try again after they answer')
  return new Promise<boolean>((resolve) => {
    const id = ++seq
    const timer = setTimeout(() => finish(false), PRESET_ASK_MS)
    function finish(yes: boolean): void {
      clearTimeout(timer)
      drop(id)
      resolve(yes)
    }
    presetAsks.setState((s) => ({ asks: [...s.asks, { id, client, title, lines, answer: finish }] }))
  })
}

// Test hook: with localStorage 'slicerx.debug' set (as for window.__sx), scripts reach the waiting questions as
// window.__presetAsks, to show one for a screenshot without a hub.
if (typeof window !== 'undefined' && typeof localStorage !== 'undefined' && localStorage.getItem('slicerx.debug')) Object.assign(window, { __presetAsks: { ask: askPresetWrite, store: presetAsks } })
