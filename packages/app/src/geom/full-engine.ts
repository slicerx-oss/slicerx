// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The full geometry engine (the modeling tools) loads on its first call, which would make the first tool in Design
// wait. Design starts it on the way in (and when the pointer rests on its tab); until it is there the switcher shows
// it loading and the shelf's modeling tools wait. A host with its own engine (the desktop app) has it at once.
// The geometry client loads after the first screen, not with it: this module only reads its status, so the client's
// code is fetched on an idle moment (or when Design asks first).
import { createStore, useStore } from 'zustand'

export type FullEngine = 'idle' | 'loading' | 'ready' | 'failed'

const engine = createStore<{ status: FullEngine }>()(() => ({ status: 'idle' }))

type Client = typeof import('./client')
let clientLoad: Promise<Client> | null = null
let client: Client | null = null

function loadClient(): Promise<Client> {
  clientLoad ??= import('./client').then(
    (c) => (client = c),
    (e: unknown) => {
      // A chunk that failed to download (offline, a new deploy) is asked for again by the next import.
      clientLoad = null
      throw e
    },
  )
  return clientLoad
}

/** Fetches the client's code now, so a warm that follows finds it there and starts at once. */
export function prefetchFullEngine(): void {
  void loadClient().catch(() => undefined)
}

// Fetch it when the page is idle too, and when a pointer comes to the Model tab (shell/mode-tab.tsx), which is a
// moment before the warm.
if (typeof window !== 'undefined') {
  const idle = (window as { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback
  if (idle) idle(prefetchFullEngine)
  else setTimeout(prefetchFullEngine, 1000)
}

function start({ geom, usesWorker }: Client): void {
  if (!usesWorker()) return engine.setState({ status: 'ready' })
  engine.setState({ status: 'loading' })
  geom()
    .call<boolean>('engine.full', null)
    .then(
      (ok) => engine.setState({ status: ok ? 'ready' : 'failed' }),
      () => engine.setState({ status: 'failed' }),
    )
}

export function warmFullEngine(): void {
  if (engine.getState().status !== 'idle') return
  // The client is there already (the idle fetch ran): start at once, as before.
  if (client) return start(client)
  // Else show loading first and start when the client's code arrives.
  engine.setState({ status: 'loading' })
  loadClient().then(start, () => engine.setState({ status: 'failed' }))
}

export function useFullEngine(): FullEngine {
  return useStore(engine, (s) => s.status)
}

export function fullEngine(): FullEngine {
  return engine.getState().status
}

/** For tests. */
export function resetFullEngine(): void {
  engine.setState({ status: 'idle' })
}
