// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the edition's brain pack (ai.brain) sets on every mimir the app makes: the tool groups it switched off, with
// the web lookup off too when web is, and the models for the person's own key (routing). The dock, the browser's
// cad dock and the mimir tab all take these, and the app link's mimir.brain reads the same groups back.
import type { PilotConfig } from '@slicerx/contracts'
import type { EditionConfig } from '@slicerx/edition-config'
import { TOOL_GROUPS, type ToolGroups } from '@slicerx/pilot'

/** The groups the edition switched off (false), as the runtime applies them with applyToolGroups. */
export function editionToolGroups(edition: Pick<EditionConfig, 'ai'>): ToolGroups {
  const tools = edition.ai.brain.tools ?? {}
  return Object.fromEntries(TOOL_GROUPS.filter((g) => tools[g] === false).map((g) => [g, false])) as ToolGroups
}

/**
 * `config` with the edition's brain pack on it: no web search when the web group is off, and ai.brain.routing as the
 * models for the person's own key (mimir cloud ignores it; its proxy picks the model).
 */
export function withBrain(config: PilotConfig, edition: Pick<EditionConfig, 'ai'>): PilotConfig {
  const brain = edition.ai.brain
  const out: PilotConfig = { ...config }
  if (brain.tools?.web === false) out.webSearch = false
  const r = brain.routing
  if (r && (r.base !== undefined || r.step !== undefined)) {
    out.routing = { ...(r.provider !== undefined ? { provider: r.provider } : {}), ...(r.base !== undefined ? { base: r.base } : {}), ...(r.step !== undefined ? { step: r.step } : {}) }
  }
  return out
}
