// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir names the app as the edition does, in its prompt and in the setup tools' text.
import { setProductName } from '@slicerx/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createSetupTools } from '../skills/printer_setup/index'
import { systemPrompt } from '../src/prompt'

afterEach(() => setProductName('SlicerX'))

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
})
