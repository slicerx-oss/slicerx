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
import schema from '@slicerx/settings/schema.json'
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
    const ids = ['layer-height', 'strength', 'infill-density', 'wall-loops', 'speed', 'speed-quality', 'speed-balanced', 'speed-fast', 'speed-fastest', 'supports', 'supports-off', 'supports-auto', 'supports-painted', 'enable-support', 'brim', 'brim-type', 'history-suppress', 'history-view', 'history-earlier', 'history-later', 'keep-dimension', 'mirror-x', 'mirror-y', 'mirror-z', 'print-sequence', 'whole-loop', 'drop-to-bed', 'round-corners', 'brim-ears', 'move', 'lay-on-face', 'rotate', 'scale', 'adv-acceleration', 'adv-jerk', 'adv-flow-ratio', 'adv-flow-ratio-outer', 'adv-flow-ratio-inner', 'adv-flow-ratio-infill', 'adv-flow-ratio-top', 'adv-flow-ratio-first', 'adv-fuzzy-skin', 'adv-fuzzy-skin-distance', 'adv-avoid-crossing', 'adv-bridge-sag', 'adv-bridge-angle', 'adv-infill-direction', 'adv-draft-shield', 'adv-elephant-foot', 'adv-internal-bridge', 'adv-ironing', 'adv-make-printable', 'adv-min-layer-time', 'adv-nozzle-temperature', 'adv-brim-ears-detect', 'adv-counterbore', 'adv-narrow-solid', 'adv-arc-fitting', 'adv-overhang-walls', 'adv-fan-layer-time', 'adv-flush-infill', 'adv-infill-anchor', 'adv-combine-infill', 'adv-infill-overlap', 'adv-interlocking', 'adv-lightning', 'adv-min-feature', 'adv-polyhole', 'adv-precise-wall', 'adv-painted-interlock', 'adv-ooze', 'adv-overhang-speed', 'adv-overhang-fan', 'adv-overhang-reverse', 'adv-part-fan', 'adv-precise-z', 'adv-part-roles', 'adv-tower-spot', 'adv-path-resolution', 'adv-top-density', 'adv-pressure-advance', 'adv-prime-tower', 'adv-prime-tower-width', 'adv-prime-tower-infill-gap', 'adv-prime-volume', 'adv-prime-tower-brim-width', 'adv-raft-contact-distance', 'adv-raft-expansion', 'adv-raft-first-layer-density', 'adv-raft-first-layer-expansion', 'adv-extrusion-rate-smoothing', 'adv-rate-smoothing-segment-length', 'adv-rate-smoothing-outer-wall', 'adv-retraction-length', 'adv-retraction-speed', 'adv-deretraction-speed', 'adv-retraction-minimum-travel', 'adv-retract-when-changing-layer', 'adv-retract-lift-above', 'adv-retract-lift-below', 'adv-retract-lift-enforce', 'adv-retract-lift-toolchange', 'adv-seam-slope-type', 'adv-seam-slope-min-length', 'adv-seam-slope-steps', 'adv-seam-slope-start-height', 'adv-seam-slope-entire-loop', 'adv-scarf-joint-flow-ratio', 'adv-scarf-angle-threshold', 'adv-seam-position', 'adv-seam-gap', 'adv-staggered-inner-seams', 'adv-wipe-on-loops', 'adv-wipe-before-external-loop', 'adv-skeleton-infill-density', 'adv-skeleton-infill-line-width', 'adv-skin-infill-density', 'adv-skin-infill-depth', 'adv-skin-infill-line-width', 'adv-skirt-height', 'adv-skirt-start-angle', 'adv-skirt-type', 'adv-smart-layer-max-height', 'adv-smart-layer-min-height', 'adv-smart-layer-max-step-ratio', 'adv-smart-layer-smoothing', 'adv-smart-layer-smoothing-radius', 'adv-slicing-mode', 'adv-slowdown-for-curled-perimeters', 'adv-solid-infill-direction', 'adv-solid-infill-rotate-template', 'adv-outer-wall-speed', 'adv-inner-wall-speed', 'adv-sparse-infill-speed', 'adv-internal-solid-infill-speed', 'adv-top-surface-speed', 'adv-gap-infill-speed', 'adv-small-perimeter-speed', 'adv-small-perimeter-threshold', 'adv-travel-speed', 'adv-initial-layer-speed', 'adv-initial-layer-infill-speed', 'adv-initial-layer-travel-speed', 'adv-slow-down-layers', 'adv-spiral-mode', 'adv-spiral-mode-smooth', 'adv-spiral-starting-flow-ratio', 'adv-spiral-finishing-flow-ratio', 'adv-support-speed', 'adv-support-interface-speed', 'adv-small-support-perimeter-speed', 'adv-support-type', 'adv-support-critical-regions-only', 'adv-support-threshold-angle', 'adv-support-angle', 'adv-support-base-pattern', 'adv-support-base-pattern-spacing', 'adv-support-interface-pattern', 'adv-support-bottom-interface-spacing', 'adv-support-expansion', 'adv-support-ironing', 'adv-support-ironing-flow', 'adv-support-ironing-pattern', 'adv-support-ironing-spacing', 'adv-support-interface-fan-speed', 'adv-support-object-first-layer-gap', 'adv-support-on-build-plate-only', 'adv-support-remove-small-overhang', 'adv-travel-slope', 'adv-tree-support-branch-angle', 'adv-tree-support-angle-slow', 'adv-tree-support-branch-diameter', 'adv-tree-support-branch-diameter-angle', 'adv-tree-support-branch-distance', 'adv-tree-support-tip-diameter', 'adv-tree-support-top-rate', 'adv-tree-support-wall-count', 'adv-tree-support-brim-width', 'adv-max-volumetric-speed', 'adv-wall-sequence', 'adv-is-infill-first', 'adv-wall-direction', 'adv-wall-transition-length', 'adv-wall-transition-angle', 'adv-wall-transition-filter-deviation', 'adv-chamber-temperature', 'adv-cool-plate-temp', 'adv-eng-plate-temp', 'adv-hot-plate-temp', 'adv-supertack-plate-temp', 'adv-textured-cool-plate-temp', 'adv-textured-plate-temp', 'adv-wave-overhangs', 'adv-wave-overhang-line-spacing', 'adv-wave-overhang-perimeter-overlap', 'adv-wave-overhang-print-speed', 'adv-wave-overhang-flow', 'adv-wave-overhang-max-iterations', 'adv-wipe', 'adv-wipe-distance', 'adv-wipe-speed', 'adv-retract-before-wipe', 'adv-wipe-tower-rotation-angle', 'adv-wipe-tower-extra-spacing', 'adv-wipe-tower-extra-flow', 'adv-wipe-tower-max-purge-speed', 'adv-wipe-tower-no-sparse-layers', 'adv-wipe-tower-wall-type', 'adv-wipe-tower-filament', 'adv-wipe-tower-bridging', 'adv-xy-contour-compensation', 'adv-xy-hole-compensation', 'adv-z-hop', 'adv-z-hop-types', 'adv-z-offset', 'adv-solid-layers', 'adv-infill-patterns', 'adv-support-interface', 'adv-shrinkage', 'adv-bed-clearance', 'adv-extruder-type', 'adv-limits-graph', 'adv-one-nozzle']
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

  it('maps only setting keys the settings schema has', () => {
    const keys = new Set(schema.settings.map((d) => d.key))
    for (const k of Object.keys(SETTING_DEMOS)) expect(keys.has(k), k).toBe(true)
  })

  it('shares a loop between tools that do the same thing', () => {
    expect(DEMOS['facesvg']).toBe(DEMOS['face'])
    expect(DEMOS['simplify']).toBe(DEMOS['mesh'])
  })
})
