// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir names the app as the edition does, in its prompt, in the setup tools' text and in make_model's brand colors.
import { setProductColors, setProductName } from '@slicerx/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { brandColors, resolveColor } from '../skills/make_model/colors'
import { createMakeModel } from '../skills/make_model/index'
import { createSetupTools } from '../skills/printer_setup/index'
import { systemPrompt } from '../src/prompt'
import { toolSpec } from '../src/tool'

afterEach(() => {
  setProductName('SlicerX')
  setProductColors(undefined)
})

/** make_model as a client sees it: its description and input schema. */
const makeModelText = (): string => {
  const spec = toolSpec(createMakeModel())
  return JSON.stringify([spec.description, spec.inputSchema])
}

/** What may still say SlicerX in make_model: the X mark, a shape it draws. */
const leftover = (s: string) => s.replace(/the SlicerX (X|mark)\b|is the SlicerX X/g, '').match(/.{0,40}SlicerX.{0,40}/g) ?? []

describe('a white-label edition', () => {
  it('is the app mimir works inside', () => {
    expect(systemPrompt()).toContain('the agent inside SlicerX')
    setProductName('Acme Slicer')
    expect(systemPrompt()).toContain('the agent inside Acme Slicer')
    expect(systemPrompt()).not.toMatch(/SlicerX/)
    const setup = JSON.stringify(createSetupTools().map((t) => [t.title, t.description]))
    expect(setup).toContain('Acme Slicer')
    expect(setup).not.toMatch(/SlicerX/)
  })

  it('keeps the SlicerX edition\'s brand color names for make_model', () => {
    // The names the tool took before the colors came from the edition config, unchanged.
    expect(brandColors()).toEqual({
      'slicerx black': { hex: '#17181f', label: 'SlicerX black' },
      'slicerx ink': { hex: '#17181f', label: 'SlicerX black' },
      'slicerx white': { hex: '#f8f8f2', label: 'SlicerX white' },
      'slicerx purple': { hex: '#bd93f9', label: 'SlicerX purple' },
      'x purple': { hex: '#bd93f9', label: 'SlicerX purple' },
      'slicerx pink': { hex: '#ff79c6', label: 'X pink' },
      'x pink': { hex: '#ff79c6', label: 'X pink' },
      'slicerx cyan': { hex: '#8be9fd', label: 'SlicerX cyan' },
      'slicerx green': { hex: '#50fa7b', label: 'SlicerX green' },
      'slicerx orange': { hex: '#ffb86c', label: 'SlicerX orange' },
      'slicerx yellow': { hex: '#f1fa8c', label: 'SlicerX yellow' },
      'slicerx red': { hex: '#ff5555', label: 'SlicerX red' },
    })
    expect(resolveColor('SlicerX  Black')).toEqual({ hex: '#17181f', label: 'SlicerX black' })
    expect(makeModelText()).toContain('a brand name such as \\"SlicerX black\\" or \\"X pink\\"')
    expect(makeModelText()).toContain('The SlicerX logo is the X mark')
  })

  it('offers make_model SlicerX\'s kit colors under its own name when its config has no brand colors', () => {
    setProductName('Acme Slicer')
    expect(resolveColor('Acme Slicer black')).toEqual({ hex: '#17181f', label: 'Acme Slicer black' })
    expect(resolveColor('acme slicer pink')).toEqual({ hex: '#ff79c6', label: 'Acme Slicer pink' })
    expect(resolveColor('SlicerX black')).toBeNull()
    expect(resolveColor('X pink')).toBeNull()
    const text = makeModelText()
    expect(text).toContain('a brand name such as \\"Acme Slicer black\\" or \\"Acme Slicer pink\\"')
    expect(text).not.toContain('logo is the X mark')
    expect(leftover(text)).toEqual([])
  })

  it('takes make_model\'s brand colors from the edition config', () => {
    setProductName('Acme Slicer')
    setProductColors({ black: '#101010', orange: '#ff6600' })
    expect(resolveColor('Acme Slicer orange')).toEqual({ hex: '#ff6600', label: 'Acme Slicer orange' })
    expect(resolveColor('Acme Slicer black')).toEqual({ hex: '#101010', label: 'Acme Slicer black' })
    expect(resolveColor('Acme Slicer pink')).toBeNull()
    // plain names and hex still work
    expect(resolveColor('blue')?.hex).toMatch(/^#[0-9a-f]{6}$/)
    expect(makeModelText()).toContain('\\"Acme Slicer black\\" or \\"Acme Slicer orange\\"')
    expect(leftover(makeModelText())).toEqual([])
  })
})
