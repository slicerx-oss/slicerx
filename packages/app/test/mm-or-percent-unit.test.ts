// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A setting that takes a width in mm or a percent shows its unit beside the label only while the value is a plain
// number: a percent already carries its % sign, so "mm" beside "300%" would misread.
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { settingDef } from '../src/adapters/settings'
import { Field } from '../src/workspaces/prepare/expert-settings'

let root: Root | null = null
let el: HTMLElement | null = null
afterEach(() => {
  if (root) flushSync(() => root!.unmount())
  el?.remove()
  root = null
  el = null
})

/** The unit text beside the row's label, or null when it shows none. */
function unitOf(key: string, value: string): string | null {
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  const def = settingDef(key)!
  flushSync(() => root!.render(createElement(Field, { def, value, overridden: false, onSet: () => {} })))
  return el.querySelector('label .field-unit')?.textContent ?? null
}

describe('a width in mm or a percent', () => {
  for (const key of ['min_width_top_surface', 'top_area_threshold']) {
    it(`${key} shows mm beside a plain number`, () => {
      expect(unitOf(key, '0.9')).toBe('mm')
    })
    it(`${key} shows no unit beside a percent`, () => {
      expect(unitOf(key, '300%')).toBeNull()
    })
  }
})
