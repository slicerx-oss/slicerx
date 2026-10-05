// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Developer mode is a visible choice in the Settings mode control of every look, and choosing it
// unlocks the developer commands.
import type { Host } from '@slicerx/contracts'
import { LOOK_IDS, resolvePreset } from '@slicerx/ui'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { builtinCommands } from '../src/commands/builtin'
import { ModeSelector } from '../src/first-run/mode-selector'
import { get, set } from '../src/state/store'

const devCommands = () => builtinCommands({ kind: 'web' } as unknown as Host, []).filter((c) => c.id.startsWith('dev-'))

describe('developer mode', () => {
  for (const id of LOOK_IDS) {
    it(`is offered in the mode control of the ${id} look and unlocks the developer commands`, () => {
      set({ settingsMode: 'simple' })
      const el = document.createElement('div')
      document.body.append(el)
      const root = createRoot(el)
      flushSync(() => root.render(createElement(ModeSelector, { layout: resolvePreset(id).layout, id: 'mode-test' })))
      const names = [...el.querySelectorAll('[role="radio"]')].map((b) => b.textContent)
      expect(names).toEqual(['Simple', 'Advanced', 'Expert', 'Developer'])
      const dev = [...el.querySelectorAll<HTMLElement>('[role="radio"]')].find((b) => b.textContent === 'Developer')
      expect(dev?.getAttribute('aria-label')).toMatch(/developer/i)
      expect(devCommands().some((c) => c.enabled?.() ?? true)).toBe(false)
      flushSync(() => dev?.click())
      expect(get().settingsMode).toBe('developer')
      expect(devCommands().filter((c) => c.enabled?.() ?? true).map((c) => c.id)).toContain('dev-test-crash')
      root.unmount()
      el.remove()
      set({ settingsMode: 'simple' })
    })
  }
})
