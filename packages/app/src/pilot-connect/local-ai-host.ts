// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where Set up local AI reads hardware and reaches local servers. Apart from local-ai.ts so an app
// entry can register its own without the model table and the checks in its startup bundle.
import type { Hardware, LocalNet } from '@slicerx/pilot/local-ai'

/** What a desktop shell provides: the hardware read and the local requests. */
export interface LocalAiHost {
  hardware(): Promise<Hardware>
  net: LocalNet
}

let factory: (() => LocalAiHost) | null = null
const listeners = new Set<() => void>()

/** Called once by an app entry that reads hardware and reaches local servers itself (the desktop app). */
export function registerLocalAi(f: (() => LocalAiHost) | null): void {
  factory = f
  for (const l of listeners) l()
}

export function registeredLocalAi(): (() => LocalAiHost) | null {
  return factory
}

export function onLocalAiChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
