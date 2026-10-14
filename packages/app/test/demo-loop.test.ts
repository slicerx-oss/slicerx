// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Tooltip demo loops (the shared stage): a box of the stage's size holds the loop's place from the first frame, the
// loop's module loads when the tip shows, it waits paused until the tip's media stage and then plays, tip media off
// shows no loop, a loop's sentence is the tip text when the anchor has none, and every loop module is small.
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { setMotionPreference, TIP_TIMING, TooltipHost } from '@slicerx/ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEMOS, SETTING_DEMOS } from '../src/lib/demos'
import { loadTips, resolveTip } from '../src/lib/tip-host'
import { OPTION_TIPS, TIPS } from '../src/lib/tips'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
let anchor: HTMLButtonElement
let reduce = false

beforeAll(async () => {
  await loadTips()
})

function mount(media = true): void {
  act(() => root.render(createElement(TooltipHost, { resolve: (el: HTMLElement) => resolveTip(el, {}), media })))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.advanceTimersByTime(1000)
  reduce = false
  window.matchMedia = ((q: string) => ({ matches: reduce && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  setMotionPreference('system')
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver
  anchor = document.createElement('button')
  anchor.setAttribute('data-tip-title', 'Shape · Push and pull')
  anchor.setAttribute('data-tip-demo', 'push')
  document.body.append(anchor)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  anchor.remove()
  vi.useRealTimers()
})

const tip = () => document.getElementById('sx-tip')
const hover = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
const leave = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })))
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms))

const stage = () => tip()?.querySelector<HTMLElement>('.sx-demo') ?? null
// the lazy loop component, then the loop's own module: each import settles in its own round
const settle = async () => {
  for (let i = 0; i < 3; i++) await act(async () => void (await vi.dynamicImportSettled()))
}

describe('tooltip demo loop', () => {
  it('holds the loop\'s place from the first frame, then draws it paused until the media stage', async () => {
    mount()
    hover(anchor)
    wait(TIP_TIMING.cold)
    expect(tip()?.hasAttribute('data-demo')).toBe(true)
    expect(stage()?.style.aspectRatio).toBe('296 / 166')
    await settle()
    expect(stage()?.querySelector('svg.sxs')).not.toBeNull()
    expect(stage()?.hasAttribute('data-play')).toBe(false)
    wait(TIP_TIMING.media)
    expect(stage()?.hasAttribute('data-play')).toBe(true)
  })

  it('draws the loop in the same box whether or not it has loaded, so the tip keeps its size', async () => {
    mount()
    hover(anchor)
    wait(TIP_TIMING.cold)
    const before = stage()?.style.aspectRatio
    await settle()
    expect(stage()?.style.aspectRatio).toBe(before)
  })

  it('shows nothing of the demo with tip media turned off', () => {
    mount(false)
    hover(anchor)
    wait(TIP_TIMING.cold + TIP_TIMING.media)
    expect(tip()).not.toBeNull()
    expect(tip()?.querySelector('.sx-demo')).toBeNull()
  })

  it('shows the next tip\'s loop at once after one has loaded', async () => {
    mount()
    hover(anchor)
    wait(TIP_TIMING.cold)
    await settle()
    leave(anchor)
    wait(TIP_TIMING.hide + TIP_TIMING.warmWindow)
    hover(anchor)
    wait(TIP_TIMING.cold)
    expect(stage()?.querySelector('svg.sxs')).not.toBeNull()
  })

  it("uses the loop's sentence for a tool with no text of its own, and keeps a text the anchor has", async () => {
    mount()
    hover(anchor)
    wait(TIP_TIMING.cold)
    expect(tip()?.querySelector('.sx-tip-body')?.textContent).toBe(DEMOS['push']?.body)
    leave(anchor)
    wait(TIP_TIMING.hide + TIP_TIMING.warmWindow)
    anchor.setAttribute('data-tip-body', 'Drag a flat face in or out.')
    hover(anchor)
    wait(TIP_TIMING.cold)
    expect(tip()?.querySelector('.sx-tip-body')?.textContent).toBe('Drag a flat face in or out.')
  })

  it('ignores an id with no loop', () => {
    anchor.setAttribute('data-tip-demo', 'no-such-tool')
    mount()
    hover(anchor)
    wait(TIP_TIMING.cold + TIP_TIMING.media)
    expect(tip()).not.toBeNull()
    expect(tip()?.querySelector('.sx-demo')).toBeNull()
  })
})

describe('demo loops', () => {
  it('names only loops that exist', () => {
    const named = [...Object.values(TIPS), ...Object.values(OPTION_TIPS)].flatMap((t) => ('demo' in t && t.demo ? [t.demo] : []))
    for (const id of named) expect(DEMOS[id], id).toBeDefined()
  })

  it('has every one of the 17 loops, each with a sentence and a small module', async () => {
    const own = ['push', 'sketch', 'face', 'add', 'fillet', 'shell', 'subtract', 'cut', 'array', 'holefit', 'thread', 'mesh', 'sleipnir', 'aegis', 'atlas', 'heimdall', 'norn']
    for (const id of own) {
      const d = DEMOS[id]
      expect(d?.stage, id).toBeTypeOf('function')
      expect(d?.body?.length, id).toBeGreaterThan(20)
      const tool = await d!.stage!()
      expect(tool.id, id).toMatch(/^[a-z]{2,}$/)
    }
    for (const f of ['push', 'sketch', 'face', 'add', 'fillet', 'shell', 'subtract', 'cut', 'array', 'hole', 'thread', 'mesh', 'sleipnir', 'aegis', 'atlas', 'heimdall', 'norn']) {
      expect(statSync(join(import.meta.dirname, '../src/demos', `${f}.ts`)).size, f).toBeLessThanOrEqual(8 * 1024)
    }
  })

  it('has every settings, model tool and advanced loop, each with a sentence and a module under 8 KB', async () => {
    const ids = ['layer-height', 'strength', 'infill-density', 'wall-loops', 'speed', 'speed-quality', 'speed-balanced', 'speed-fast', 'speed-fastest', 'supports', 'supports-off', 'supports-auto', 'supports-painted', 'enable-support', 'brim', 'brim-type', 'history-suppress', 'history-view', 'history-earlier', 'history-later', 'keep-dimension', 'mirror-x', 'mirror-y', 'mirror-z', 'print-sequence', 'whole-loop', 'drop-to-bed', 'round-corners', 'brim-ears', 'move', 'lay-on-face', 'rotate', 'scale', 'adv-acceleration', 'adv-jerk', 'adv-flow-ratio', 'adv-flow-ratio-outer', 'adv-flow-ratio-inner', 'adv-flow-ratio-infill', 'adv-flow-ratio-top', 'adv-flow-ratio-first', 'adv-fuzzy-skin', 'adv-fuzzy-skin-distance', 'adv-avoid-crossing', 'adv-bridge-sag', 'adv-bridge-angle', 'adv-infill-direction', 'adv-draft-shield', 'adv-elephant-foot', 'adv-internal-bridge', 'adv-ironing', 'adv-make-printable', 'adv-min-layer-time', 'adv-nozzle-temperature']
    const seen = new Map<string, string>()
    for (const id of ids) {
      const d = DEMOS[id]
      expect(d?.stage, id).toBeTypeOf('function')
      expect(d?.body?.length, id).toBeGreaterThan(10)
      const tool = await d!.stage!()
      // the loop's id prefixes its classes and keyframes, and every tip shares one document
      expect(seen.get(tool.id), `${id} shares ${tool.id}`).toBeUndefined()
      seen.set(tool.id, id)
      expect(statSync(join(import.meta.dirname, '../src/demos', `${id}.ts`)).size, id).toBeLessThanOrEqual(8 * 1024)
    }
  })

  it('points each settings row and choice at its own loop', () => {
    for (const id of Object.values(SETTING_DEMOS)) expect(DEMOS[id], id).toBeDefined()
    expect(SETTING_DEMOS['sparse_infill_density']).toBe('infill-density')
    expect(SETTING_DEMOS['wall_loops']).toBe('wall-loops')
    // a setting that shares a drawing picks out its own part of it
    expect(SETTING_DEMOS['outer_wall_flow_ratio']).toBe('adv-flow-ratio-outer')
    expect(SETTING_DEMOS['fuzzy_skin_point_distance']).toBe('adv-fuzzy-skin-distance')
    expect(SETTING_DEMOS['travel_jerk']).toBe('adv-jerk')
    for (const k of ['tool.move', 'tool.rotate', 'tool.scale', 'tool.placeOnFace', 'tool.brim', 'plate.drop', 'history.suppress', 'history.view', 'history.earlier', 'history.later', 'cad.keepDimension', 'cad.edgeLoop', 'sketch.corners'] as const) {
      const t = TIPS[k] as { demo?: string }
      expect(t.demo && DEMOS[t.demo], k).toBeDefined()
    }
  })

  it('shares a loop between tools that do the same thing', () => {
    expect(DEMOS['facesvg']).toBe(DEMOS['face'])
    expect(DEMOS['simplify']).toBe(DEMOS['mesh'])
  })
})
