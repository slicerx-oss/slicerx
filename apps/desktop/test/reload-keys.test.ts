// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { blockReloadKeys, isReloadKey } from '../src/reload-keys'

const key = (key: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })

describe('reload keys', () => {
  let off = () => {}
  afterEach(() => off())

  it('names F5 and Ctrl+R, with or without Shift, and nothing else', () => {
    for (const e of [key('F5'), key('F5', { ctrlKey: true }), key('r', { ctrlKey: true }), key('R', { ctrlKey: true, shiftKey: true }), key('r', { metaKey: true })]) expect(isReloadKey(e), `${e.key}`).toBe(true)
    for (const e of [key('r'), key('R', { shiftKey: true }), key('r', { ctrlKey: true, altKey: true }), key('F4'), key('Enter', { ctrlKey: true })]) expect(isReloadKey(e), `${e.key}`).toBe(false)
  })

  it('cancels the reload after the app has seen the key, and leaves other keys alone', () => {
    const seen: [string, boolean][] = []
    document.body.addEventListener('keydown', (e) => seen.push([e.key, e.defaultPrevented]))
    off = blockReloadKeys(window)
    const r = key('r', { ctrlKey: true })
    document.body.dispatchEvent(r)
    expect(r.defaultPrevented).toBe(true)
    const f5 = key('F5')
    document.body.dispatchEvent(f5)
    expect(f5.defaultPrevented).toBe(true)
    const m = key('m')
    document.body.dispatchEvent(m)
    expect(m.defaultPrevented).toBe(false)
    expect(seen).toEqual([['r', false], ['F5', false], ['m', false]])
  })

  it('is on in the desktop page, and the shell turns the web view keys off on Windows', () => {
    const page = readFileSync(resolve(import.meta.dirname, '../src/main.tsx'), 'utf8')
    expect(page).toContain('blockReloadKeys()')
    const shell = readFileSync(resolve(import.meta.dirname, '../src-tauri/src/main.rs'), 'utf8')
    expect(shell).toContain('crash::disable_browser_keys')
    expect(readFileSync(resolve(import.meta.dirname, '../src-tauri/src/crash.rs'), 'utf8')).toContain('SetAreBrowserAcceleratorKeysEnabled(false)')
  })
})
