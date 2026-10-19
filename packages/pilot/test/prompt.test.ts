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
    expect(p).toContain('queue, start a print, change settings')
    expect(p).toContain('Skip the list when one or two tools are enough.')
  })

  it('sits after the approval rules and before the untrusted data block', () => {
    const p = systemPrompt('full')
    const at = p.indexOf('Multi-step requests:')
    expect(at).toBeGreaterThan(p.indexOf('Permissions and approvals:'))
    expect(at).toBeLessThan(p.indexOf('Untrusted data:'))
  })

  it('leaves the cad and design prompts without it', () => {
    expect(systemPrompt('cad')).not.toContain('Multi-step requests:')
    expect(systemPrompt('design')).not.toContain('Multi-step requests:')
  })

  it('keeps an edition voice as the very last thing', () => {
    setAssistantBrand({ voice: 'Plain and brief.' })
    const p = systemPrompt('full')
    expect(p.endsWith(`\n\n${VOICE_HEADER}\nPlain and brief.`)).toBe(true)
    expect(p.indexOf('Multi-step requests:')).toBeLessThan(p.indexOf(VOICE_HEADER))
  })
})
