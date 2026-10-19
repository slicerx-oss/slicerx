// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir this edition runs, read over the app link (mimir.brain): its name, whether the edition gave it a voice,
// which tool groups it keeps, the model mimir cloud answers with and the step-up the edition asks for, what it may
// remember, and how many docs of the edition's own knowledge it searches. Metadata only: the voice text and the
// knowledge docs never leave the app.
import { BRAIN_TOOL_GROUPS, type EditionConfig } from '@slicerx/edition-config'
import type { KbIndex } from '@slicerx/pilot'
import { currentEdition } from '../edition'
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
  /** Docs of the edition's own knowledge (ai.brain.knowledge) in the edition index. */
  knowledgeDocs: number
}

/** The answer for an edition, given the edition index scripts/build-kb.ts compiles. */
export function brainOf(edition: EditionConfig, editionIndex: Pick<KbIndex, 'docs'>): BrainState {
  const brain = edition.ai.brain
  // TODO: read the groups from the running mimir once it filters its tools with applyToolGroups; until then they come from the edition config.
  const toolGroups = Object.fromEntries(BRAIN_TOOL_GROUPS.map((g) => [g, brain.tools?.[g] !== false]))
  return {
    name: edition.brand.assistant.name,
    voice: brain.voice !== undefined,
    toolGroups,
    cloud: { base: CLOUD_MODEL, stepUp: brain.cloud.stepUp === 'none' ? null : brain.cloud.stepUp },
    memory: { local: brain.memory.local, sync: brain.memory.sync },
    knowledgeDocs: editionIndex.docs.filter((d) => d.edition === edition.id).length,
  }
}

/** mimir.brain: the running edition's mimir. */
export async function brainState(): Promise<BrainState> {
  const index = (await import('@slicerx/pilot/edition-kb.json')).default as unknown as KbIndex
  return brainOf(currentEdition(), index)
}
