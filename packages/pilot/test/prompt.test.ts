// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The full prompt asks mimir to say its steps before a request that needs three or more tools.
import { afterEach, describe, expect, it } from 'vitest'
import { setAssistantBrand } from '@slicerx/contracts'
import { systemPrompt, VOICE_HEADER } from '../src/prompt'

afterEach(() => setAssistantBrand())

describe('the step list in the full prompt', () => {
  it('the full prompt asks for a step list on multi-tool requests', () => {
    const p = systemPrompt('full')
    expect(p).toContain('Multi-step requests:')
    expect(p).toContain('needs three or more tools')
    expect(p).toContain('numbered list of the steps')
    expect(p).toContain('"needs your OK"')
    // the list is a heads-up: it never stands in for working out a part's sizes
    expect(p).toContain('The list is a heads-up only: still work out every size the part needs')
    expect(p).toContain("take sizes from the person's things (from a lookup) before choosing a default")
    const line = p.split('\n').find((l) => l.includes('needs three or more tools'))!
    expect(line).toBe('- When a request needs three or more tools, first send a short numbered list of the steps, marking the ones that need approval with "needs your OK". The list is a heads-up only: still work out every size the part needs, and take sizes from the person\'s things (from a lookup) before choosing a default.')
  })

  it('sits after the approval rules and before the untrusted data block', () => {
    const p = systemPrompt('full')
    const at = p.indexOf('Multi-step requests:')
    expect(at).toBeGreaterThan(p.indexOf('Permissions and approvals:'))
    expect(at).toBeLessThan(p.indexOf('Untrusted data:'))
  })

  it('leaves the cad prompt without it, with or without the design tools', () => {
    expect(systemPrompt('cad')).not.toContain('Multi-step requests:')
    expect(systemPrompt('cad', (n) => !n.startsWith('design.'))).not.toContain('Multi-step requests:')
    // the whole app keeps it when the mimir tab gives the design tools
    expect(systemPrompt('full', (n) => n.startsWith('design.') || n.startsWith('geom.'))).toContain('Multi-step requests:')
  })

  it('keeps an edition voice as the very last thing', () => {
    setAssistantBrand({ voice: 'Plain and brief.' })
    const p = systemPrompt('full')
    expect(p.endsWith(`\n\n${VOICE_HEADER}\nPlain and brief.`)).toBe(true)
    expect(p.indexOf('Multi-step requests:')).toBeLessThan(p.indexOf(VOICE_HEADER))
  })
})
