// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app link's view preferences: look.get reads Frame the view and Toolbar size, look.set changes them the way the
// Settings rows do and answers with them read back, and a bad call changes nothing.
import { afterEach, describe, expect, it } from 'vitest'
import { APP_LINK_METHODS, LinkError, runCall } from '../src/app-link/methods'
import { NEUTRAL, setCurrentEdition } from '../src/edition'
import { DEFAULT_SPACE_MOUSE } from '@slicerx/viewport/spacemouse'
import { DEFAULT_APPEARANCE } from '../src/state/prefs'
import { get, set } from '../src/state/store'
import { registerSpaceMouseSource, resetSpaceMouseForTests, startSpaceMouse, webHidSource, type SpaceMouseStatus } from '../src/viewport/spacemouse'

const refused = async (args: Record<string, unknown>) => {
  const e = await runCall('look.set', args).catch((x: unknown) => x)
  expect(e, JSON.stringify(args)).toBeInstanceOf(LinkError)
  return (e as LinkError).code
}

afterEach(() => {
  setCurrentEdition(NEUTRAL)
  set({ appearance: { ...DEFAULT_APPEARANCE }, spaceMouse: DEFAULT_SPACE_MOUSE })
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

describe('app link 3D mouse', () => {
  it('reads the 3D mouse settings and where the device stands', async () => {
    const out = (await runCall('look.get', {})) as { spaceMouse: Record<string, unknown> }
    // jsdom has no WebHID and no desktop reader is registered
    expect(out.spaceMouse).toEqual({ ...DEFAULT_SPACE_MOUSE, status: 'unsupported' })
  })

  it('sets any of them the way the Settings rows do, keeping the rest, and reads them back', async () => {
    const a = (await runCall('look.set', { spaceMouse: { enabled: true, sensitivity: 2 } })) as { spaceMouse: Record<string, unknown> }
    expect(a.spaceMouse).toMatchObject({ enabled: true, sensitivity: 2, dominantAxis: false })
    const b = (await runCall('look.set', { spaceMouse: { invert: { zoom: true }, dominantAxis: true }, toolbarSize: 'small' })) as { spaceMouse: Record<string, unknown>; toolbarSize: string }
    expect(b.toolbarSize).toBe('small')
    expect(b.spaceMouse).toMatchObject({ enabled: true, sensitivity: 2, dominantAxis: true, invert: { panX: false, panY: false, zoom: true, tilt: false, spin: false } })
    expect(get().spaceMouse).toEqual({ enabled: true, sensitivity: 2, dominantAxis: true, invert: { panX: false, panY: false, zoom: true, tilt: false, spin: false } })
  })

  it('refuses a bad 3D mouse value and changes nothing, toolbar size included', async () => {
    const before = { appearance: { ...get().appearance }, spaceMouse: get().spaceMouse }
    for (const bad of [{ spaceMouse: 'on' }, { spaceMouse: {} }, { spaceMouse: { enabled: 'yes' } }, { spaceMouse: { sensitivity: 9 } }, { spaceMouse: { sensitivity: Number.NaN } }, { spaceMouse: { invert: { roll: true } } }, { spaceMouse: { invert: { zoom: 1 } } }, { spaceMouse: { speed: 2 } }, { toolbarSize: 'small', spaceMouse: { dominantAxis: 'no' } }]) {
      expect(await refused(bad)).toBe('invalid_input')
    }
    expect({ appearance: get().appearance, spaceMouse: get().spaceMouse }).toEqual(before)
  })

  it('reads where the device stands and its name, the name only when there is one', async () => {
    let tell: (s: SpaceMouseStatus) => void = () => {}
    registerSpaceMouseSource(() => ({
      kind: 'desktop',
      start: (_r, st) => {
        tell = st
        return () => {}
      },
    }))
    try {
      set({ spaceMouse: { ...DEFAULT_SPACE_MOUSE, enabled: true } })
      startSpaceMouse()
      const read = async () => ((await runCall('look.get', {})) as { spaceMouse: Record<string, unknown> }).spaceMouse
      tell({ state: 'connected', name: 'SpaceMouse Compact' })
      expect(await read()).toMatchObject({ enabled: true, status: 'connected', device: 'SpaceMouse Compact' })
      tell({ state: 'busy', name: 'SpaceMouse Compact' })
      expect(await read()).toMatchObject({ status: 'busy', device: 'SpaceMouse Compact' })
      tell({ state: 'none' })
      expect(await read()).not.toHaveProperty('device')
    } finally {
      resetSpaceMouseForTests()
      registerSpaceMouseSource(null)
    }
  })

  // Turning the 3D mouse on from the link is allowed: it only moves the camera and presses the view buttons. In a
  // browser it reaches only a device the person already granted, and never opens the device picker.
  it('turned on from the link, opens only a device the person already granted and never asks for one', async () => {
    const asked: unknown[] = []
    const hid = Object.assign(new EventTarget(), { getDevices: async () => [], requestDevice: async (o: unknown) => (asked.push(o), []) })
    registerSpaceMouseSource(() => webHidSource({ hid }))
    try {
      startSpaceMouse()
      const out = (await runCall('look.set', { spaceMouse: { enabled: true } })) as { spaceMouse: Record<string, unknown> }
      await new Promise((r) => setTimeout(r, 0))
      expect(asked).toEqual([])
      expect(out.spaceMouse).toMatchObject({ enabled: true, status: 'none' })
    } finally {
      resetSpaceMouseForTests()
      registerSpaceMouseSource(null)
    }
  })
})
