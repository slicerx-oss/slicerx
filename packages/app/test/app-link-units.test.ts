// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, expect, it } from 'vitest'
import { APP_LINK_METHODS, runCall } from '../src/app-link/methods'
import { DEFAULT_UNITS, formatLength, parseLength } from '../src/cad/units'
import { history } from '../src/plate/history'
import { get, set } from '../src/state/store'

beforeEach(() => { set({ units: { ...DEFAULT_UNITS } }); history().clear() })

it('switches display and bare input units without changing project state or history', async () => {
  const before = get()
  const revision = history().state().revision
  expect(APP_LINK_METHODS['units.get']).toBe('read')
  expect(APP_LINK_METHODS['units.set']).toBe('read')
  expect(await runCall('units.set', { length: 'in', precision: { decimals: 4 } })).toMatchObject({ length: 'in', precision: { decimals: 4 }, millimetersPerUnit: 25.4, dataUnit: 'mm' })
  expect(await runCall('units.get', {})).toMatchObject({ length: 'in', inchDigits: 4 })
  expect(formatLength(25.4, get().units)).toBe('1.0000')
  expect(parseLength('1', get().units)).toBe(25.4)
  expect(parseLength('1mm', get().units)).toBe(1)
  expect(get().plate).toBe(before.plate)
  expect(get().timeline).toBe(before.timeline)
  expect(get().overrides).toBe(before.overrides)
  expect(get().objectSettings).toBe(before.objectSettings)
  expect(history().state().revision).toBe(revision)
})

it('offers every UI precision and remembers the inactive unit across switches', async () => {
  for (const decimals of [0, 1, 2, 3]) expect(await runCall('units.set', { length: 'mm', precision: { decimals } })).toMatchObject({ mmDigits: decimals, precision: { decimals } })
  for (const decimals of [2, 3, 4]) expect(await runCall('units.set', { length: 'in', precision: { decimals } })).toMatchObject({ inchDigits: decimals, inchFraction: 0, precision: { decimals } })
  for (const fraction of [16, 32, 64]) expect(await runCall('units.set', { precision: { fraction } })).toMatchObject({ inchFraction: fraction, precision: { fraction } })
  await runCall('units.set', { length: 'mm' })
  expect(await runCall('units.get', {})).toMatchObject({ mmDigits: 3, precision: { decimals: 3 } })
  await runCall('units.set', { length: 'in' })
  expect(await runCall('units.get', {})).toMatchObject({ inchDigits: 4, precision: { fraction: 64 } })
  await runCall('units.set', { precision: { decimals: 2 } })
  expect(await runCall('units.get', {})).toMatchObject({ inchFraction: 0, precision: { decimals: 2 } })
})

it('validates the whole change and leaves invalid or unchanged requests without a mutation', async () => {
  const before = get().units
  for (const input of [{}, { length: 'ft' }, { length: 'in', precision: { decimals: 1 } }, { precision: { decimals: 4 } }, { precision: { fraction: 16 } }, { length: 'in', precision: { fraction: 8 } }, { length: 'in', precision: { decimals: 2, fraction: 16 } }, { length: 'in', printer: 'external' }]) {
    await expect(runCall('units.set', input)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(get().units).toBe(before)
  }
  await runCall('units.set', { length: 'mm', precision: { decimals: 2 } })
  expect(get().units).toBe(before)
  await expect(runCall('units.get', { change: true })).rejects.toMatchObject({ code: 'invalid_input' })
})
