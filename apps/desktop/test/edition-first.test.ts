// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { appName, NEUTRAL, setCurrentEdition } from '../../../packages/app/src/edition'
import { windowTitle } from '../../../packages/app/src/project/title'

describe('the app name from the first frame', () => {
  it('is set before anything that names the app is registered', () => {
    const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
    const set = main.indexOf('setCurrentEdition(editionFromBuild())')
    expect(set).toBeGreaterThan(0)
    for (const later of ['registerCrashHost(', 'onWindowTitle(', 'registerNativeMenu(', 'createRoot(']) expect(main.indexOf(later), later).toBeGreaterThan(set)
  })

  it('titles the window with the edition name', () => {
    setCurrentEdition({ ...NEUTRAL, brand: { ...NEUTRAL.brand, name: 'SlicerX' } })
    expect(appName()).toBe('SlicerX')
    expect(windowTitle(null, false)).toBe('SlicerX')
  })
})
