// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate box of the machine card lists every plate type a project can name, and shows a Textured Cool or Supertack
// plate as itself, whether it was picked here or came with the project.
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const row = { id: 'bay-7', name: 'Desk P1S', vendor: 'Bambu Lab', model: 'P1S', plugin: 'bambu', nozzleCount: 1, status: { printerId: 'bay-7', state: 'idle', nozzles: [], slots: [], cameraAvailable: false, updatedAt: new Date(0).toISOString() } }
vi.mock('../src/lib/use-printer', () => ({ usePrinter: () => ({ rows: [row], printer: row }), printTarget: () => undefined }))

const { MachineCard } = await import('../src/workspaces/prepare/machine-card')
const { BED_TYPE_OPTIONS } = await import('../src/plate/bed-type')
const { get, set } = await import('../src/state/store')

const mount = () => {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  flushSync(() => root.render(createElement(MachineCard)))
  return { el, done: () => (root.unmount(), el.remove()) }
}

const box = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-testid="slice-machine-plate"]')!
const label = (el: HTMLElement) => el.querySelector('[data-testid="slice-machine-plate-label"]')?.textContent
const options = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="slice-machine-plate-option"]')]

const plateSettings = (settings: Record<string, unknown>) => set((s) => ({ plates: s.plates.map((p) => (p.id === s.activePlate ? { ...p, settings } : p)) }))

afterEach(() => {
  plateSettings({})
  set({ overrides: {} })
})

describe('machine card plate box', () => {
  it('lists every plate type, Textured Cool and Supertack too', () => {
    const { el, done } = mount()
    flushSync(() => box(el).click())
    const listed = options().map((o) => o.dataset['bedType'])
    expect(listed).toEqual(['', 'textured-pei', 'smooth-pei', 'cool', 'engineering', 'high-temp', 'textured-cool', 'supertack'])
    expect(options().map((o) => o.textContent)).toEqual([expect.stringMatching(/^Printer default/), 'Textured PEI', 'Smooth PEI', 'Cool plate', 'Engineering plate', 'High temp plate', 'Textured cool plate', 'Supertack plate'])
    // every option has an icon of its own kind
    for (const o of options()) expect(o.querySelector('svg, .sx-ic'), o.textContent ?? '').not.toBeNull()
    expect(BED_TYPE_OPTIONS.length).toBe(7)
    done()
  })

  it('shows a picked Textured Cool or Supertack plate on the card, and the plate keeps it', () => {
    const { el, done } = mount()
    for (const [value, name] of [['textured-cool', 'Textured cool plate'], ['supertack', 'Supertack plate']] as const) {
      flushSync(() => box(el).click())
      const pick = options().find((o) => o.dataset['bedType'] === value)!
      flushSync(() => pick.click())
      expect(get().plates.find((p) => p.id === get().activePlate)?.settings.bedType).toBe(value)
      expect(box(el).dataset['bedType']).toBe(value)
      expect(label(el)).toBe(name)
      expect(box(el).getAttribute('aria-label')).toBe(`Plate: ${name}`)
      flushSync(() => box(el).click())
      expect(options().find((o) => o.dataset['bedType'] === value)?.getAttribute('aria-checked')).toBe('true')
      flushSync(() => box(el).click())
    }
    done()
  })

  it("shows a project's Textured Cool or Supertack plate type, set in its settings", () => {
    for (const [file, value, name] of [['Textured Cool Plate', 'textured-cool', 'Textured cool plate'], ['Supertack Plate', 'supertack', 'Supertack plate']] as const) {
      set({ overrides: { curr_bed_type: file } })
      const { el, done } = mount()
      expect(box(el).dataset['bedType']).toBe(value)
      expect(label(el)).toBe(name)
      done()
    }
  })
})
