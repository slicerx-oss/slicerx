// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tool icons' gradient and clip ids stay unique on a live page: several toolbars mounted at once, a toolbar
// mounted twice in one tree, a size change, a theme switch and a remount. Every url(#id) resolves inside its own icon.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { TOOL_ICONS, ToolIcon, type ToolIconName } from '../src/icons/tool-icon'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const withDefs = (Object.keys(TOOL_ICONS) as ToolIconName[]).filter((n) => TOOL_ICONS[n][32].includes('id="ti-') || TOOL_ICONS[n][24].includes('id="ti-'))

function Toolbar({ size }: { size: 32 | 24 | 16 }) {
  return <div>{withDefs.map((n) => <ToolIcon key={n} name={n} size={size} />)}</div>
}

function Page({ size, theme }: { size: 32 | 24 | 16; theme: string }) {
  return (
    <div data-theme={theme}>
      <Toolbar size={size} />
      <Toolbar size={size} />
      <Toolbar size={24} />
    </div>
  )
}

/** Every id on the page once, and every reference finds its target inside the same icon. */
function check(step: string) {
  const ids = [...document.querySelectorAll('[id]')].map((e) => e.id)
  expect(ids.length, step).toBeGreaterThan(withDefs.length)
  expect(ids.length - new Set(ids).size, `${step}: duplicate ids`).toBe(0)
  for (const svg of document.querySelectorAll('svg')) {
    for (const el of svg.querySelectorAll('[style*="url(#"], [fill^="url(#"], [clip-path^="url(#"]')) {
      const refs = `${el.getAttribute('style') ?? ''} ${el.getAttribute('fill') ?? ''} ${el.getAttribute('clip-path') ?? ''}`.matchAll(/url\(#([^)]+)\)/g)
      for (const [, id] of refs) {
        const target = document.getElementById(id!)
        expect(target, `${step}: ${id}`).not.toBeNull()
        expect(target!.closest('svg'), `${step}: ${id} resolves outside its icon`).toBe(svg)
      }
    }
  }
}

const roots: Root[] = []
afterEach(() => {
  act(() => roots.splice(0).forEach((r) => r.unmount()))
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
})

function mount(node: ReactNode): Root {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  roots.push(root)
  act(() => root.render(node))
  return root
}

describe('tool icon ids on a live page', () => {
  it('stay unique across mounted copies, repeated toolbars, size changes, theme switches and remounts', () => {
    expect(withDefs).toEqual(expect.arrayContaining(['cylinder', 'shell']))
    const a = mount(<Page size={32} theme="dark" />)
    mount(<Page size={32} theme="dark" />)
    check('two pages')

    act(() => a.render(<Page size={24} theme="dark" />))
    check('size change')

    for (const theme of ['light', 'dark', 'light']) {
      document.documentElement.setAttribute('data-theme', theme)
      act(() => a.render(<Page size={32} theme={theme} />))
      check(`theme ${theme}`)
    }

    // a theme switch that remounts the tree
    act(() => a.render(<div key="again"><Page size={32} theme="light" /></div>))
    check('remount')

    act(() => a.unmount())
    roots.splice(roots.indexOf(a), 1)
    mount(<Page size={24} theme="light" />)
    check('unmount and mount again')
  })
})
