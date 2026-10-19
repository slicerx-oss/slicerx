// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir.brain over the app link: the running edition's mimir read back from its config, the edition's own docs
// counted (never another edition's), and no voice text or doc text in the answer.
import { afterEach, describe, expect, it } from 'vitest'
import { brainSchema, type EditionConfig } from '@slicerx/edition-config'
import type { KbIndex } from '@slicerx/pilot'
import { APP_LINK_METHODS, runCall } from '../src/app-link/methods'
import { brainOf, type BrainState } from '../src/app-link/mimir-brain'
import { NEUTRAL, setCurrentEdition } from '../src/edition'

const VOICE = 'Talk like a harbor pilot: short, calm, metric units only.'
const DOC = 'Dock 4 printers run PETG at 245 C with the door closed.'

const HARBOR: EditionConfig = {
  ...NEUTRAL,
  id: 'harbor',
  brand: { ...NEUTRAL.brand, name: 'Harbor', assistant: { ...NEUTRAL.brand.assistant, name: 'Pilot' } },
  ai: { ...NEUTRAL.ai, brain: brainSchema.parse({ voice: VOICE, cloud: { stepUp: 'sonnet' }, memory: { local: false, sync: 'opt-in' }, tools: { printers: false, web: false, design: true }, knowledge: ['knowledge'] }) },
}

const doc = (id: string, edition?: string) => ({ kind: 'troubleshoot', id, name: id, aliases: [], file: `knowledge/${id}.yaml`, data: { summary: DOC }, sources: [], ...(edition ? { edition } : {}) })
const INDEX = { docs: [doc('dock', 'harbor'), doc('tide', 'harbor'), doc('quay', 'other')] } as unknown as KbIndex

afterEach(() => setCurrentEdition(NEUTRAL))

describe('mimir.brain over the app link', () => {
  it('reads with the read class', () => {
    expect(APP_LINK_METHODS['mimir.brain']).toBe('read')
  })

  it('read-back matches the edition config', async () => {
    setCurrentEdition(HARBOR)
    const out = (await runCall('mimir.brain', {})) as BrainState
    expect(out).toEqual({
      name: 'Pilot',
      voice: true,
      toolGroups: { design: true, slicing: true, printers: false, watch: true, paint: true, web: false },
      cloud: { base: 'claude-haiku-5-5', stepUp: 'sonnet' },
      memory: { local: false, sync: 'opt-in' },
      // the checked-in edition index has no harbor docs
      knowledgeDocs: 0,
    })
    expect(brainOf(HARBOR, INDEX).knowledgeDocs).toBe(2)
  })

  it('the neutral edition reads as the stock mimir', async () => {
    expect(await runCall('mimir.brain', {})).toEqual({
      name: 'mimir',
      voice: false,
      toolGroups: { design: true, slicing: true, printers: true, watch: true, paint: true, web: true },
      cloud: { base: 'claude-haiku-5-5', stepUp: null },
      memory: { local: true, sync: 'off' },
      knowledgeDocs: 0,
    })
  })

  it('no voice text or doc text leaks', async () => {
    const all = JSON.stringify(brainOf(HARBOR, INDEX))
    expect(all).not.toContain(VOICE)
    expect(all).not.toContain('harbor pilot')
    expect(all).not.toContain(DOC)
    for (const id of ['dock', 'tide', 'quay', 'knowledge/']) expect(all).not.toContain(id)
    setCurrentEdition(HARBOR)
    expect(JSON.stringify(await runCall('mimir.brain', {}))).not.toContain(VOICE)
  })
})
