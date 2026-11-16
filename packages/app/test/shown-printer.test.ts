// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// With no printer chosen the app shows the first idle printer and slices for it. Once a print starts there, that
// printer stays the one shown (it is the one the slice follows), so starting a print never reads as a plate change:
// before, the next idle printer took its place and the slice just sent read as stale. A chosen printer always wins,
// and a kept printer that goes offline gives way as before.
import { describe, expect, it } from 'vitest'
import type { FleetRow } from '../src/lib/queries'
import { shownPrinter } from '../src/lib/use-printer'

const row = (id: string, state: FleetRow['status']['state']): FleetRow => ({ id, name: id, vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu-lan', nozzleCount: 1, status: { printerId: id, state, nozzles: [], slots: [], cameraAvailable: false, updatedAt: '' } })

describe('the printer the app shows', () => {
  it('keeps the shown printer once it prints, with nothing chosen', () => {
    // before the start: the A1 is the first idle one
    expect(shownPrinter([row('a1', 'idle'), row('voron', 'idle')], null, null)?.id).toBe('a1')
    // the A1 prints: it stays the one shown, not the idle Voron
    expect(shownPrinter([row('a1', 'printing'), row('voron', 'idle')], null, 'a1')?.id).toBe('a1')
    expect(shownPrinter([row('a1', 'preparing'), row('voron', 'idle')], null, 'a1')?.id).toBe('a1')
  })

  it('a chosen printer wins, and a kept one that went offline gives way to the first idle one', () => {
    expect(shownPrinter([row('a1', 'printing'), row('voron', 'idle')], 'voron', 'a1')?.id).toBe('voron')
    expect(shownPrinter([row('a1', 'offline'), row('voron', 'idle')], null, 'a1')?.id).toBe('voron')
    expect(shownPrinter([row('voron', 'idle')], null, 'a1')?.id).toBe('voron')
  })
})
