// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How design.lookup_sizes reads a web answer into sizes. A model answering a sizes search does not always label each
// line with the size's name as asked: it may write "size:" on every line, shorten a name, or add words to it. An exact
// name wins; then a line whose name has the same head noun and no other part's words; then, when no line names a size
// asked, one line per size in the order asked. A line that gives a figure in metric and imperial is read by its metric
// one, as the source wrote it.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readSizes } from '../src/real-lookup'
import { createPlanRegistry } from '../src/design-check'
import { createCardPlans, tabToolset } from '../src/toolset'
import type { DesignHost } from '@slicerx/cad-history'
import type { ToolContext } from '@slicerx/pilot'

/** A recorded sizes answer (mimir cloud, the base model with web search): every line labeled "size", cut off at the output limit. */
const RECORDED = readFileSync(new URL('./fixtures/size-lookup-answer.txt', import.meta.url), 'utf8')
/** The sizes that request asked for, in its order. */
const ASKED = ['Overall length', 'Width (across)', 'Wall height to the roof', 'Tower height above the roof', 'Tower diameter', 'Spire height above ground', 'Wing length']

describe('reading a sizes answer', () => {
  it('reads the recorded answer whose lines are all labeled "size", in the order asked, by each line\'s metric figure', () => {
    expect(RECORDED.startsWith('size: 412 ft 6 in (125.7 m) Length:')).toBe(true)
    const { found, missing } = readSizes(RECORDED, ASKED)
    expect(found).toEqual([
      { size: 'Overall length', mm: 125700, said: '125.7 m' },
      { size: 'Width (across)', mm: 12600, said: '12.6 m' },
      { size: 'Tower height above the roof', mm: 17526, said: '57.5 ft' },
    ])
    expect(missing).toEqual(['Wall height to the roof', 'Tower diameter', 'Spire height above ground', 'Wing length'])
  })

  it('matches a line to the size asked by the same head noun, either way round, and never to another part\'s size', () => {
    const answer = 'Width: 28 m\nTower height above the roof: 19 m\nLength: 300 m\nHeight: 40 m'
    const { found, missing } = readSizes(answer, ['Width (across)', 'Tower height', 'Overall length', 'Spire height', 'Wall height'])
    // "Height" alone could be the spire's or the wall's, so it is not read as either
    expect(found).toEqual([
      { size: 'Width (across)', mm: 28000, said: '28 m' },
      { size: 'Tower height', mm: 19000, said: '19 m' },
      { size: 'Overall length', mm: 300000, said: '300 m' },
    ])
    expect(missing).toEqual(['Spire height', 'Wall height'])
  })

  it('takes an exact name before a loose one', () => {
    const { found } = readSizes('Tower height above deck: 150 m\nTower height: 227 m', ['Tower height'])
    expect(found).toEqual([{ size: 'Tower height', mm: 227000, said: '227 m' }])
  })

  it('takes lines with no name, one per size, in the order asked', () => {
    const { found, missing } = readSizes('- 280 m\n- not found\n- 128 m', ['Deck length', 'Deck width', 'Main span'])
    expect(found).toEqual([
      { size: 'Deck length', mm: 280000, said: '280 m' },
      { size: 'Main span', mm: 128000, said: '128 m' },
    ])
    expect(missing).toEqual(['Deck width'])
  })

  it('does not read lines in order once any line names a size asked', () => {
    const { found, missing } = readSizes('Deck length: 280 m\nsize: 30 m', ['Deck length', 'Deck width'])
    expect(found).toEqual([{ size: 'Deck length', mm: 280000, said: '280 m' }])
    expect(missing).toEqual(['Deck width'])
  })

  it('reads feet and inches together when a line gives no metric figure', () => {
    expect(readSizes('Overall length: 412 ft 6 in', ['Overall length']).found).toEqual([{ size: 'Overall length', mm: 125730, said: '412 ft 6 in' }])
  })
})

describe('design.lookup_sizes asks for a few published sizes', () => {
  const lookup = () => tabToolset({ list: () => [], get: () => undefined } as unknown as DesignHost, createCardPlans(createPlanRegistry()), { nozzleMm: () => 0.4 }).find((t) => t.name === 'design.lookup_sizes')!

  it('is 1.1.0, takes at most 5 sizes, and says to derive the rest of the proportions from them', () => {
    const t = lookup()
    expect(t.version).toBe('1.1.0')
    expect(t.input.safeParse({ subject: 'a suspension bridge', sizes: ['a b', 'c d', 'e f', 'g h', 'i j'] }).success).toBe(true)
    expect(t.input.safeParse({ subject: 'a suspension bridge', sizes: ['a b', 'c d', 'e f', 'g h', 'i j', 'k l'] }).success).toBe(false)
    expect(t.description).toContain('at most 5 sizes sources commonly publish')
  })

  it('reads the recorded answer end to end through the tool', async () => {
    const t = lookup()
    const ctx = { sessionId: 's1', web: async () => ({ text: RECORDED, citations: [] }) } as unknown as ToolContext
    const out = await t.run(t.input.parse({ subject: 'the subject', sizes: ASKED.slice(0, 5) }) as never, ctx)
    expect((out.output as { found: { size: string; mm: number }[] }).found.map((f) => [f.size, f.mm])).toEqual([['Overall length', 125700], ['Width (across)', 12600], ['Tower height above the roof', 17526]])
  })
})
