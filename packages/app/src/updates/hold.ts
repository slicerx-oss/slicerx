// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The part of in-app updates that is always loaded: the shell's updater, if it registered one, and the holds a print
// send puts on Restart to update. The rest (updates.ts, the dialog) loads only when there is an updater.
import type { UpdaterHost } from './updates'

let host: UpdaterHost | null = null
let holds = 0
const watchers = new Set<() => void>()

export function registerUpdater(updater: UpdaterHost | null): void {
  host = updater
}

export function updater(): UpdaterHost | null {
  return host
}

export function updaterRegistered(): boolean {
  return host !== null
}

/** Holds Restart to update while a print is being sent or a job is starting; call the returned function when it is done. */
export function holdUpdates(): () => void {
  holds++
  for (const w of watchers) w()
  let done = false
  return () => {
    if (done) return
    done = true
    holds--
    for (const w of watchers) w()
  }
}

export function held(): boolean {
  return holds > 0
}

export function onHoldChange(cb: () => void): () => void {
  watchers.add(cb)
  return () => watchers.delete(cb)
}

/** For tests. */
export function resetHolds(): void {
  host = null
  holds = 0
}
