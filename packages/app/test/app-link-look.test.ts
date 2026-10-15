// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app link's view preferences: look.get reads Frame the view and Toolbar size, look.set changes them the way the
// Settings rows do and answers with them read back, and a bad call changes nothing.
import { afterEach, describe, expect, it } from 'vitest'
import { APP_LINK_METHODS, LinkError, runCall } from '../src/app-link/methods'
import { NEUTRAL, setCurrentEdition } from '../src/edition'
import { DEFAULT_APPEARANCE } from '../src/state/prefs'
import { get, set } from '../src/state/store'

const refused = async (args: Record<string, unknown>) => {
  const e = await runCall('look.set', args).catch((x: unknown) => x)
  expect(e, JSON.stringify(args)).toBeInstanceOf(LinkError)
  return (e as LinkError).code
}

afterEach(() => {
  setCurrentEdition(NEUTRAL)
  set({ appearance: { ...DEFAULT_APPEARANCE } })
})

describe('app link look', () => {
  it('reads and sets only how the window behaves', async () => {
    expect(APP_LINK_METHODS['look.get']).toBe('read')
    expect(APP_LINK_METHODS['look.set']).toBe('read')
  })

  it('reads the two preferences and sets either or both, reading them back', async () => {
    setCurrentEdition(NEUTRAL)
    expect(await runCall('look.get', {})).toMatchObject({ toolbarSize: 'large', modelFraming: 'selection' })
    expect(await runCall('look.set', { modelFraming: 'open' })).toMatchObject({ toolbarSize: 'large', modelFraming: 'open' })
    expect(await runCall('look.set', { toolbarSize: 'small' })).toMatchObject({ toolbarSize: 'small', modelFraming: 'open' })
    expect(await runCall('look.set', { toolbarSize: 'medium', modelFraming: 'selection' })).toMatchObject({ toolbarSize: 'medium', modelFraming: 'selection' })
    expect(get().appearance).toMatchObject({ toolbarSize: 'medium', modelFraming: 'selection' })
    // the rest of the look stays the person's
    expect(get().appearance.textSize).toBe(DEFAULT_APPEARANCE.textSize)
  })

  it('refuses a bad value, an empty call and any other setting, changing nothing', async () => {
    setCurrentEdition(NEUTRAL)
    const before = { ...get().appearance }
    expect(await refused({ modelFraming: 'sometimes' })).toBe('invalid_input')
    expect(await refused({ toolbarSize: 'huge', modelFraming: 'open' })).toBe('invalid_input')
    expect(await refused({})).toBe('invalid_input')
    expect(await refused({ textSize: 'large' })).toBe('invalid_input')
    expect(await refused({ toolbarSize: 'small', contrast: 'high' })).toBe('invalid_input')
    expect(get().appearance).toEqual(before)
  })

  it('in an edition without Model, has Toolbar size only', async () => {
    setCurrentEdition({ ...NEUTRAL, features: { ...NEUTRAL.features, cad: false } })
    expect(await runCall('look.get', {})).toMatchObject({ toolbarSize: 'large' })
    expect(await refused({ modelFraming: 'open' })).toBe('not_found')
    expect(get().appearance.modelFraming).toBe('selection')
    expect(await runCall('look.set', { toolbarSize: 'small' })).toMatchObject({ toolbarSize: 'small' })
  })
})
