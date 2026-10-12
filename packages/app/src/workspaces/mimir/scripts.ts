// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The scripted turns mimir plays in the tab before a model is connected. Each one streams text and calls real tools,
// so what it builds lands in the design's history like a person's edit.
import type { LlmMessage, ScriptStep } from '@slicerx/pilot'
import type { MimirScript } from './scripted'

/** The pick the last pilot.ask returned, from the tool message the runtime sent back. */
export function lastPick(messages: readonly LlmMessage[]): string | null {
  const m = messages.at(-1)
  if (m?.role !== 'tool') return null
  try {
    const out = JSON.parse(m.content) as { result?: { picked?: string } }
    return out.result?.picked ?? null
  } catch {
    return null
  }
}

/** A placeholder source: scripted lookups are examples, never real pages. */
const EXAMPLE_SOURCE = { title: 'Example spec sheet (scripted)', url: 'https://example.com/thermostat-specs' }

const backplate: ScriptStep[] = [
  {
    reasoning: 'The photo shows a round thermostat on a rectangular trim plate.',
    text: 'That looks like a round smart thermostat on a rectangular trim plate.',
    calls: [{ name: 'pilot.ask', args: { title: 'Confirm model', question: 'Is this the thermostat on your wall?', choices: [{ id: 'same', label: 'Yes, that one' }, { id: 'other', label: 'A different model' }] } }],
  },
  (messages) =>
    lastPick(messages) === 'other'
      ? { text: 'Send me the model name from its back, or a photo of the label, and I will look up its size.' }
      : {
          text: 'I found the trim plate size.',
          calls: [{ name: 'lookup.show', args: { title: 'Reference found', fields: [['Trim plate', '150.4 x 110.4 mm'], ['Center hole', '30 mm'], ['Mounting holes', '2 x 4.5 mm, 60 mm apart']], source: EXAMPLE_SOURCE } }],
        },
  { text: 'I will draw the outline and three holes, then extrude them together, 3 mm thick.' },
]

export const SCRIPTS: MimirScript[] = [{ id: 'backplate', match: /thermostat|backplate|wall mount/i, steps: backplate }]
