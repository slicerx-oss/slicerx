// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Digit keys are view keys (1 is top) except while sketching, where they type an exact size.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindPlateKeys } from '../src/plate/keys'
import { setCameraBus } from '../src/plate/tools'
import { get, set } from '../src/state/store'

describe('plate keys and the sketch size field', () => {
  const view = vi.fn()
  let off: () => void = () => undefined
  beforeEach(() => {
    view.mockClear()
    setCameraBus({ view } as unknown as Parameters<typeof setCameraBus>[0])
    set({ workspace: 'prepare', objectTool: null, setup: null })
    off = bindPlateKeys(() => ({ id: 'slicerx' }) as unknown as Parameters<typeof bindPlateKeys>[0] extends () => infer C ? C : never)
  })
  afterEach(() => {
    off()
    set({ objectTool: null })
  })
  const press = (key: string) => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    window.dispatchEvent(e)
    return e
  }

  it('turns the view on a digit outside the sketch tool', () => {
    const e = press('1')
    expect(view).toHaveBeenCalledWith('top', { animate: true })
    expect(e.defaultPrevented).toBe(true)
  })

  it('leaves digits to the sketch while it is open', () => {
    set({ objectTool: 'sketch' })
    const e = press('1')
    expect(view).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('takes Tab only while the 3D view has focus', () => {
    set({ modelMode: 'slice', sliceLook: 'solid' })
    const button = document.body.appendChild(document.createElement('button'))
    button.focus()
    const away = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    button.dispatchEvent(away)
    expect(away.defaultPrevented).toBe(false)
    expect(get().sliceLook).toBe('solid')
    const canvas = document.body.appendChild(document.createElement('canvas'))
    canvas.className = 'vp-canvas'
    canvas.tabIndex = 0
    canvas.focus()
    const on = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    canvas.dispatchEvent(on)
    expect(on.defaultPrevented).toBe(true)
    expect(get().sliceLook).toBe('toolpaths')
    button.remove()
    canvas.remove()
  })
})

describe('the layer slider keys in Slice', () => {
  let off: () => void = () => undefined
  const bind = (id: string) => {
    off()
    off = bindPlateKeys(() => ({ id }) as unknown as Parameters<typeof bindPlateKeys>[0] extends () => infer C ? C : never)
  }
  beforeEach(() => {
    setCameraBus({ view: vi.fn() } as unknown as Parameters<typeof setCameraBus>[0])
    set({ workspace: 'prepare', objectTool: null, setup: null, modelMode: 'slice', sliceLook: 'toolpaths', preview: { layerCount: 10 } as unknown as ReturnType<typeof get>['preview'], layerHi: 10, layerLo: 1, legendHidden: false })
  })
  afterEach(() => {
    off()
    off = () => undefined
    set({ preview: null, layerHi: 0, layerLo: 1, legendHidden: false })
  })
  const press = (key: string, at: EventTarget = window, shiftKey = false) => {
    const e = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
    at.dispatchEvent(e)
    return e
  }

  it('steps the top layer with Up and Down in the Bambu Studio look, without focus on the slider', () => {
    bind('bambu-studio')
    expect(press('ArrowDown').defaultPrevented).toBe(true)
    expect(press('ArrowDown').defaultPrevented).toBe(true)
    expect(get().layerHi).toBe(8)
    press('ArrowUp')
    expect(get().layerHi).toBe(9)
  })

  it('shows the toolpaths when an arrow steps from the solid models', () => {
    bind('slicerx')
    set({ sliceLook: 'solid' })
    press('ArrowDown')
    expect(get().sliceLook).toBe('toolpaths')
    expect(get().layerHi).toBe(9)
  })

  it('leaves the arrows to a focused control and does nothing before a slice', () => {
    bind('slicerx')
    const select = document.body.appendChild(document.createElement('select'))
    select.focus()
    expect(press('ArrowDown', select).defaultPrevented).toBe(false)
    expect(get().layerHi).toBe(10)
    select.remove()
    set({ preview: null })
    expect(press('ArrowDown').defaultPrevented).toBe(false)
    expect(get().layerHi).toBe(10)
  })

  it('shows one layer and back with the one layer key', () => {
    bind('bambu-studio')
    set({ layerHi: 6 })
    press('l')
    expect(get().layerLo).toBe(6)
    press('l')
    expect(get().layerLo).toBe(1)
  })

  it('gives a shared letter to the one layer key on toolpaths and to the tool on solid models (OrcaSlicer L)', () => {
    bind('orcaslicer')
    set({ layerHi: 4 })
    press('l')
    expect(get().layerLo).toBe(4)
    set({ layerLo: 1, sliceLook: 'solid' })
    press('l')
    expect(get().layerLo).toBe(1)
  })

  it('hides and shows the legend with its key', () => {
    bind('slicerx')
    press('l')
    expect(get().legendHidden).toBe(true)
    press('l')
    expect(get().legendHidden).toBe(false)
  })
})
