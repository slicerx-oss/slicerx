// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The full prompt asks mimir to say its steps before a request that needs three or more tools, and every prompt that
// builds parts turns down shapes the tools cannot make before building.
import { afterEach, describe, expect, it } from 'vitest'
import { setAssistantBrand } from '@slicerx/contracts'
import { ASSEMBLED_LINE, assembledLine, DISMISSED_LINE, FAMILY_LINE, local, MOVING_PARTS_LINE, MOVING_PARTS_ORDER, RESHAPE_LINE, SCOPE_LINE, systemPrompt, VOICE_HEADER } from '../src/prompt'
import type { KbSkill } from '../src/kb/kb'
import { playbooks } from '../skills/catalog'
import { turnSet, turnSetTools } from '../src/turnsets'

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
    expect(line).toBe('- When a request needs three or more tools, first send a short numbered list of the steps, marking with "needs your OK" only the steps that queue, start, send or change something; lookups and answers never need one. The list is a heads-up only: still work out every size the part needs, and take sizes from the person\'s things (from a lookup) before choosing a default.')
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

  /** Wishes about how a part will print or look, none of them a request to print or slice. */
  const WISHES = ['for easy printing', 'in four colors', 'and paint it to match', 'so it prints without supports', 'and make it look like the real thing']

  it('slices, targets and queues only on an ask to slice or print, never on a wish about how it prints', () => {
    for (const p of [systemPrompt('full'), systemPrompt('full', undefined, '', { cloud: true })]) {
      const line = lineWith(p, 'Print only when asked')
      expect(line).toContain('Call run.target, app.slice, slice or printer.queue only when the person asks to slice or print')
      expect(line).toContain('a wish about how it will print or look is not a request to print')
      // the rule stays general: no request's own words in the prompt
      for (const w of ['for easy printing', 'in four colors', 'paint it']) expect(line).not.toContain(w)
      // the job rule is for a print the person asked for, not any request with a part in it
      expect(lineWith(p, 'kb.intent')).toContain('For a print job the person asks for ("print 12 PETG brackets by Friday")')
    }
    // only the tools the model is offered are named
    const noTarget = lineWith(systemPrompt('full', (n) => n !== 'run.target' && n !== 'slice'), 'Print only when asked')
    expect(noTarget).toContain('Call app.slice or printer.queue only when')
    expect(noTarget).not.toContain('run.target')
  })

  it('a local turn asking for a part with a wish about how it prints or looks is a build turn, sent no slice, target or queue tool', () => {
    const tools = ['design.new', 'design.plan', 'geom.build', 'run.target', 'app.slice', 'slice', 'printer.queue'].map((name) => ({ name }))
    for (const part of ['design me a ship, nothing too detailed,', 'design a two color keychain tag that says SLICERX,', 'make a small toy rocket, red and white,']) {
      for (const wish of WISHES) {
        const message = `${part} ${wish}`
        const set = turnSet(message)
        expect(set, message).toBe('build')
        const sent = turnSetTools(tools, set).map((t) => t.name)
        for (const t of ['run.target', 'app.slice', 'slice', 'printer.queue']) expect(sent, message).not.toContain(t)
      }
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
    for (const s of ['outlines of lines, arcs, circles and splines', 'extruded or turned around one axis', 'lofted through sections (straight or smooth) or swept along a path', 'open sections thickened into shells', 'plus holes, fillets, patterns and text on them']) expect(SCOPE_LINE).toContain(s)
    // a sweep that narrows or turns is in scope too
    expect(SCOPE_LINE).toContain('can also taper, twist and have holes along it: a tube with its bore (it tapers with the outline), horn, tapering hook arm or duct reducer')
  })

  it('names the kinds of shape that are out of scope in general terms', () => {
    for (const s of ['living things', 'characters', 'body parts', 'likeness', 'sculpted forms that no series of sections describes', 'fit the curves of a body', 'even in one portion of a request']) expect(SCOPE_LINE).toContain(s)
    // lofts and sweeps have their own tools, so they are not turned down
    const out = SCOPE_LINE.slice(SCOPE_LINE.indexOf('Out of scope'), SCOPE_LINE.indexOf('For those'))
    expect(out).not.toMatch(/loft|swept|sweep|varies in shape/i)
    expect(systemPrompt()).toContain('geom.loft between profiles on several planes')
    expect(systemPrompt()).toContain('geom.sweep along a path')
    // curved hulls and shells of open curves are built, not turned down
    expect(systemPrompt()).toContain('(smooth for hulls, thicken for shells)')
    expect(out).not.toMatch(/organic|curving freely/i)
  })

  it('turns such a request down before any build or size question, with a buildable version offered', () => {
    expect(SCOPE_LINE).toContain('before any build call or size question')
    expect(SCOPE_LINE).toContain('offer the closest version they can')
    expect(SCOPE_LINE).toContain('only after the person says yes')
  })

  it('asks for sizes only once a version is picked, and lets the person turn a card of versions down', () => {
    expect(SCOPE_LINE).toContain('Ask for sizes only after the person picks a version')
    expect(SCOPE_LINE.indexOf('Ask for sizes only after')).toBeGreaterThan(SCOPE_LINE.indexOf('offer the closest version they can'))
    expect(SCOPE_LINE).toContain("always ends with a 'nothing for now' choice")
  })

  it('keeps a turned-down question card turned down: no choices or question in the reply, at most a narrower question', () => {
    expect(DISMISSED_LINE).toContain('pilot.ask gives back dismissed')
    expect(DISMISSED_LINE).toContain('all its choices are declined')
    expect(DISMISSED_LINE).toContain('Do not list them or put the same question in words, and do not ask it again')
    expect(DISMISSED_LINE).toContain('ask one different, narrower question')
    // words written in place of a pick answer the card: a person who takes the defaults is not turning it down
    expect(DISMISSED_LINE).toContain('Words written in place of a pick (said) answer the card and turn no choice down')
    expect(DISMISSED_LINE).toContain('when they leave it to you, take the choice that gives what the request asked for and go on without asking again')
    for (const scope of ['full', 'cad'] as const) expect(systemPrompt(scope)).toContain(DISMISSED_LINE)
    const noAsk = (name: string): boolean => name !== 'pilot.ask'
    expect(systemPrompt('cad', noAsk)).not.toContain(DISMISSED_LINE)
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

describe('the line for parts that move', () => {
  const all = (): boolean => true
  /** The cloud prompt less its cloud-only parts: the line for parts that move, the plan line's pointer to it, the line for a sweep that changes shape and the line for a family. */
  // the line for things made of colored parts names only the tools offered, so it is taken out by its start
  const asLocal = (cloud: string): string => cloud.replace(`\n${MOVING_PARTS_LINE}`, '').replace(MOVING_PARTS_ORDER, '').replace(`\n${RESHAPE_LINE}`, '').replace(`\n${FAMILY_LINE}`, '').replace(/\n- A thing made of parts in different colors[^\n]*/, '')

  it('is one line, in the cloud prompt only, after the check line', () => {
    expect(MOVING_PARTS_LINE).not.toContain('\n')
    expect(MOVING_PARTS_LINE).toContain('call design.plan with the moving pieces by name in printInPlace')
    expect(MOVING_PARTS_LINE).toContain('above and below')
    for (const scope of ['full', 'cad'] as const) {
      const cloud = systemPrompt(scope, all, '', { cloud: true })
      const local = systemPrompt(scope, all)
      expect(cloud.split(MOVING_PARTS_LINE)).toHaveLength(2)
      expect(cloud.indexOf(MOVING_PARTS_LINE)).toBeGreaterThan(cloud.indexOf('- After the last feature of a planned part, call design.check'))
      // the local prompt is the cloud one without the cloud-only parts, to the byte
      expect(local).not.toContain(MOVING_PARTS_LINE)
      expect(local).not.toContain(MOVING_PARTS_ORDER)
      expect(asLocal(cloud)).toBe(local)
      expect(systemPrompt(scope, all, '', { cloud: false })).toBe(local)
    }
  })

  it('measures the gaps with geom.fit_check on the part as built, before design.check, which asks for it', () => {
    const fit = MOVING_PARTS_LINE.indexOf('run geom.fit_check on the design')
    expect(fit).toBeGreaterThan(MOVING_PARTS_LINE.indexOf('build each piece as its own body'))
    expect(MOVING_PARTS_LINE.indexOf('design.check', fit)).toBeGreaterThan(fit)
    expect(MOVING_PARTS_LINE).toContain('fix any gap it flags')
  })

  it('names jointed, articulated and flexi parts, and a simpler version offered in place of a creature', () => {
    expect(MOVING_PARTS_LINE).toContain('(a hinge, chain, gears, jointed, articulated or flexi segments, including a simpler version offered in place of a creature)')
  })

  it('plans a part that moves before its sheet in the cloud prompt, and keeps the sheet first for other parts', () => {
    for (const scope of ['full', 'cad'] as const) {
      const cloud = systemPrompt(scope, all, '', { cloud: true })
      const planLine = cloud.split('\n').find((l) => l.includes('call design.plan with the part'))!
      // other parts keep the sheet first, then the plan
      expect(planLine).toMatch(/first the sheet, with the sizes that depend on the person's own things asked for and confirmed on it as above; then/)
      // the plan line ends by pointing at the line for parts that move, which comes after it
      expect(planLine.endsWith(MOVING_PARTS_ORDER)).toBe(true)
      expect(cloud.indexOf(MOVING_PARTS_LINE)).toBeGreaterThan(cloud.indexOf(planLine))
      // in that line the plan names the moving pieces before the sheet that fills in their gaps
      const plan = MOVING_PARTS_LINE.indexOf('call design.plan')
      const sheet = MOVING_PARTS_LINE.indexOf('then show the sizes on a sheet')
      expect(MOVING_PARTS_LINE).toContain('the plan comes first and the sheet after it')
      expect(plan).toBeGreaterThan(-1)
      expect(sheet).toBeGreaterThan(plan)
      // the local plan line keeps the sheet first with no exception
      expect(systemPrompt(scope, all)).not.toContain('planned before its sheet')
    }
  })

  it('is left out without design.plan or design.check, and so is the plan line pointer', () => {
    for (const has of [(n: string) => n !== 'design.check', (n: string) => n !== 'design.plan']) {
      const cloud = systemPrompt('full', has, '', { cloud: true })
      expect(cloud).not.toContain(MOVING_PARTS_LINE)
      expect(cloud).not.toContain(MOVING_PARTS_ORDER)
      expect(asLocal(cloud)).toBe(systemPrompt('full', has))
    }
  })
})

describe('the line for a part that fits a family', () => {
  it('is one line in the cloud prompt only, right after the sizes line, and only with pilot.ask and parts.lookup', () => {
    expect(FAMILY_LINE).not.toContain('\n')
    for (const scope of ['full', 'cad'] as const) {
      const cloud = systemPrompt(scope, () => true, '', { cloud: true })
      expect(cloud.split(FAMILY_LINE)).toHaveLength(2)
      const lines = cloud.split('\n')
      expect(lines[lines.indexOf(FAMILY_LINE) - 1]).toMatch(/^- Sizes come from the request/)
      expect(systemPrompt(scope, () => true)).not.toContain(FAMILY_LINE)
      expect(systemPrompt(scope, (n) => n !== 'pilot.ask', '', { cloud: true })).not.toContain(FAMILY_LINE)
      expect(systemPrompt(scope, (n) => n !== 'parts.lookup', '', { cloud: true })).not.toContain(FAMILY_LINE)
    }
  })

  it('asks for the model before any sheet, or names the one assumed with an offer to change it, then uses its published sizes', () => {
    expect(FAMILY_LINE).toContain('needs the model before any sheet: ask which one with pilot.ask')
    expect(FAMILY_LINE).toContain('name it in your reply before the sheet and offer to change it')
    expect(FAMILY_LINE).toContain("that model's published sizes (parts.lookup, else web.lookup)")
    expect(FAMILY_LINE).toContain('never generic guesses for the family')
    for (const family of ['a Raspberry Pi', 'a phone', 'a GoPro', 'a NEMA motor', 'a filament spool']) expect(FAMILY_LINE).toContain(family)
  })
})

describe('the line for a sweep that changes shape', () => {
  it('is one line in the cloud prompt only, and only with geom.sweep', () => {
    expect(RESHAPE_LINE).not.toContain('\n')
    expect(RESHAPE_LINE).toContain('one geom.sweep with end_profile')
    expect(RESHAPE_LINE).toContain('rather than a loft joined to a separate bend')
    const cloud = systemPrompt('cad', () => true, '', { cloud: true })
    expect(cloud.split(RESHAPE_LINE)).toHaveLength(2)
    expect(systemPrompt('cad', () => true)).not.toContain(RESHAPE_LINE)
    expect(systemPrompt('cad', (n) => n !== 'geom.sweep', '', { cloud: true })).not.toContain(RESHAPE_LINE)
  })
})

describe('a thing made of colored parts', () => {
  const cloud = (has?: (n: string) => boolean) => systemPrompt('full', has, '', { cloud: true })
  const line = (p: string) => p.split('\n').find((l) => l.includes('parts in different colors')) ?? ''

  it('is built assembled in one design, one part per color, and never split or laid out unasked', () => {
    const l = line(cloud())
    expect(l).toContain('is one design, built assembled as it looks finished')
    expect(l).toContain('one part per color, each on the filament of its color (slot on geom.build)')
    expect(l).toContain('never a kit of pieces laid apart')
    expect(l).toContain('Plan and check it as that one assembled model')
    expect(l).toContain('Do not split it into objects or lay its parts out on the plate unless the person asks for that')
    // it comes after the plan line and before the check, as the model meets them building
    const p = cloud()
    expect(p.indexOf(l)).toBeGreaterThan(p.indexOf('Every new part shows its sizes on the dimension sheet first'))
    expect(p.indexOf(l)).toBeLessThan(p.indexOf('After the last feature of a planned part, call design.check'))
  })

  it('names the filament and split tools only when the model is offered them', () => {
    // today's tab has neither: the line still reads whole, in plain words
    const today = line(cloud((n) => n !== 'project.set_filament' && n !== 'project.split_objects'))
    expect(today).not.toContain('project.')
    expect(today.endsWith('unless the person asks for that.')).toBe(true)
    const both = line(cloud())
    expect(both).toContain("Set those filaments' colors with project.set_filament.")
    expect(both.endsWith('unless the person asks for that (then project.split_objects).')).toBe(true)
    expect(assembledLine(() => false)).toBe(ASSEMBLED_LINE)
  })

  it('is in the cloud prompt only, and only with design.plan', () => {
    expect(systemPrompt('full')).not.toContain('parts in different colors')
    expect(cloud((n) => n !== 'design.plan')).not.toContain('parts in different colors')
    expect(systemPrompt('cad', undefined, '', { cloud: true })).toContain('parts in different colors')
  })
})

describe('the lines a local model gets', () => {
  it('are only the lines marked local: the cloud prompt less its cloud-only lines and the plan line pointer', () => {
    for (const scope of ['full', 'cad'] as const) {
      const cloud = systemPrompt(scope, () => true, '', { cloud: true }).split('\n')
      const local = systemPrompt(scope, () => true).split('\n')
      const cloudOnly = new Set([FAMILY_LINE, MOVING_PARTS_LINE, RESHAPE_LINE, assembledLine(() => true)])
      // every local line is a cloud line, in the same order, the plan line less its pointer to the moving parts line
      expect(cloud.filter((l) => !cloudOnly.has(l)).map((l) => l.replace(MOVING_PARTS_ORDER, ''))).toEqual(local)
      expect(cloud.filter((l) => cloudOnly.has(l))).toHaveLength(4)
    }
  })

  it('leaves a line out of the local prompt unless it is marked local, and the marked text is sent as it is', () => {
    expect(local('- A line.')).toEqual({ local: '- A line.' })
    // nothing unmarked: the cloud-only lines are plain strings in prompt.ts, and none of them reaches a local turn
    for (const line of [FAMILY_LINE, MOVING_PARTS_LINE, RESHAPE_LINE, MOVING_PARTS_ORDER.trim()]) expect(systemPrompt('full', () => true), line.slice(0, 40)).not.toContain(line)
  })
})
