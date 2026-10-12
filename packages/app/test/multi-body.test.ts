// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A file of several bodies: regrouped into one object with parts or an object per body, the question asked only while
// the app shows and only for more than one body, and a remembered answer becoming the setting.
import { afterEach, describe, expect, it } from 'vitest'
import { answerMultiBody, bodyCount, enableMultiBodyPrompt, multiBodyChoice, regroup, severalShells, type BodyEntry } from '../src/state/multi-body'
import { get, set } from '../src/state/store'

const entry = (name: string, parts: string[]): BodyEntry => ({ name, parts: parts.map((p) => ({ name: p })), colors: parts.map(() => '#ffffff'), transform: [1], perShell: true })

describe('regroup', () => {
  const made = [entry('gear 1', ['gear 1']), entry('gear 2', ['gear 2 part 1', 'gear 2 part 2'])]

  it('counts bodies across objects', () => {
    expect(bodyCount(made)).toBe(3)
  })

  it('puts every body in one object named after the file', () => {
    const one = regroup(made, 'parts', 'gear')
    expect(one).toHaveLength(1)
    expect(one[0]!.name).toBe('gear')
    expect(one[0]!.parts.map((p) => p.name)).toEqual(['gear 1', 'gear 2 part 1', 'gear 2 part 2'])
    expect(one[0]!.colors).toHaveLength(3)
  })

  it('makes an object of every body', () => {
    const each = regroup(made, 'objects', 'gear')
    expect(each.map((e) => e.name)).toEqual(['gear 1', 'gear 2 part 1', 'gear 2 part 2'])
    expect(each.every((e) => e.parts.length === 1 && e.colors.length === 1)).toBe(true)
  })
})

describe('the question', () => {
  let off: () => void = () => undefined
  afterEach(() => {
    off()
    set({ multiBodyImport: 'ask', multiBodyPrompt: null })
  })

  it('never asks for one body, and keeps the grouping with no app to ask in', async () => {
    set({ multiBodyImport: 'ask' })
    expect(await multiBodyChoice('one', 1)).toBeNull()
    expect(await multiBodyChoice('two', 2)).toBeNull()
    expect(get().multiBodyPrompt).toBeNull()
  })

  it('follows the setting without asking', async () => {
    off = enableMultiBodyPrompt()
    set({ multiBodyImport: 'objects' })
    expect(await multiBodyChoice('two', 2)).toBe('objects')
    expect(get().multiBodyPrompt).toBeNull()
  })

  it('asks, and a remembered answer becomes the setting', async () => {
    off = enableMultiBodyPrompt()
    const asked = multiBodyChoice('two', 2)
    expect(get().multiBodyPrompt).toEqual({ name: 'two', bodies: 2 })
    answerMultiBody('parts', true)
    expect(await asked).toBe('parts')
    expect(get().multiBodyImport).toBe('parts')
    expect(get().multiBodyPrompt).toBeNull()
  })

  it('an answer not remembered leaves the setting at ask', async () => {
    off = enableMultiBodyPrompt()
    const asked = multiBodyChoice('two', 2)
    answerMultiBody('objects')
    expect(await asked).toBe('objects')
    expect(get().multiBodyImport).toBe('ask')
  })
})

describe('severalShells', () => {
  it('tells one connected shell from two', () => {
    // two triangles sharing an edge, then two triangles apart
    expect(severalShells([0, 1, 2, 1, 3, 2], 4)).toBe(false)
    expect(severalShells([0, 1, 2, 3, 4, 5], 6)).toBe(true)
  })
})
