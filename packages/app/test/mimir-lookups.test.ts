// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tab's scripted mimir and its lookup cards: a message picks its script, the script asks, waits for the pick
// and shows what it found; two cards show at most, each in a slot it keeps, and a closed card stays in the record.
import type { PilotEvent, PilotLookup } from '@slicerx/contracts'
import { foldEvents, startTurn, emptyTranscript } from '@slicerx/pilot/reduce'
import { beforeEach, describe, expect, it } from 'vitest'
import { assignSlots } from '../src/workspaces/mimir/lookup-cards'
import { closeLookup, lookupStore, setLookups, shownLookups } from '../src/workspaces/mimir/lookups'
import { lookupsIn } from '../src/workspaces/mimir/mimir-panes'
import { mimirTools, scriptedMimir } from '../src/workspaces/mimir/scripted'
import { SCRIPTS } from '../src/workspaces/mimir/scripts'

const look = (id: string): PilotLookup => ({ id, title: `Lookup ${id}`, fields: [['Size', '1 mm']], source: { title: 'Example', url: 'https://example.com' } })

beforeEach(() => lookupStore.setState({ all: [], closed: [] }))

describe('lookup cards', () => {
  it('show the newest two and fold the rest', () => {
    setLookups([look('a'), look('b'), look('c')])
    const { cards, folded } = shownLookups(lookupStore.getState())
    expect(cards.map((c) => c.id)).toEqual(['b', 'c'])
    expect(folded).toBe(1)
  })

  it('keep the record when closed', () => {
    setLookups([look('a'), look('b')])
    closeLookup('b')
    expect(shownLookups(lookupStore.getState()).cards.map((c) => c.id)).toEqual(['a'])
    expect(lookupStore.getState().all.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('keep their slot while on screen, so closing one never moves the other', () => {
    let slots = assignSlots([look('a'), look('b')], new Map())
    expect([...slots]).toEqual([['a', 0], ['b', 1]])
    // a closes: b stays in slot 1
    slots = assignSlots([look('b')], slots)
    expect(slots.get('b')).toBe(1)
    // c arrives: it takes the free slot 0
    slots = assignSlots([look('b'), look('c')], slots)
    expect([...slots]).toEqual([['b', 1], ['c', 0]])
  })

  it('come from the lookups in the conversation', () => {
    const t = foldEvents([{ type: 'lookup', lookup: look('x') }], startTurn(emptyTranscript(), { user: 'hi' }, 0))
    expect(lookupsIn(t).map((l) => l.id)).toEqual(['x'])
  })
})

describe('the scripted mimir', () => {
  async function play(message: string, pick: string | null): Promise<PilotEvent[]> {
    const p = scriptedMimir(SCRIPTS, mimirTools())
    const events: PilotEvent[] = []
    for await (const e of p.run('s', message)) {
      events.push(e)
      if (e.type === 'ask' && pick) void p.answer!(e.askId, pick)
      // The sheet that follows is confirmed as shown; these tests are about the question and the lookup.
      if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, {})
    }
    return events
  }

  it('confirms the thermostat, then shows the trim plate it found', async () => {
    const events = await play('Hey mimir, I need a wall mount for this thermostat. Can we print it?', 'same')
    expect(events.find((e) => e.type === 'ask')).toMatchObject({ title: 'Confirm model' })
    const lookup = events.find((e) => e.type === 'lookup')
    expect(lookup).toMatchObject({ lookup: { title: 'Reference found', fields: expect.arrayContaining([['Trim plate', '150.4 x 110.4 mm']]) } })
    // scripted sources are examples, never real pages
    expect(lookup?.type === 'lookup' && new URL(lookup.lookup.source.url).hostname).toBe('example.com')
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end' })
  })

  it('asks for the model name when the photo shows a different one', async () => {
    const events = await play('wall mount for my thermostat', 'other')
    expect(events.some((e) => e.type === 'lookup')).toBe(false)
    expect(events.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.delta : '')).join('')).toMatch(/model name/)
  })

  it('says what it knows for a message no script matches', async () => {
    const events = await play('make me a teapot', null)
    expect(events.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.delta : '')).join('')).toMatch(/Scripted replies know/)
  })

  it('has no tool that reaches a printer', () => {
    const names = scriptedMimir(SCRIPTS, mimirTools()).tools().map((t) => t.name)
    expect(names.some((n) => /^printer|queue|start/.test(n))).toBe(false)
  })
})
