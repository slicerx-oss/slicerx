// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The full prompt asks mimir to say its steps before a request that needs three or more tools, and every prompt that
// builds parts turns down shapes the tools cannot make before building.
import { afterEach, describe, expect, it } from 'vitest'
import { setAssistantBrand } from '@slicerx/contracts'
import { SCOPE_LINE, systemPrompt, VOICE_HEADER } from '../src/prompt'
import type { KbSkill } from '../src/kb/kb'
import { playbooks } from '../skills/catalog'

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

describe('the scope rule for parts', () => {
  // the design tools (mimir tab), the part generator (chat without them), and both app scopes
  const design = (n: string) => n !== 'text_to_part' && n !== 'make_model'
  const generator = (n: string) => !n.startsWith('design.') && !n.startsWith('geom.')
  const prompts = (): [string, string][] => [
    ['full, design tools', systemPrompt('full', design)],
    ['full, part generator', systemPrompt('full', generator)],
    ['cad, design tools', systemPrompt('cad', design)],
    ['cad, part generator', systemPrompt('cad', generator)],
  ]
  /** The prompt line that holds the scope rule. */
  const scopeLine = (p: string): string => p.split('\n').find((l) => l.startsWith('- Build only shapes the tools can make')) ?? ''

  it('every prompt that builds parts carries it once', () => {
    for (const [name, p] of prompts()) {
      expect(scopeLine(p), name).not.toBe('')
      expect(p.split('\n').filter((l) => l === scopeLine(p)), name).toHaveLength(1)
      expect(scopeLine(p), name).toBe(SCOPE_LINE)
    }
  })

  it('comes before the first build instruction', () => {
    for (const [name, p] of prompts()) {
      const build = Math.min(...['goes straight to text_to_part', 'goes straight to the design tools'].map((s) => p.indexOf(s)).filter((i) => i >= 0))
      expect(p.indexOf(SCOPE_LINE), name).toBeGreaterThan(-1)
      expect(p.indexOf(SCOPE_LINE), name).toBeLessThan(build)
    }
  })

  it('names what is in scope in general terms', () => {
    for (const s of ['outlines of lines, arcs and circles', 'extruded or turned around one axis', 'plus holes, fillets, patterns and text on them']) expect(SCOPE_LINE).toContain(s)
  })

  it('names the kinds of shape that are out of scope in general terms', () => {
    for (const s of ['living things', 'characters', 'body parts', 'likeness', 'sculpted or organic', 'curving freely in two directions', 'fit the curves of a body', 'varies in shape, size or angle along the part', 'loft', 'swept along a curved path', 'even in one portion of a request']) expect(SCOPE_LINE).toContain(s)
  })

  it('turns such a request down before any build or size question, with a buildable version offered', () => {
    expect(SCOPE_LINE).toContain('before any build call or size question')
    expect(SCOPE_LINE).toContain('offer the closest version they can')
    expect(SCOPE_LINE).toContain('only after the person says yes')
  })

  it('keeps build the rest for a small missing feature only, after the out of scope shapes', () => {
    expect(SCOPE_LINE).toContain('If only a small feature is missing')
    expect(SCOPE_LINE.indexOf('build the rest')).toBeGreaterThan(SCOPE_LINE.indexOf('Out of scope'))
    for (const [name, p] of prompts()) {
      expect(p, name).not.toContain('curved shells')
      // the scope line is the only one that says to build the rest
      expect(p.split('\n').filter((l) => l.includes('build the rest')), name).toEqual([SCOPE_LINE])
    }
  })

  it('is general: no sizes, part numbers or brand names', () => {
    // no digits, and no capital letter except at the start of a sentence and the app's own Model tab
    expect(SCOPE_LINE).not.toMatch(/\d/)
    const capitals = SCOPE_LINE.slice(2).split(/(?<=[.:])\s+/).flatMap((s) => s.split(' ').slice(1)).filter((w) => /[A-Z]/.test(w) && w !== 'Model.')
    expect(capitals).toEqual([])
  })
})

describe('the skill playbooks in the prompt', () => {
  const skill = (id: string, approval: string): KbSkill => ({ id, name: id, priority: 1, purpose: `Purpose of ${id}.`, inputs: [], outputs: [], tools: [], approval, example: '' })

  it('lists a skill with its tools, and its approval unless it only reads', () => {
    const p = playbooks([skill('calibrate', 'profile'), skill('diagnose', 'read')])
    expect(p).toContain('- calibrate: Purpose of calibrate. Tools: calibrate, kb.workflow, printer.queue, settings.apply. Approval: profile.')
    expect(p.endsWith('\n- diagnose: Purpose of diagnose. Tools: diagnose, kb.troubleshoot, printer.status.')).toBe(true)
    expect(p).not.toContain('Approval: read')
  })

  it('leaves out a skill whose only tool is itself, since that tool describes itself', () => {
    const p = playbooks([skill('text_to_part', 'slice'), skill('compare_setups', 'slice'), skill('queue_control', 'start')])
    expect(p).not.toContain('text_to_part')
    expect(p).not.toContain('compare_setups')
    expect(p).toContain('- queue_control:')
    expect(playbooks([skill('text_to_part', 'slice')])).toBe('')
  })
})
