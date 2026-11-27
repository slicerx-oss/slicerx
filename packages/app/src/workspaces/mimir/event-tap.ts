// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A watch on the tab's mimir events, for test scripts. The runtime logs each event to the session store as it emits it,
// so a listener on the store sees an event (a usage event, say) before the run makes its next model request: a script
// that presses Stop there sends nothing more.
import type { PilotEvent, SessionStore } from '@slicerx/contracts'

export type EventListener = (sessionId: string, event: PilotEvent) => void

export interface EventTap {
  /** Adds a listener; the function it returns removes it. */
  on(fn: EventListener): () => void
  /** The store with each append shown to the listeners first. A listener that throws never reaches the run. */
  wrap<S extends SessionStore>(store: S): S
}

export function createEventTap(): EventTap {
  const listeners = new Set<EventListener>()
  return {
    on(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    wrap(store) {
      return {
        ...store,
        append(sessionId: string, event: PilotEvent) {
          for (const fn of [...listeners]) {
            try {
              fn(sessionId, event)
            } catch {
              // a script's mistake never breaks a run
            }
          }
          return store.append(sessionId, event)
        },
      }
    },
  }
}

/** The tab's one tap, on its session logs (session.ts). */
export const mimirEvents = createEventTap()

// Test hook: with localStorage 'slicerx.debug' set (as for window.__sx), scripts watch the tab's mimir events as
// window.__mimirEvents.on((sessionId, event) => ...), which returns the listener's removal.
if (typeof window !== 'undefined' && typeof localStorage !== 'undefined' && localStorage.getItem('slicerx.debug')) Object.assign(window, { __mimirEvents: { on: mimirEvents.on } })
