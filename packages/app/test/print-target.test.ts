// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { PrinterState } from '@slicerx/contracts'
import type { FleetRow } from '../src/lib/queries'
import { printPlateLabel, printTarget } from '../src/lib/use-printer'

const row = (id: string, model: string, state: PrinterState): FleetRow =>
  ({ id, name: id, vendor: 'Bambu Lab', model, plugin: 'bambu', nozzleCount: 1, status: { printerId: id, state, nozzles: [], slots: [], cameraAvailable: false, updatedAt: '' } }) as FleetRow

describe('printTarget', () => {
  const voron = { ...row('v', 'Voron 2.4', 'finished'), vendor: 'Voron Design' }
  const p1s = row('p', 'P1S', 'idle')
  const p1sBusy = row('q', 'P1S', 'printing')
  it('sends to the chosen printer when it is idle or finished', () => {
    expect(printTarget(voron, [voron, p1s])?.id).toBe('v')
    expect(printTarget(p1s, [voron, p1s])?.id).toBe('p')
  })
  it('stands in only an idle printer of the same make and model', () => {
    expect(printTarget(p1sBusy, [p1sBusy, p1s, voron])?.id).toBe('p')
    expect(printTarget({ ...voron, status: { ...voron.status, state: 'printing' } }, [p1s])).toBeUndefined()
    expect(printTarget(undefined, [p1s])).toBeUndefined()
  })
})

describe('printPlateLabel', () => {
  it('names the plate under Print only when there are several', () => {
    expect(printPlateLabel([{ id: 'plate-1', name: 'Plate 1' }], 'plate-1')).toBeNull()
    const two = [{ id: 'plate-1', name: 'Plate 1' }, { id: 'plate-2', name: 'Lids' }]
    expect(printPlateLabel(two, 'plate-2')).toBe('Lids')
    expect(printPlateLabel(two, 'gone')).toBeNull()
  })
})
