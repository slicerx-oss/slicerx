// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sidebar strip lists every project filament in order (a gap in the ids shows as a dimmed slot), stops at the printer's
// slot count when the printer reports slots, and the part badge shows its slot in full, or "?" when the filament is not
// one of the project's.
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { partBadge, stripSlots } from '../src/filament/rail'
import { SlotRail } from '../src/filament/slot-rail'
import { resolveSlots } from '../src/filament/slots'

const part = (name: string, slot: number) => ({ name, slot })
const object = (id: string, slots: number[]) => ({ id, name: id, parts: [], colors: [], handle: { parts: slots.map((s, i) => part(`${id}-${i}`, s)) } })
const project = (slots: number[], printerSlots: unknown[] = []) => ({ printerSlots, plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], plate: [object('a', slots)], activePlate: 'p1', slotSetup: {} }) as never

describe('the filament strip', () => {
  it('lists every filament in order, so a gap in the ids is a dimmed slot', () => {
    const all = resolveSlots(project([1, 2, 3, 4, 6, 7, 8, 9, 10]))
    const strip = stripSlots(all, 0)
    expect(strip.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(strip.filter((s) => !s.used).map((s) => s.index)).toEqual([5])
  })

  it('stops at the printer slot count when the printer reports slots', () => {
    const all = resolveSlots(project([1, 2, 3, 4, 6, 10]))
    expect(stripSlots(all, 5).map((s) => s.index)).toEqual([1, 2, 3, 4, 5])
  })

  it('marks the unused slot with the Not used hint, and keeps the slot ids as labels', () => {
    const slots = stripSlots(resolveSlots(project([1, 2, 4, 5])), 0)
    const el = document.createElement('div')
    document.body.appendChild(el)
    flushSync(() => createRoot(el).render(createElement(SlotRail, { slots, left: () => null })))
    const rings = [...el.querySelectorAll('[data-testid="slice-filament-slot"]')]
    expect(rings.map((r) => r.querySelector('.spool-id')?.textContent)).toEqual(['1', '2', '3', '4', '5'])
    expect(rings[2]!.getAttribute('data-used')).toBe('false')
    expect(rings[2]!.getAttribute('data-tip-body')).toMatch(/^Not used/)
    expect(rings[3]!.getAttribute('data-used')).toBe('true')
  })
})

describe('the part badge', () => {
  const strip = stripSlots(resolveSlots(project([1, 2, 10])), 0)

  it('shows filament 10 as 10, never cut to 0', () => {
    expect(partBadge(10, strip)).toEqual({ text: '10', known: true })
    expect(partBadge(1, strip)).toEqual({ text: '1', known: true })
  })

  it('shows "?" for a filament outside the project list, never 0', () => {
    for (const slot of [0, -1, 11, 2.5, Number.NaN, undefined, null]) expect(partBadge(slot, strip)).toEqual({ text: '?', known: false })
  })

  it('shows "?" for a filament past the printer slots', () => {
    const capped = stripSlots(resolveSlots(project([1, 2, 10])), 4)
    expect(partBadge(10, capped).text).toBe('?')
  })
})
