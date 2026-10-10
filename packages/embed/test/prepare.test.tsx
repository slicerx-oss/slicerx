// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The embedded view as a Prepare step, over a stand-in viewport: the toolbar and its keys, selection and transforms
// passed through, drop to bed, the reveal per plate and the bed outline.
import type { Viewport as Handle, ViewportEvents, ViewportPlate } from '@slicerx/viewport'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toolsAttr } from '../src/elements'
import { plateKey, Viewport, type ViewportProps } from '../src/viewport'

type Calls = { name: string; args: unknown[] }[]
let calls: Calls = []
let listeners: { [E in keyof ViewportEvents]?: ((p: ViewportEvents[E]) => void)[] } = {}
let created: Record<string, unknown>[] = []

function stub(): Handle {
  const record = (name: string) => (...args: unknown[]) => {
    calls.push({ name, args })
    return name === 'playReveal' ? true : name === 'arrange' || name === 'dropToBed' ? {} : undefined
  }
  return new Proxy({} as Handle, {
    get: (_, key: string) => {
      if (key === 'on') return (e: keyof ViewportEvents, cb: never) => ((listeners[e] ??= []).push(cb), () => {})
      return record(key)
    },
  })
}

vi.mock('@slicerx/viewport', () => ({
  createViewport: (_: HTMLCanvasElement, opts: Record<string, unknown>) => {
    created.push(opts)
    return stub()
  },
}))

const emit = <E extends keyof ViewportEvents>(e: E, p: ViewportEvents[E]) => act(() => listeners[e]?.forEach((cb) => cb(p)))
const named = (name: string) => calls.filter((c) => c.name === name).map((c) => c.args)
const plate = (...ids: string[]): ViewportPlate => ({ bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, objects: ids.map((id) => ({ id, name: id, parts: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })) })

let host: HTMLDivElement
let root: Root
const draw = (p: ViewportProps) => act(() => root.render(<Viewport {...p} />))
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
const press = (key: string) => act(() => host.querySelector('.sxe-viewport')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  listeners = {}
  created = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('the Prepare toolbar', () => {
  it('is off by default, and the view keeps its select tool', async () => {
    await draw({ plate: plate('a') })
    expect(host.querySelector('[role=toolbar]')).toBeNull()
    expect(named('setTool').at(-1)).toEqual(['select'])
    expect(named('setMoveHandles').at(-1)).toEqual([false])
  })

  it('shows every tool with tools on, starts on move, and keeps each button in place when pressed', async () => {
    await draw({ plate: plate('a'), tools: true })
    const labels = [...host.querySelectorAll('[role=toolbar] button')].map((b) => b.getAttribute('aria-label'))
    expect(labels).toEqual(['Select', 'Move', 'Rotate', 'Scale', 'Arrange', 'Drop to bed'])
    expect(named('setTool').at(-1)).toEqual(['move'])
    expect(button('Move').getAttribute('aria-pressed')).toBe('true')
    expect(named('setMoveHandles').at(-1)).toEqual([true])
    await act(() => button('Rotate').click())
    expect(named('setTool').at(-1)).toEqual(['rotate'])
    expect(button('Rotate').getAttribute('aria-pressed')).toBe('true')
    expect(button('Move').getAttribute('aria-pressed')).toBe('false')
    // the plate actions are not toggles, and drop is there with nothing selected
    expect(button('Arrange').hasAttribute('aria-pressed')).toBe(false)
    expect(button('Drop to bed').disabled).toBe(false)
    expect([...host.querySelectorAll('[role=toolbar] button')].map((b) => b.getAttribute('aria-label'))).toEqual(labels)
  })

  it('takes a list of tools, and the keys follow it', async () => {
    const changed: string[] = []
    await draw({ plate: plate('a'), tools: ['move', 'scale', 'arrange'], onToolChange: (t) => changed.push(t) })
    expect([...host.querySelectorAll('[role=toolbar] button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Move', 'Scale', 'Arrange'])
    await press('s')
    await press('r')
    await press('a')
    expect(changed).toEqual(['scale'])
    expect(named('arrange')).toEqual([[{ animate: true }]])
  })

  it('follows a controlled tool', async () => {
    const changed: string[] = []
    await draw({ plate: plate('a'), tools: true, tool: 'scale', onToolChange: (t) => changed.push(t) })
    await act(() => button('Move').click())
    expect(changed).toEqual(['move'])
    expect(button('Scale').getAttribute('aria-pressed')).toBe('true')
  })

  it('selects the only object for rotate and scale, so their handles show', async () => {
    const picked: string[][] = []
    await draw({ plate: plate('a'), tools: true, onSelect: (ids) => picked.push(ids) })
    await act(() => button('Rotate').click())
    expect(named('setSelection')).toEqual([[['a']]])
    expect(picked).toEqual([['a']])
    // already selected, nothing changes; two objects, the person picks one
    await act(() => button('Scale').click())
    expect(named('setSelection')).toHaveLength(1)
    calls = []
    await draw({ plate: plate('b', 'c'), tools: true })
    await emit('select', { ids: [] })
    await act(() => button('Rotate').click())
    expect(named('setSelection')).toHaveLength(0)
  })

  it('drops the selection to the bed, or every object with nothing selected', async () => {
    await draw({ plate: plate('a', 'b'), tools: true })
    await act(() => button('Drop to bed').click())
    await emit('select', { ids: ['b'] })
    await act(() => button('Drop to bed').click())
    expect(named('dropToBed')).toEqual([[undefined], [['b']]])
  })
})

describe('selection and transforms', () => {
  it('reports the view selection and every transform', async () => {
    const picked: string[][] = []
    const moved: unknown[] = []
    await draw({ plate: plate('a'), onSelect: (ids) => picked.push(ids), onTransform: (e) => moved.push(e) })
    await emit('select', { ids: ['a'] })
    const t = { id: 'a', transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1], final: true }
    await emit('transform', t)
    expect(picked).toEqual([['a']])
    expect(moved).toEqual([t])
  })

  it('passes a controlled selection to the view', async () => {
    await draw({ plate: plate('a', 'b'), selection: ['b'] })
    await draw({ plate: plate('a', 'b'), selection: [] })
    expect(named('setSelection')).toEqual([[['b']], [[]]])
  })
})

describe('the plate reveal', () => {
  it('plays on the first plate only by default', async () => {
    await draw({ plate: plate('a') })
    await draw({ plate: plate('b') })
    expect(created[0]?.['reveal']).toBe(true)
    expect(named('playReveal')).toHaveLength(0)
  })

  it('plays again for each new plate, not for the same objects moved', async () => {
    await draw({ plate: plate('a'), reveal: 'each-plate' })
    await draw({ plate: plate('a'), reveal: 'each-plate' })
    await draw({ plate: plate('b', 'c'), reveal: 'each-plate' })
    expect(named('playReveal')).toHaveLength(2)
    expect(plateKey(plate('b', 'c'))).not.toBe(plateKey(plate('b')))
  })

  it('is off with reveal false', async () => {
    await draw({ plate: plate('a'), reveal: false })
    expect(created[0]?.['reveal']).toBe(false)
  })
})

describe('the bed outline', () => {
  it('is the default unless asked to be subtle', async () => {
    await draw({ plate: plate('a') })
    await draw({ plate: plate('a'), bedOutline: 'subtle' })
    expect(named('setBedOutline')).toEqual([['default'], ['subtle']])
  })
})

describe('the tools attribute', () => {
  it('reads present, absent and listed', () => {
    expect(toolsAttr(null)).toBe(false)
    expect(toolsAttr('')).toBe(true)
    expect(toolsAttr('true')).toBe(true)
    expect(toolsAttr('false')).toBe(false)
    expect(toolsAttr('move rotate, drop nonsense')).toEqual(['move', 'rotate', 'drop'])
  })
})
