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

describe('the print run in the full prompt', () => {
  /** The prompt line that names `tool`. */
  const lineWith = (p: string, tool: string): string => p.split('\n').find((l) => l.includes(tool)) ?? ''

  it('the full prompt orders target, slice and send', () => {
    const p = systemPrompt('full')
    const line = lineWith(p, 'run.target')
    expect(line).toContain('make and print')
    // design first, then the printer and spool, the slice and the send
    const at = (s: string) => line.indexOf(s)
    expect(at('design')).toBeGreaterThan(-1)
    expect(at('design')).toBeLessThan(at('run.target'))
    expect(at('run.target')).toBeLessThan(at('app.slice'))
    expect(at('app.slice')).toBeLessThan(at('printer.queue'))
    expect(line).toContain('step list first')
    // a pick on the card is offered once to be remembered, and the chip asks
    const remember = lineWith(p, 'memory.remember')
    expect(remember).toContain('offer once')
    expect(remember).toContain('picked')
    // without the memory tool there is nothing to offer
    expect(systemPrompt('full', (n) => n !== 'memory.remember')).not.toContain('memory.remember')
  })

  it('the prompt forbids sending a stale slice', () => {
    const p = systemPrompt('full')
    const line = lineWith(p, 'stale slice')
    expect(line).toContain('Never call printer.queue with a stale slice')
    expect(line).toContain('slice again')
    expect(line).toContain('"use 0.2 mm layers"')
    expect(line).toContain('"on the P1S instead"')
  })

  it('a request to make a part, without asking to print it, ends with the part', () => {
    for (const p of [systemPrompt('full'), systemPrompt('full', (n) => !n.startsWith('printer.') && n !== 'run.target')]) {
      const line = lineWith(p, 'Print only when asked')
      expect(line).toContain('a part alone ends with the part')
    }
  })

  it('no printer tools, no send step in the prompt', () => {
    const p = systemPrompt('full', (n) => !n.startsWith('printer.') && n !== 'run.target')
    expect(p).not.toContain('printer.queue')
    expect(p).not.toContain('run.target')
    expect(p).not.toContain('stale slice')
    const line = lineWith(p, 'make and print')
    expect(line).toContain('app.slice')
    expect(line).toContain('offer to save the file')
    // the cad prompt has no print run at all
    expect(systemPrompt('cad')).not.toContain('make and print')
  })
})
