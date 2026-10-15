// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What answers in the docked chat, read back over the app link (mimir.dock): a model or the built-in demo, whether
// the model runs locally, and the tools the model is offered there. A local model gets only the dock's own tools
// (see @slicerx/pilot surfaces), so a client reads the list the model really sees. No key or token.
import type { Pilot, PilotConfig } from '@slicerx/contracts'
import { isLocalModel } from '@slicerx/pilot'

export interface DockState {
  /** "model" when a model answers, "demo" when the built-in demo does, "none" before the chat is set up. */
  link: 'none' | 'demo' | 'model'
  provider: string | null
  model: string | null
  /** Whether the model runs on this computer (Ollama or LM Studio). */
  local: boolean
  /** The tools the model is offered in the dock, by name. */
  tools: string[]
}

let current: { pilot: Pilot; link: 'demo' | 'model'; config: PilotConfig } | null = null

/** The docked chat registers its runtime when it makes one; null takes it away. */
export function setDockPilot(d: { pilot: Pilot; link: 'demo' | 'model'; config: PilotConfig } | null): void {
  current = d
}

/** The runtime registered now, so a chat that goes away removes only its own. */
export function dockPilot(): Pilot | null {
  return current?.pilot ?? null
}

/** `mimir.dock`: what answers in the docked chat and the tools its model is offered. */
export function dockState(): DockState {
  if (!current) return { link: 'none', provider: null, model: null, local: false, tools: [] }
  const { pilot, link, config } = current
  const model = link === 'model'
  return { link, provider: model ? config.provider : null, model: model ? config.model : null, local: model && isLocalModel(config), tools: pilot.tools().map((t) => t.name) }
}
