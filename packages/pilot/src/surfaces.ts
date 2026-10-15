// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which tools mimir offers a model, by where it runs. A cloud model gets every tool the runtime has. A local model has
// a small context (see context.ts) where the tool schemas are most of the request, so it gets only the tools its
// surface uses: the docked chat keeps its chat tools and text_to_part as the way into a design, without make_model.
import type { PilotConfig } from '@slicerx/contracts'

/** Where a mimir runs: the docked chat beside the plate. */
export type ToolSurface = 'dock'

/** Whether a config runs a local model (Ollama or LM Studio through their OpenAI-compatible server). */
export function isLocalModel(config: Pick<PilotConfig, 'provider'>): boolean {
  return config.provider === 'openai-compatible'
}

/** Tools a local model does not get, per surface. Everything else the surface has stays. */
const LOCAL_LEAVE_OUT: Record<ToolSurface, ReadonlySet<string>> = {
  // text_to_part is the dock's one way into a design; make_model's schema alone is about 1,700 tokens
  dock: new Set(['make_model']),
}

/** The tools a model on `surface` is offered: all of `tools` for a cloud model, the surface's own set for a local one. */
export function surfaceTools<T extends { name: string }>(surface: ToolSurface, local: boolean, tools: readonly T[]): T[] {
  if (!local) return [...tools]
  const out = LOCAL_LEAVE_OUT[surface]
  return tools.filter((t) => !out.has(t.name))
}
