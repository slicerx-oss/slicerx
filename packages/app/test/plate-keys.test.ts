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
