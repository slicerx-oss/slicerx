// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Undo and redo for every plate edit. Rather than wrap each action, the history watches the plate
// in the app store and keeps the state before each change: adds, removes, moves, rotations,
// scaling, arranging, plates and object settings all come back the same way. Snapshots share
// meshes by reference, so a step costs a few arrays, not geometry.
import { appStore, markStale, type AppState } from '../state/store'

/** What one step restores. */
export type Snapshot = Pick<AppState, 'plate' | 'selection'> & Partial<Pick<AppState, 'selectedIds' | 'plates' | 'activePlate' | 'objectSettings' | 'slotSetup' | 'flush'>>

const KEYS = ['plate', 'selection', 'selectedIds', 'plates', 'activePlate', 'objectSettings', 'slotSetup', 'flush'] as const

export interface History {
  undo(): boolean
  redo(): boolean
  canUndo(): boolean
  canRedo(): boolean
  /** Forget everything, for a new project. */
  clear(): void
  /** Called with the counts after every change, for the toolbar. */
  subscribe(cb: (s: { undo: number; redo: number }) => void): () => void
  dispose(): void
}

function snap(s: AppState): Snapshot {
  const out: Record<string, unknown> = {}
  for (const k of KEYS) if (k in s) out[k] = s[k as keyof AppState]
  return out as Snapshot
}

/** Only the plate and its settings count as edits; selection alone does not. */
function edited(s: AppState, prev: AppState): boolean {
  return s.plate !== prev.plate || s.plates !== prev.plates || s.objectSettings !== prev.objectSettings || s.slotSetup !== prev.slotSetup || s.flush !== prev.flush
}

let quiet = 0

/** Runs a state change that is navigation, not an edit (switching plates), without an undo step. */
export function quietly<T>(fn: () => T): T {
  quiet++
  try {
    return fn()
  } finally {
    quiet--
  }
}

let step: object | null = null
let lastStep: object | null = null

/**
 * Runs edits as part of the undo step `token` names: the first edit under a token makes the step and later ones
 * join it, as long as nothing else was edited in between. One assistant action is one undo step this way.
 */
export function inStep<T>(token: object, fn: () => T): T {
  const was = step
  step = token
  try {
    return fn()
  } finally {
    step = was
  }
}

export function createHistory(store = appStore, limit = 100): History {
  const undo: Snapshot[] = []
  const redo: Snapshot[] = []
  const listeners = new Set<(s: { undo: number; redo: number }) => void>()
  let restoring = false
  const notify = () => {
    for (const cb of listeners) cb({ undo: undo.length, redo: redo.length })
  }
  const off = store.subscribe((s, prev) => {
    if (restoring || quiet > 0 || !edited(s, prev)) return
    // Loading a plate from scratch is not something to undo into an empty plate while it loads.
    if (prev.plateLoading && prev.plate.length === 0) return
    if (step && step === lastStep) {
      redo.length = 0
      return
    }
    lastStep = step
    undo.push(snap(prev))
    if (undo.length > limit) undo.shift()
    redo.length = 0
    notify()
  })
  const restore = (from: Snapshot[], to: Snapshot[]): boolean => {
    const target = from.pop()
    if (!target) return false
    lastStep = null
    restoring = true
    try {
      // A history step open for editing closes first: the object goes back to how it is.
      const open = store.getState().historyEdit
      if (open) store.setState((s) => ({ plate: s.plate.map((e) => (e.id === open.objectId ? open.original : e)), historyEdit: null }))
      to.push(snap(store.getState()))
      store.setState(target)
    } finally {
      restoring = false
    }
    markStale()
    notify()
    return true
  }
  return {
    undo: () => restore(undo, redo),
    redo: () => restore(redo, undo),
    canUndo: () => undo.length > 0,
    canRedo: () => redo.length > 0,
    clear() {
      undo.length = 0
      redo.length = 0
      notify()
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    dispose() {
      off()
      listeners.clear()
    },
  }
}

let shared: History | null = null

/** The app's one history, created on first use. */
export function history(): History {
  return (shared ??= createHistory())
}
