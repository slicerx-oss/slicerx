// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A host transport that reaches no model, marked as such. The browser build sets one as host.llm so the setup reads the
// same everywhere, but it is not a transport of its own: mimir keeps its browser transport where a host has it, even once
// a paired bridge brings secure storage. No runtime imports, so the browser host can load it at startup.
import type { LlmTransport } from '@slicerx/contracts'

const standIns = new WeakSet<LlmTransport>()

/** Marks `t` as a stand-in that reaches no model, and returns it. */
export function standInLlm<T extends LlmTransport>(t: T): T {
  standIns.add(t)
  return t
}

/** True when `t` is a stand-in marked with standInLlm. */
export function isStandInLlm(t: LlmTransport | undefined): boolean {
  return t !== undefined && standIns.has(t)
}
