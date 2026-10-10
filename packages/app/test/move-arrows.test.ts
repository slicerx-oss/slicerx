// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The move tool's X, Y and Z arrows show only when the person picks Move (its button, M or the command), as in Bambu
// Studio and OrcaSlicer. Move as the default tool, or the tool a toggle falls back to, selects and drags without them.
import type { LayoutSpec } from '@slicerx/contracts'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { setTool, toolStore } from '../src/plate/tools'
import { PlateToolbar } from '../src/workspaces/prepare/plate-toolbar'

const arrows = () => toolStore.getState().moveArrows

describe('move arrows', () => {
  afterEach(() => toolStore.setState({ tool: 'move', rotateSpace: 'world', moveArrows: false }))

  it('are off for Move as the default tool', () => {
    expect(toolStore.getState().tool).toBe('move')
    expect(arrows()).toBe(false)
  })

  it('come on when Move is picked and go with any other tool', () => {
    setTool('move', true)
    expect(arrows()).toBe(true)
    setTool('rotate', true)
    expect(arrows()).toBe(false)
    // a return to move that nobody picked, such as leaving the paint tool
    setTool('move')
    expect(arrows()).toBe(false)
  })

  it('follow the toolbar: Move picks them, turning another tool off does not', () => {
    const el = document.createElement('div')
    const root = createRoot(el)
    flushSync(() => root.render(createElement(PlateToolbar, { layout: { toolbar: 'top' } as unknown as LayoutSpec })))
    const button = (label: string) => el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
    const before = [...el.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
    // drop to bed keeps its place with nothing selected, so a selection never shifts the toolbar
    expect(button('Drop to bed')).toBeTruthy()
    expect(button('Drop to bed').getAttribute('aria-disabled') === 'true' || button('Drop to bed').disabled).toBe(true)
    flushSync(() => button('Rotate').click())
    flushSync(() => button('Rotate').click())
    expect(toolStore.getState().tool).toBe('move')
    expect(arrows()).toBe(false)
    flushSync(() => button('Move').click())
    expect(arrows()).toBe(true)
    expect(button('Move').getAttribute('aria-pressed')).toBe('true')
    // the buttons stay the same set in the same order whatever is picked
    expect([...el.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(before)
    root.unmount()
  })
})
