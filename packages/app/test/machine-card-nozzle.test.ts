// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The nozzle chip shows its size as soon as the printer's profile has loaded, and a skeleton only before that.
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

const row = { id: 'bay-7', name: 'Desk A1', vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu', nozzleCount: 1, status: { printerId: 'bay-7', state: 'idle', nozzles: [], slots: [], cameraAvailable: false, updatedAt: new Date(0).toISOString() } }
vi.mock('../src/lib/use-printer', () => ({ usePrinter: () => ({ rows: [row], printer: row }), printTarget: () => undefined }))

const { MachineCard } = await import('../src/workspaces/prepare/machine-card')
const { set } = await import('../src/state/store')

describe('machine card nozzle chip', () => {
  it('is a skeleton until the profile loads, then reads the nozzle size', () => {
    set({ profile: null, settingsMode: 'simple' })
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el)
    flushSync(() => root.render(createElement(MachineCard)))
    expect(el.querySelector('[data-testid="slice-machine-nozzle"]')).toBeNull()
    expect(el.querySelector('.mc-skel')).not.toBeNull()
    // The profile's own printer id differs from the printer row's id; the chip shows all the same.
    flushSync(() => set({ profile: { printerId: 'bambu-a1', nozzle: 0.4, nozzles: [0.2, 0.4, 0.6, 0.8], nozzleFrom: 'default', tier: 'standard', source: 'slicerx', shippedGcode: true, gcodeKeys: [], limits: {} } }))
    expect(el.querySelector('[data-testid="slice-machine-nozzle"]')?.textContent).toBe('0.4 mm')
    expect(el.querySelector('.mc-skel')).toBeNull()
    root.unmount()
    el.remove()
    set({ profile: null })
  })
})
