// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The full geometry engine (the modeling tools) loads on its first call, which would make the first tool in Design
// wait. Design starts it on the way in (and when the pointer rests on its tab); until it is there the switcher shows
// it loading and the shelf's modeling tools wait. A host with its own engine (the desktop app) has it at once.
import { createStore, useStore } from 'zustand'
import { geom, usesWorker } from './client'

export type FullEngine = 'idle' | 'loading' | 'ready' | 'failed'

const engine = createStore<{ status: FullEngine }>()(() => ({ status: 'idle' }))

export function warmFullEngine(): void {
  if (engine.getState().status !== 'idle') return
  if (!usesWorker()) return engine.setState({ status: 'ready' })
  engine.setState({ status: 'loading' })
  geom()
    .call<boolean>('engine.full', null)
    .then(
      (ok) => engine.setState({ status: ok ? 'ready' : 'failed' }),
      () => engine.setState({ status: 'failed' }),
    )
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
