// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The CAD-only browser build (a host that cannot slice): its own agreement text and version, a command bar without
// slicing, and no slice started from anywhere.
import { neutralEdition } from '@slicerx/edition-config'
import { AGREEMENT_VERSION, MODEL_AGREEMENT_VERSION } from '@slicerx/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceptAgreement, needsAgreement } from '../src/first-run/agreement'
import { listedOnHost, setHostSlices, titleInMode } from '../src/state/model-mode'
import { get, set } from '../src/state/store'

afterEach(() => setHostSlices(true))

const pre = { ...neutralEdition(), release: { stage: 'pre-alpha' as const } }
const cadOnly = { kind: 'web' as const, capabilities: { slicing: false } }

describe('the CAD-only agreement', () => {
  it('has its own version, so people who accepted the slicing text read it once more', () => {
    expect(MODEL_AGREEMENT_VERSION).not.toBe(AGREEMENT_VERSION)
    expect(needsAgreement(pre, cadOnly, { version: AGREEMENT_VERSION })).toBe(true)
    expect(needsAgreement(pre, cadOnly, { version: MODEL_AGREEMENT_VERSION })).toBe(false)
    // a host that slices keeps asking for its own text only
    expect(needsAgreement(pre, { kind: 'desktop' }, { version: AGREEMENT_VERSION })).toBe(false)
  })

  it('records the version of the text shown', () => {
    set({ agreement: null, agreementOpen: true })
    acceptAgreement(new Date('2026-10-13T12:00:00Z'), false)
    expect(get().agreement).toEqual({ version: MODEL_AGREEMENT_VERSION, acceptedAt: '2026-10-13T12:00:00.000Z' })
  })

  it('talks about models only: no toolpaths, no printer to watch', async () => {
    vi.resetModules()
    const { setHostSlices: setSlices } = await import('../src/state/model-mode')
    setSlices(false)
    const { createElement } = await import('react')
    const { flushSync } = await import('react-dom')
    const { createRoot } = await import('react-dom/client')
    const { Agreement } = await import('../src/first-run/agreement')
    const { EditionContext } = await import('../src/edition')
    const el = document.createElement('div')
    document.body.append(el)
    flushSync(() => createRoot(el).render(createElement(EditionContext, { value: pre }, createElement(Agreement))))
    const text = el.textContent ?? ''
    for (const part of ['heavy testing', 'export anything you want to keep', 'I understand that this is a pre-alpha build.', `Agreement version ${MODEL_AGREEMENT_VERSION}`]) expect(text, part).toContain(part)
    expect(text).not.toMatch(/toolpath|slicing|printer|nozzle|temperature/i)
    expect(el.querySelector('.fra-more')?.getAttribute('data-tip-body')).not.toMatch(/printer/)
    setSlices(true)
    el.remove()
  })
})

describe('the command bar on a host that cannot slice', () => {
  it('leaves out slicing, printers, print settings and presets, and keeps modeling and export', () => {
    setHostSlices(false)
    for (const c of [
      { id: 'export-gcode-3mf', section: 'slice' },
      { id: 'setup-printer', section: 'printers' },
      { id: 'user-presets', section: 'settings' },
      { id: 'brim-toggle', section: 'settings' },
      { id: 'nozzle-0.4', section: 'settings' },
      { id: 'goal-fine', section: 'settings' },
      { id: 'paint-support', section: 'plate' },
      { id: 'preview-first-layer', section: 'view' },
      { id: 'check-printers', section: 'plate' },
      { id: 'print-rest', section: 'plate' },
      { id: 'open-printers', section: 'navigate' },
      { id: 'open-vault', section: 'navigate' },
      { id: 'toggle-printable', section: 'plate' },
    ])
      expect(listedOnHost(c), c.id).toBe(false)
    for (const c of [
      { id: 'export-plate-stl', section: 'plate' },
      { id: 'project-save', section: 'plate' },
      { id: 'object-sketch', section: 'plate' },
      { id: 'look-open', section: 'settings' },
      { id: 'open-prepare', section: 'navigate' },
    ])
      expect(listedOnHost(c), c.id).toBe(true)
    expect(titleInMode('slicing-open', 'Slicing and modeling: auto slice, electricity price and drawing tools', 'design')).toBe('Modeling: drawing tools')
  })

  it('lists everything on a host that slices', () => {
    expect(listedOnHost({ id: 'export-gcode-3mf', section: 'slice' })).toBe(true)
    expect(titleInMode('slicing-open', 'Slicing and modeling', 'slice')).toBe('Slicing and modeling')
  })
})

describe('slicing on a host that cannot slice', () => {
  it('never starts', async () => {
    setHostSlices(false)
    const { slicePlate } = await import('../src/state/slice-plate')
    const before = get().slice
    await slicePlate({} as never, { auto: true })
    await slicePlate({} as never)
    expect(get().slice).toBe(before)
  })
})
