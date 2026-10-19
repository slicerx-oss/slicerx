// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir this edition runs, read over the app link (mimir.brain): its name, whether the edition gave it a voice,
// which tool groups it keeps, the model mimir cloud answers with and the step-up the edition asks for, what it may
// remember, and how many docs of the edition's own knowledge it searches. Metadata only: the voice text and the
// knowledge docs never leave the app.
import type { EditionConfig } from '@slicerx/edition-config'
import { keptEditionDocs, TOOL_GROUPS, type KbIndex } from '@slicerx/pilot'
import { currentEdition } from '../edition'
import { editionKbIndex } from '../workspaces/mimir/kb'
import { editionToolGroups } from '../pilot-connect/brain'
import { CLOUD_MODEL } from '../pilot-connect/cloud-edition'

/** The app's answer to mimir.brain. */
export interface BrainState {
  /** The assistant's name (brand.assistant.name). */
  name: string
  /** True when the edition set a voice (ai.brain.voice). The text itself stays in the app. */
  voice: boolean
  /** Every tool group an edition can switch, true unless the edition switched it off. */
  toolGroups: Record<string, boolean>
  /** mimir cloud's base model, and the step-up the edition asks for (null for none). The proxy decides the step-up. */
  cloud: { base: string; stepUp: string | null }
  memory: { local: boolean; sync: 'off' | 'opt-in' }
  /** Docs of the edition's own knowledge (ai.brain.knowledge) mimir searches: those in the edition index that do not share a bundled doc's id or name. */
  knowledgeDocs: number
}

/**
 * The answer for an edition, given its knowledge index (edition-kb.<id>.json, null when it has none) and the bundled
 * index, whose docs win over an edition doc of the same id or name.
 */
export function brainOf(edition: EditionConfig, editionIndex: Pick<KbIndex, 'docs'> | null, bundled: Pick<KbIndex, 'docs'> = { docs: [] }): BrainState {
  const brain = edition.ai.brain
  // the same switches every mimir the app makes passes to applyToolGroups (pilot-connect/brain.ts)
  const applied = editionToolGroups(edition)
  const toolGroups = Object.fromEntries(TOOL_GROUPS.map((g) => [g, applied[g] !== false]))
  return {
    name: edition.brand.assistant.name,
    voice: brain.voice !== undefined,
    toolGroups,
    cloud: { base: CLOUD_MODEL, stepUp: brain.cloud.stepUp === 'none' ? null : brain.cloud.stepUp },
    memory: { local: brain.memory.local, sync: brain.memory.sync },
    knowledgeDocs: editionIndex ? keptEditionDocs(bundled, { id: edition.id, index: editionIndex as KbIndex }).length : 0,
  }
}

/** mimir.brain: the running edition's mimir, with the knowledge index the build carries for it. */
export async function brainState(): Promise<BrainState> {
  const index = await editionKbIndex()
  // the bundled index only matters when the edition has docs of its own to count against it
  const bundled = index ? ((await import('@slicerx/pilot/kb.json')).default as unknown as KbIndex) : undefined
  return brainOf(currentEdition(), index, bundled)
}
