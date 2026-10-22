// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the phone's root carries for the on-screen keyboard: how far the keys cover the window's bottom, the part still
// in view, and whether the keyboard is up, from a covering keyboard, a panned view, a window the keyboard resized, the
// VirtualKeyboard API and a pinch zoom.
import { describe, expect, it } from 'vitest'
import { keyboardState, type KeyboardInput } from '../src/shell/phone-keyboard'

const at = (over: Partial<Omit<KeyboardInput, 'vv'>> & { vv?: Partial<KeyboardInput['vv']> } = {}): KeyboardInput => ({
  innerHeight: 844,
  keys: 0,
  tallest: 844,
  typing: false,
  ...over,
  vv: { height: 844, offsetTop: 0, scale: 1, ...over.vv },
})

describe('the phone keyboard', () => {
  it('is down with the whole window in view', () => {
    expect(keyboardState(at())).toEqual({ covered: 0, top: 0, shown: 844, up: false })
  })

  it('covers the bottom of the window and leaves the rest in view', () => {
    expect(keyboardState(at({ typing: true, vv: { height: 508 } }))).toEqual({ covered: 336, top: 0, shown: 508, up: true })
  })

  it('follows a view the browser panned down to the field', () => {
    expect(keyboardState(at({ typing: true, vv: { height: 508, offsetTop: 60 } }))).toEqual({ covered: 276, top: 60, shown: 508, up: true })
  })

  it('is up in a window the keyboard made shorter while typing, and not in one that is only short', () => {
    expect(keyboardState(at({ innerHeight: 508, typing: true, vv: { height: 508 } }))).toEqual({ covered: 0, top: 0, shown: 508, up: true })
    expect(keyboardState(at({ innerHeight: 508, typing: false, vv: { height: 508 } })).up).toBe(false)
    expect(keyboardState(at({ innerHeight: 508, tallest: 508, typing: true, vv: { height: 508 } })).up).toBe(false)
  })

  it('takes the VirtualKeyboard height where the browser has one and the view does not shrink', () => {
    expect(keyboardState(at({ keys: 300, typing: true }))).toEqual({ covered: 300, top: 0, shown: 544, up: true })
  })

  it('reads a pinch zoom as no keyboard', () => {
    expect(keyboardState(at({ vv: { height: 422, offsetTop: 100, scale: 2 } }))).toEqual({ covered: 0, top: 0, shown: 844, up: false })
  })
})
