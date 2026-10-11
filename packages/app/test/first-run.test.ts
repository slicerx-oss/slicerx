// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { resolvePreset } from '@slicerx/ui'
import { controlsFor, withControlOverrides } from '../src/first-run/controls'
import { effectiveMode, orderWorkspaces } from '../src/first-run/look'
import { choose, initialFlow, normalizeStep, ONBOARDING_VERSION, onboardingRerun, outcome, progress, reduceFlow, setupSteps, STEP_SINCE, stepLabel, type FlowEvent, type FlowState, type SetupPrinter } from '../src/first-run/model'
import { EMPTY_FORM, pickModel, skipForm } from '../src/first-run/printer-form'
import { adoptFound, matchFound } from '../src/first-run/printer-step'
import { importPresetFile } from '../src/first-run/preset-import'
import { createGuidePilot } from '../src/first-run/pilot-adapter'

const run = (s: FlowState, ...events: FlowEvent[]) => events.reduce(reduceFlow, s)
const NOW = '2026-09-30T12:00:00.000Z'
const printer: SetupPrinter = { printerId: 'bay-1', brand: 'Bambu Lab', model: 'X1 Carbon', nozzle: '0.4 mm brass', connection: 'Bambu Lab LAN', state: 'verified', filamentSystem: 'AMS, 1 unit, 4 slots' }

describe('setup flow', () => {
  it('walks printer, slicer and records completion', () => {
    const s = run(initialFlow('printer', { id: 'slicerx' }), { type: 'printer-saved', printer }, { type: 'finish' })
    expect(s.step).toBe('look')
    expect(s.closed).toBe('finished')
    const o = outcome(s, NOW, null)
    expect(o.firstRun).toEqual({ completedAt: NOW, step: 'done', look: { id: 'slicerx' }, printerId: 'bay-1', version: ONBOARDING_VERSION })
    expect(o.printerId).toBe('bay-1')
  })

  it('Next on the last screen finishes', () => {
    const s = run(initialFlow('printer', { id: 'slicerx' }), { type: 'no-printer' }, { type: 'pick-look', look: { id: 'orcaslicer' } }, { type: 'next' })
    expect(s.closed).toBe('finished')
    expect(outcome(s, NOW, null)).toMatchObject({ printerId: null, look: { id: 'orcaslicer' } })
  })

  it('Skip, use defaults finishes with no printer', () => {
    const s = run(initialFlow('printer', { id: 'slicerx' }), { type: 'skip-all' })
    expect(s.closed).toBe('finished')
    expect(outcome(s, NOW, null)).toMatchObject({ printerId: null, firstRun: { completedAt: NOW, printerId: null } })
  })

  it('Skip, use defaults stops the launch printer ask, unless a printer is already set up', () => {
    const s = run(initialFlow('theme', { id: 'slicerx' }), { type: 'skip-all' })
    expect(outcome(s, NOW, null).noPrinter).toBe(true)
    expect(outcome(s, NOW, { completedAt: NOW, step: 'done', look: { id: 'slicerx' }, printerId: 'bay-1' }).noPrinter).toBeUndefined()
    // Finishing the steps without a printer keeps asking: only an explicit no-printer answer stops it.
    const done = run(initialFlow('printer', { id: 'slicerx' }), { type: 'skip' })
    expect(outcome(done, NOW, null).noPrinter).toBeUndefined()
  })

  it('Back from the slicer screen restores the look it opened with and keeps the printer', () => {
    let s = run(initialFlow('printer', { id: 'slicerx' }), { type: 'printer-saved', printer })
    s = run(s, { type: 'pick-look', look: { id: 'prusaslicer' } })
    expect(s.look.id).toBe('prusaslicer')
    s = run(s, { type: 'back' })
    expect(s.step).toBe('printer')
    expect(s.look.id).toBe('slicerx')
    expect(s.lookPicked).toBe(false)
    expect(s.printer).toEqual(printer)
  })

  it('skipping the printer lands on the slicer screen without one', () => {
    const s = run(initialFlow('printer', { id: 'slicerx' }), { type: 'skip' })
    expect(s.step).toBe('look')
    expect(s.printer).toBeNull()
  })

  it('Escape asks first; Stay keeps the flow open', () => {
    let s = run(initialFlow('look', { id: 'slicerx' }), { type: 'request-leave' })
    expect(s.confirmLeave).toBe(true)
    s = run(s, { type: 'stay' })
    expect(s.confirmLeave).toBe(false)
    expect(s.closed).toBeNull()
  })

  it('leaving keeps a picked look and writes no completion or printer', () => {
    const s = run(initialFlow('printer', { id: 'slicerx' }), { type: 'skip' }, { type: 'pick-look', look: { id: 'bambu-studio' } }, { type: 'request-leave' }, { type: 'leave' })
    const o = outcome(s, NOW, null)
    expect(o.look).toEqual({ id: 'bambu-studio' })
    expect(o.printerId).toBeNull()
    expect(o.firstRun.completedAt).toBeNull()
    expect(o.firstRun.step).toBe('look')
  })

  it('leaving without a pick writes no look', () => {
    const s = run(initialFlow('printer', { id: 'slicerx' }), { type: 'skip' }, { type: 'leave' })
    expect(outcome(s, NOW, null).look).toBeNull()
  })

  it('leaving a re-run keeps the earlier completion', () => {
    const prior = { completedAt: '2026-09-01T00:00:00.000Z', step: 'done' as const, look: { id: 'slicerx' as const }, printerId: 'bay-2' }
    const s = run(initialFlow('look', { id: 'slicerx' }), { type: 'leave' })
    expect(outcome(s, NOW, prior).firstRun).toMatchObject({ completedAt: prior.completedAt, printerId: 'bay-2' })
  })

  it('ignores events after it closed', () => {
    const s = run(initialFlow('printer', { id: 'slicerx' }), { type: 'skip-all' })
    expect(run(s, { type: 'next' })).toBe(s)
  })

  it('labels steps and progress, and maps old step names onto the first screen', () => {
    expect(stepLabel('theme')).toEqual({ index: 1, total: 3, text: 'Step 1 of 3, Theme' })
    expect(stepLabel('printer').text).toBe('Step 2 of 3, Printer')
    expect(stepLabel('look').text).toBe('Step 3 of 3, Your slicer')
    expect(progress('theme')).toBeCloseTo(1 / 3)
    expect(progress('look')).toBe(1)
    expect(normalizeStep('welcome')).toBe('theme')
    expect(normalizeStep('cad')).toBe('theme')
    expect(normalizeStep('done')).toBe('theme')
    expect(normalizeStep('printer')).toBe('printer')
    expect(normalizeStep('look')).toBe('look')
  })

  it('opens on the theme and walks on to the printer', () => {
    const s = initialFlow('theme', { id: 'slicerx' })
    expect(s.step).toBe('theme')
    const next = run(s, { type: 'next' })
    expect(next.step).toBe('printer')
    expect(run(next, { type: 'back' }).step).toBe('theme')
  })

  it('switching presets keeps control overrides', () => {
    const c = withControlOverrides({ id: 'slicerx' }, { invert: true })
    expect(choose('prusaslicer', c)).toEqual({ id: 'prusaslicer', overrides: { controls: { invert: true } } })
    expect(withControlOverrides(c, {})).toEqual({ id: 'slicerx' })
  })
})

describe('onboarding version', () => {
  const done = (version?: number) => ({ completedAt: NOW, step: 'done' as const, look: { id: 'slicerx' as const }, printerId: 'bay-1', ...(version !== undefined ? { version } : {}) })

  it('runs everything again before beta when the stored version is older', () => {
    expect(onboardingRerun('pre-alpha', done())).toEqual({})
    expect(onboardingRerun('alpha', done(1))).toEqual({})
    expect(onboardingRerun('pre-alpha', done(ONBOARDING_VERSION))).toBeNull()
    expect(onboardingRerun('alpha', done(ONBOARDING_VERSION + 1))).toBeNull()
  })

  it('shows only the new steps after alpha', () => {
    expect(onboardingRerun('beta', done(1))).toEqual({ since: 1 })
    expect(onboardingRerun('stable', done())).toEqual({ since: 1 })
    expect(onboardingRerun('stable', done(ONBOARDING_VERSION))).toBeNull()
    expect(setupSteps({ cad: true, mimir: true, since: 1 })).toEqual(['theme', 'look', 'open'])
    expect(setupSteps({ cad: false, mimir: false, since: 1 })).toEqual(['theme', 'look'])
    // nothing newer: the whole flow, never an empty one
    expect(setupSteps({ cad: false, mimir: false, since: ONBOARDING_VERSION })).toEqual(['theme', 'printer', 'look'])
  })

  it('the settings mode question: a version 2 record reruns all of setup in alpha and only the slicer step after', () => {
    expect(onboardingRerun('alpha', done(2))).toEqual({})
    expect(onboardingRerun('beta', done(2))).toEqual({ since: 2 })
    expect(setupSteps({ cad: true, mimir: true, since: 2 })).toEqual(['look'])
    expect(setupSteps({ cad: false, mimir: false, since: 2 })).toEqual(['look'])
  })

  it('a fresh install has no record and opens setup the usual way', () => {
    expect(onboardingRerun('pre-alpha', null)).toBeNull()
  })

  it('every step has the version it arrived in, none newer than the current one', () => {
    for (const v of Object.values(STEP_SINCE)) expect(v).toBeLessThanOrEqual(ONBOARDING_VERSION)
    expect(Math.max(...Object.values(STEP_SINCE))).toBe(ONBOARDING_VERSION)
  })

  it('finishing or leaving records the current version, so the rerun does not come back', () => {
    const fin = run(initialFlow('theme', { id: 'slicerx' }), { type: 'skip-all' })
    expect(outcome(fin, NOW, done(1)).firstRun.version).toBe(ONBOARDING_VERSION)
    const left = run(initialFlow('theme', { id: 'slicerx' }), { type: 'leave' })
    expect(outcome(left, NOW, done(1)).firstRun).toMatchObject({ version: ONBOARDING_VERSION, completedAt: NOW, printerId: 'bay-1' })
  })

  it('a rerun prefilled from the settings keeps them when skipped through', () => {
    // the flow starts from the stored look and open choice; nothing in it resets the printer
    const s = run(initialFlow('theme', { id: 'bambu-studio' }, null, setupSteps({ cad: true, mimir: false }), 'design'), { type: 'next' }, { type: 'skip' }, { type: 'next' }, { type: 'next' })
    expect(s.closed).toBe('finished')
    const o = outcome(s, NOW, done(1))
    expect(o.look).toEqual({ id: 'bambu-studio' })
    expect(o.openIn).toBe('design')
    expect(o.printerId).toBeNull()
    expect(o.firstRun.printerId).toBe('bay-1')
  })
})

describe('scan results', () => {
  it('matches an announced printer to its catalog model, dropping vendor words it cannot place', () => {
    expect(matchFound({ id: 'a', name: 'Bay 1', family: 'bambu-lan', model: 'Bambu Lab X1 Carbon' })?.id).toBe('bambu-x1-carbon')
    expect(matchFound({ id: 'b', name: 'Bay 4', family: 'moonraker', model: 'Voron Design Voron 2.4 350' })?.name).toMatch(/2\.4/)
    expect(matchFound({ id: 'c', name: 'Mystery', family: 'octoprint', model: 'Acme Widget 9000' })).toBeUndefined()
  })

  it('adopts what the scan read: model, connection, address, nozzle and filament unit', () => {
    const f = adoptFound(EMPTY_FORM, { id: 'a', name: 'Bay 1', family: 'bambu-lan', address: '192.0.2.11', model: 'Bambu Lab X1 Carbon', nozzleMm: 0.6, filamentSystem: 'ams', slotCount: 8 })
    expect(f.modelId).toBe('bambu-x1-carbon')
    expect(f.connection).toBe('bambu-lan')
    expect(f.fields.host).toBe('192.0.2.11')
    expect(f.nozzles[0]?.size).toBe(0.6)
    expect(f.filament).toEqual({ kind: 'ams', units: 2, slots: 8 })
  })

  it('imports PrusaSlicer ini files through the settings package, one preset per kind', async () => {
    const one = await importPresetFile('# generated\nlayer_height = 0.2\nperimeters = 3\nfill_density = 15%\n', 'My 0.20 QUALITY.ini')
    expect(one).toHaveLength(1)
    expect(one[0]).toMatchObject({ name: 'My 0.20 QUALITY', ok: true })
    const bundle = await importPresetFile('[print:Base]\nlayer_height = 0.3\n\n[print:Draft]\ninherits = Base\nperimeters = 2\n\n[filament:PLA mine]\ntemperature = 205\n', 'bundle.ini')
    expect(bundle.map((r) => r.name).sort()).toEqual(['Base', 'Draft', 'PLA mine'].sort())
    const none = await importPresetFile('; nothing\n', 'x.ini')
    expect(none[0]).toMatchObject({ ok: false, message: 'The file has no settings in it.' })
  })
})

describe('Skip on the printer screen', () => {
  it('keeps a picked printer: untested, and without the connection when its fields are incomplete', () => {
    expect(skipForm(EMPTY_FORM)).toBeNull()
    const picked = pickModel(EMPTY_FORM, 'bambu-x1-carbon')
    expect(picked.connection).toBe('bambu-lan')
    // No address, serial or access code yet: the printer is kept, the connection is not.
    expect(skipForm(picked)).toMatchObject({ modelId: 'bambu-x1-carbon', connection: 'export' })
    // A hand-made printer with no bed typed is not a pick yet.
    expect(skipForm(pickModel(EMPTY_FORM, 'custom'))).toBeNull()
  })

  it('keeps a scanned printer on its connection and address, leaving out only the credentials that are not complete', () => {
    const found = adoptFound(EMPTY_FORM, { id: 'h2c', name: 'Bay 6', family: 'bambu-lan', address: '192.0.2.16', model: 'Bambu Lab H2C' })
    const kept = skipForm(found, true)
    expect(kept).toMatchObject({ connection: 'bambu-lan', fields: { host: '192.0.2.16', serial: '' }, secretLengths: {} })
    // A serial that is complete stays; an access code that is half typed does not.
    const partial = { ...found, fields: { ...found.fields, serial: '01S00A000000000' }, secretLengths: { accessCode: 5 } }
    expect(skipForm(partial, true)).toMatchObject({ connection: 'bambu-lan', fields: { host: '192.0.2.16', serial: '01S00A000000000' }, secretLengths: {} })
    // The same printer picked by hand has no address to keep.
    expect(skipForm(found, false)).toMatchObject({ connection: 'export' })
  })

  it('keeps the connection too when its fields are complete', () => {
    const picked = { ...pickModel(EMPTY_FORM, 'bambu-x1-carbon'), fields: { host: '192.0.2.11', port: '', serial: '01S00A000000000', username: '' }, secretLengths: { accessCode: 8 } }
    expect(skipForm(picked)).toBe(picked)
  })
})

describe('look and feel in the shell', () => {
  const ws = ['prepare', 'preview', 'feed', 'library', 'printers', 'pilot'].map((id) => ({ id, label: id, icon: 'grid' as const, component: null }))

  it('orders and renames tabs per preset', () => {
    const bambu = orderWorkspaces(ws, resolvePreset('bambu-studio').layout)
    // There is no Preview tab: the sliced plate shows in Slice. A workspace a preset leaves out keeps its place at the end.
    expect(bambu.map((w) => w.id).slice(0, 2)).toEqual(['prepare', 'printers'])
    expect(bambu.find((w) => w.id === 'printers')?.label).toBe('Device')
    // Workspaces a preset leaves out keep their place at the end.
    expect(bambu.map((w) => w.id)).toContain('feed')
    const prusa = orderWorkspaces(ws, resolvePreset('prusaslicer').layout)
    expect(prusa[0]?.label).toBe('prepare')
  })

  it('offers the same settings modes whichever slicer the person comes from', () => {
    expect(effectiveMode('expert', resolvePreset('bambu-studio').layout)).toBe('expert')
    expect(effectiveMode('developer', resolvePreset('orcaslicer').layout)).toBe('developer')
    expect(effectiveMode('simple', resolvePreset('slicerx').layout)).toBe('simple')
  })

  it('applies control overrides over the preset map', async () => {
    const { controlsPreset, withRemap } = await import('@slicerx/viewport')
    const map = controlsFor({ controlsPreset, withRemap }, { id: 'prusaslicer', overrides: { controls: { remap: { right: 'rotate' }, invert: true, freeCamera: true } } })
    expect(map.drags.find((d) => d.button === 'right' && !d.mods)?.action).toBe('rotate')
    expect(map.wheel.invert).toBe(true)
    expect(map.freeCamera).toBe(true)
    expect(controlsFor({ controlsPreset, withRemap }, { id: 'prusaslicer' }).wheel.invert).toBe(false)
  })
})

describe('mimir guide', () => {
  const pilot = createGuidePilot({ delayMs: 0 })

  it('matches the current slicer to a style as a proposal, never applying it', async () => {
    const r = await pilot.ask({ step: 'look', text: 'I use PrusaSlicer at work', form: {} })
    expect(r.proposals).toEqual([expect.objectContaining({ kind: 'set-look', look: 'prusaslicer' })])
  })

  it('asks for approval before a scan and shows the range', async () => {
    const r = await pilot.ask({ step: 'printer', text: 'Find my printer on the network', form: {}, scanRange: 'the demo network 192.0.2.0/24' })
    expect(r.proposals[0]).toMatchObject({ kind: 'scan', range: 'the demo network 192.0.2.0/24' })
  })

  it('never asks for secrets in chat', async () => {
    const r = await pilot.ask({ step: 'printer', text: 'what is my access code', form: {} })
    expect(r.text).toMatch(/never ask/)
    expect(r.proposals).toEqual([])
  })

  it('explains a failed test and offers a new test only as a card', async () => {
    const r = await pilot.ask({ step: 'printer', text: 'Why did the test fail?', form: {}, lastTest: { ok: false, cause: 'auth' }, canTest: true })
    expect(r.text).toMatch(/refused/)
    expect(r.proposals).toEqual([expect.objectContaining({ kind: 'test' })])
  })

  it('suggests models by name', async () => {
    const r = await pilot.ask({ step: 'printer', text: 'I have a P1S', form: {} })
    expect(r.proposals.some((p) => p.kind === 'set-model' && p.modelId === 'bambu-p1s')).toBe(true)
  })
})
