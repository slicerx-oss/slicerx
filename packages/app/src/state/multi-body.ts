// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A mesh file that holds several separate bodies opens as one object with a part per body, or as one object per body.
// The app asks unless Settings > Slicing and modeling says which; "Remember my choice" on the question sets that.
import { MULTI_BODY_DEFAULT, type MultiBodyPref } from './prefs'
import { get, set } from './store'

export { MULTI_BODY_DEFAULT, type MultiBodyPref }
export type MultiBodyChoice = Exclude<MultiBodyPref, 'ask'>

export const MULTI_BODY_MODES: readonly { value: MultiBodyPref; label: string; title: string }[] = [
  { value: 'ask', label: 'Ask', title: 'Ask each time a file holds more than one body' },
  { value: 'parts', label: 'One object', title: 'One object with a part per body: they move together' },
  { value: 'objects', label: 'Separate objects', title: 'An object per body: each moves and arranges on its own' },
]

export const MULTI_BODY_DETAIL = 'When a model file holds more than one separate body.'

/** An import's objects as the plate takes them (import-auto.ts entriesFromImport). */
export interface BodyEntry {
  parts: { name: string }[]
  name: string
  colors: string[]
  transform: number[]
  perShell: boolean
}

/** Separate bodies in an import, counted as parts across its objects. */
export function bodyCount(made: readonly BodyEntry[]): number {
  return made.reduce((n, m) => n + m.parts.length, 0)
}

/** The objects for a choice: every body as a part of one object named after the file, or every body an object. */
export function regroup<T extends BodyEntry>(made: readonly T[], choice: MultiBodyChoice, fileName: string): T[] {
  const first = made[0]
  if (!first) return []
  if (choice === 'parts') {
    if (made.length === 1) return [...made]
    return [{ ...first, name: fileName, parts: made.flatMap((m) => m.parts), colors: made.flatMap((m) => m.colors), perShell: true }]
  }
  return made.flatMap((m) =>
    m.parts.map((p, i) => ({ ...m, name: m.parts.length > 1 ? p.name : m.name, parts: [p], colors: [m.colors[i] ?? m.colors[0] ?? ''], perShell: true })),
  )
}

let enabled = false
let pending: ((choice: MultiBodyChoice | null) => void) | null = null

/** The app shell turns the question on while it shows; without it (a test, a host with no window) imports keep the engine's grouping. */
export function enableMultiBodyPrompt(): () => void {
  enabled = true
  return () => {
    enabled = false
    answerMultiBody(null)
  }
}

/** The choice for an import of `bodies` bodies: the setting's, or the person's answer. Null keeps the engine's grouping. */
export function multiBodyChoice(fileName: string, bodies: number): Promise<MultiBodyChoice | null> {
  if (bodies < 2) return Promise.resolve(null)
  const pref = get().multiBodyImport
  if (pref !== 'ask') return Promise.resolve(pref)
  if (!enabled) return Promise.resolve(null)
  pending?.(null)
  return new Promise((resolve) => {
    pending = resolve
    set({ multiBodyPrompt: { name: fileName, bodies } })
  })
}

/** The question's answer; with `remember` it becomes the setting, so the question does not come back. */
export function answerMultiBody(choice: MultiBodyChoice | null, remember = false): void {
  const r = pending
  pending = null
  set({ multiBodyPrompt: null, ...(choice && remember ? { multiBodyImport: choice } : {}) })
  r?.(choice)
}
