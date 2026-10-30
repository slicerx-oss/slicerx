// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// heimdall's plate check before a slice, where the host has an engine: it starts a short pause after an edit, never
// while a drag edits the plate, a newer edit cancels the run in flight, and an answer for the plate as it sits replaces
// the footprint rule's verdict, holding nothing back. The warning reads a sure strike in the engine's words with Arrange
// and the one-click fixes, gives a strike only the slice can tell a muted line, says nothing for a close call, and adds
// a quiet line for what only the slice checks when another object is near.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { Collision, CollisionFix, Host, PlateCheck, SliceRequest, SliceResult } from '@slicerx/contracts'
import { readPlateCheck } from '@slicerx/contracts'
import { CHECK_DELAY_MS, CHECK_SLOW_MS, checkFixes, checkRows, checkingSlowly, engineVerdict, preflightProblem, startEngineCheck } from '../src/plate/engine-check'
import { printBlock } from '../src/plate/heimdall'
import { applyPlateCheckFix } from '../src/plate/heimdall-fix'
import { clearanceTrouble, sequenceProblem } from '../src/plate/sequence-check'
import { arrangePlate } from '../src/plate/edit'
import { beginLiveEdit, endLiveEdit } from '../src/state/live-edit'
import { get, set } from '../src/state/store'
import { EngineWarning, PreflightWarning } from '../src/workspaces/prepare/seq-warning'

function box(w: number, d: number, h: number) {
  const p = [0, 0, 0, w, 0, 0, w, d, 0, 0, d, 0, 0, 0, h, w, 0, h, w, d, h, 0, d, h]
  const i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7]
  return { name: 'box', slot: 1, positions: new Float32Array(p), indices: new Uint32Array(i) }
}

/** A 20 by 20 mm box 10 mm tall, its footprint's corner at `x`, 118 on the bed. */
function entry(id: string, name: string, x: number) {
  const handle = { id: `m-${id}`, hash: id, name, triangles: 12, bboxMm: [20, 20, 10], openEdges: 0, parts: [{ name: 'box', slot: 1, triangles: 12 }] }
  return { id, name, handle, parts: [box(20, 20, 10)], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 118, 0, 1] } as never
}

// The Bambu Lab A1: 40 mm around the nozzle, so 30 mm apart fails the footprint rule.
const A1 = { extruder_clearance_radius: 40, extruder_clearance_height_to_rod: 25, extruder_clearance_dist_to_rod: 56.5, extruder_clearance_height_to_lid: 256, nozzle_height: 4.76, skirt_loops: 0 }
const plates = (sequence: 'by-object' | 'by-layer') => [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence } }] as never

const hit = (objectId: string, hitId: string, part: Collision['part'] = 'toolhead', severity: Collision['severity'] = 'hit'): Collision => ({ kind: 'hotend', severity, part, objectId, hitId, layer: 0, segment: 0, timeS: 0, lastLayer: 30, at: [0, 0, 0.3], point: [0, 0, 0.3], worstLayer: 0, worstPoint: [0, 0, 0.3], depthMm: 4, hitHeightMm: 10 })
const reorder: CollisionFix = { kind: 'reorder', costS: 0, clears: [0], oneClick: true, order: ['b', 'a'] }
const byLayer: CollisionFix = { kind: 'by_layer', costS: 30, clears: [0, 1], oneClick: true, moves: 2 }
const answer = (over: Partial<PlateCheck> = {}): PlateCheck => ({ collisions: [], collisionFixes: [], certainty: [], unchecked: [], order: ['a', 'b'], micros: 900, ...over })
const SURE = answer({ collisions: [hit('b', 'a'), hit('b', 'a', 'nozzle')], certainty: ['sure', 'slice_decides'], collisionFixes: [reorder, byLayer] })
const DECIDES = answer({ collisions: [hit('b', 'a')], certainty: ['slice_decides'] })
const CLOSE = answer({ collisions: [hit('b', 'a', 'toolhead', 'close')], certainty: ['slice_decides'] })
const CLEAR = answer()

/** A host whose plate check answers when the test says, recording each request and its signal. */
function host() {
  const asked: { req: SliceRequest; signal: AbortSignal | undefined; answer: (r: PlateCheck) => void }[] = []
  const checkPlate = vi.fn((req: SliceRequest, opts?: { signal?: AbortSignal }) => new Promise<PlateCheck>((resolve) => asked.push({ req, signal: opts?.signal, answer: resolve })))
  const h = { kind: 'desktop', capabilities: { threads: 1 }, slicer: { loadModel: async () => ({}), loadParts: async () => ({}), checkPlate } } as unknown as Host
  return { h, asked, checkPlate }
}

const close30 = () => [entry('a', 'Cube A', 100), entry('b', 'Cube B', 150)]
const result = { id: 'r1', engine: 'sx', layerCount: 10, layerZ: new Float32Array(), layerTimeS: new Float32Array(), stats: { timeS: 600, filamentMm: [100], filamentG: [3], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1, warnings: [] } as SliceResult

beforeAll(async () => void (await Promise.all([import('../src/state/slice-plate'), import('../src/plate/layer-ranges'), import('../src/plate/layer-marks')])))

let stop: (() => void) | null = null
beforeEach(() => {
  vi.useFakeTimers()
  set({ plate: close30(), plates: plates('by-object'), activePlate: 'p1', overrides: { ...A1 }, profile: { printerId: 'bambu-a1' } as never, slice: { status: 'idle' }, liveEdit: false, historyEdit: null, plateLoading: false, calibration: {}, layerMarks: {}, resume: null, selection: null, selectedIds: [], toast: null })
})
afterEach(() => {
  stop?.()
  stop = null
  endLiveEdit()
  vi.useRealTimers()
})

const settle = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('when the plate check runs', () => {
  it('starts a short pause after an edit, once, with the slice request and nothing to write', async () => {
    const { h, asked } = host()
    stop = startEngineCheck(h)
    await settle(CHECK_DELAY_MS + 10)
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    asked[0]!.answer(CLEAR)
    set({ plate: [entry('a', 'Cube A', 100), entry('b', 'Cube B', 152)] })
    await settle(CHECK_DELAY_MS - 50)
    expect(asked).toHaveLength(1)
    await settle(60)
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    const req = asked[1]!.req
    expect(req.plate.objects.map((o) => o.id)).toEqual(['a', 'b'])
    expect(req.options).toMatchObject({ emitGcode: false, emitPreview: false, printerId: 'bambu-a1' })
    expect(CHECK_DELAY_MS).toBeLessThanOrEqual(300)
  })

  it('never runs while a drag edits the plate, and checks once on release', async () => {
    const { h, asked } = host()
    stop = startEngineCheck(h)
    beginLiveEdit()
    for (let x = 140; x < 150; x++) {
      set({ plate: [entry('a', 'Cube A', 100), entry('b', 'Cube B', x)] })
      await settle(400)
    }
    expect(asked).toHaveLength(0)
    endLiveEdit()
    await settle(CHECK_DELAY_MS + 10)
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    // the plate where the drag left it
    const [a, b] = asked[0]!.req.plate.objects
    expect(b!.transform[12]! - a!.transform[12]!).toBeCloseTo(49, 6)
  })

  it('lets a drag go on while a check is in flight: the footprint rule follows it at once', async () => {
    const { h, asked } = host()
    stop = startEngineCheck(h)
    await settle(CHECK_DELAY_MS + 10)
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    // The check never answers; the plate still moves, and the rule reads each move.
    beginLiveEdit()
    for (const x of [151, 160, 170]) {
      const t = performance.now()
      set({ plate: [entry('a', 'Cube A', 100), entry('b', 'Cube B', x)] })
      expect(performance.now() - t).toBeLessThan(50)
    }
    expect(clearanceTrouble(get())).toBeNull()
    set({ plate: [entry('a', 'Cube A', 100), entry('b', 'Cube B', 150)] })
    expect(clearanceTrouble(get())).not.toBeNull()
    expect(engineVerdict(get())).toBeNull()
  })

  it('cancels the run in flight on a newer edit and lets its answer go', async () => {
    const { h, asked } = host()
    stop = startEngineCheck(h)
    await settle(CHECK_DELAY_MS + 10)
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    set({ plate: [entry('a', 'Cube A', 100), entry('b', 'Cube B', 151)] })
    expect(asked[0]!.signal?.aborted).toBe(true)
    await settle(CHECK_DELAY_MS + 10)
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    asked[0]!.answer(SURE)
    await settle(1)
    expect(engineVerdict(get())).toBeNull()
    asked[1]!.answer(CLEAR)
    await vi.waitFor(() => expect(engineVerdict(get())).toBe(CLEAR))
  })

  it('says it is checking only once a run takes a moment', async () => {
    const { h, asked } = host()
    stop = startEngineCheck(h)
    await settle(CHECK_DELAY_MS + 10)
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    expect(checkingSlowly(get())).toBe(false)
    await settle(CHECK_SLOW_MS)
    expect(checkingSlowly(get())).toBe(true)
    const html = renderToStaticMarkup(createElement(PreflightWarning, { plan: clearanceTrouble(get()), check: null, checking: true }))
    expect(html).toContain('data-testid="slice-clearance-checking"')
    asked[0]!.answer(CLEAR)
    await vi.waitFor(() => expect(checkingSlowly(get())).toBe(false))
  })

  it('has the answer for a plate it checked before at once (undo)', async () => {
    const { h, asked, checkPlate } = host()
    stop = startEngineCheck(h)
    await settle(CHECK_DELAY_MS + 10)
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    asked[0]!.answer(SURE)
    await vi.waitFor(() => expect(engineVerdict(get())).toBe(SURE))
    const was = get().plate
    set({ plate: [entry('a', 'Cube A', 100), entry('b', 'Cube B', 170)] })
    await settle(CHECK_DELAY_MS + 10)
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    asked[1]!.answer(CLEAR)
    await vi.waitFor(() => expect(engineVerdict(get())).toBe(CLEAR))
    set({ plate: was })
    await settle(CHECK_DELAY_MS + 10)
    await vi.waitFor(() => expect(engineVerdict(get())).toBe(SURE))
    expect(checkPlate).toHaveBeenCalledTimes(2)
  })

  it('checks nothing by layer, and a host without the check keeps the footprint rule', async () => {
    const { h, asked } = host()
    set({ plates: plates('by-layer') })
    stop = startEngineCheck(h)
    await settle(CHECK_DELAY_MS + 10)
    expect(asked).toHaveLength(0)
    stop()
    stop = startEngineCheck({ slicer: { loadModel: async () => ({}) } } as never)
    set({ plates: plates('by-object') })
    await settle(CHECK_DELAY_MS + 10)
    expect(get().plateCheck.status).toBe('idle')
    expect(sequenceProblem(get())).not.toBeNull()
  })
})

describe('one verdict on screen', () => {
  const landed = async (r: PlateCheck) => {
    const { h, asked } = host()
    stop = startEngineCheck(h)
    await settle(CHECK_DELAY_MS + 10)
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    asked[0]!.answer(r)
    await vi.waitFor(() => expect(engineVerdict(get())).toBe(r))
  }

  it('replaces the footprint rule with the engine answer for the plate as it sits, until the next edit', async () => {
    // The footprint rule fails 30 mm apart on the A1.
    expect(sequenceProblem(get())).not.toBeNull()
    await landed(CLOSE)
    // A close call: the engine says nothing, and nothing holds the plate, not even a stale slice.
    expect(preflightProblem(get())).toBeNull()
    expect(renderToStaticMarkup(createElement(PreflightWarning, { plan: clearanceTrouble(get()), check: engineVerdict(get()), checking: false }))).toBe('')
    set({ slice: { status: 'done', result, stale: true } })
    expect(printBlock(get())).toBeNull()
    // A newer edit: the rule is back until the engine answers again.
    set({ plate: [entry('a', 'Cube A', 100), entry('b', 'Cube B', 149)] })
    expect(engineVerdict(get())).toBeNull()
    expect(printBlock(get())).toMatch(/Printing by object may collide/)
  })

  it('holds nothing back on a sure strike: the engine words it, and Print is left to the slice', async () => {
    await landed(SURE)
    set({ slice: { status: 'done', result, stale: true } })
    expect(printBlock(get())).toBeNull()
    expect(preflightProblem(get())).toBeNull()
  })
})

describe('the warning from the plate check', () => {
  // A client render: the warning reads the plate's names from the store, which a server render does not see.
  const render = (check: PlateCheck): string => {
    const el = document.createElement('div')
    const root = createRoot(el)
    flushSync(() => root.render(createElement(EngineWarning, { check, needMm: 40 })))
    const html = el.innerHTML
    flushSync(() => root.unmount())
    return html
  }

  it('reads a sure strike in the engine words with Arrange, a new order and print by layer', () => {
    const html = render(SURE)
    expect(html).toContain('data-testid="slice-clearance-warning"')
    expect(html).toContain('data-verdict="sure"')
    expect(html).toContain('The toolhead hits Cube A')
    expect(html).toContain('Cube A and Cube B')
    expect(html).toContain('data-testid="slice-clearance-arrange"')
    expect(html).toContain('data-testid="slice-clearance-fix-reorder"')
    expect(html).toContain('Print Cube A last')
    expect(html).toContain('data-testid="slice-clearance-fix-by-layer"')
    expect(html).toContain('Print by layer')
    expect(html).not.toContain('Too close to print by object')
    expect(html).not.toContain('May clash')
  })

  it('offers print by layer only when it clears every sure strike, and a new order only when one-click', () => {
    const partial = { ...SURE, collisions: [hit('b', 'a'), hit('c', 'a')], certainty: ['sure', 'sure'] as PlateCheck['certainty'], collisionFixes: [{ ...byLayer, clears: [0] }, { ...reorder, oneClick: false }] }
    expect(checkFixes(partial)).toEqual([])
    expect(checkFixes(SURE).map((f) => f.kind)).toEqual(['reorder', 'by_layer'])
  })

  it('gives a strike only the slice can tell a muted line and Arrange, in the calm tone', () => {
    const html = render(DECIDES)
    expect(html).toContain('data-tone="soft"')
    expect(html).toContain('data-verdict="slice-decides"')
    expect(html).toContain('Cube A and Cube B')
    expect(html).toContain('data-testid="slice-clearance-decides"')
    expect(html).toContain('May clash. Slice to check.')
    expect(html).toContain('data-testid="slice-clearance-arrange"')
    expect(html).not.toContain('slice-clearance-fix-')
  })

  it('shows the pair as a flat row and Arrange and the fixes as same-size buttons side by side', () => {
    const el = document.createElement('div')
    const root = createRoot(el)
    for (const check of [SURE, DECIDES]) {
      flushSync(() => root.render(createElement(EngineWarning, { check, needMm: 40 })))
      const row = el.querySelector('[data-testid="slice-clearance-select"]')!
      // The pair is a row, not a field: no bordered box class.
      expect(row.className.split(' ')).toContain('seq-card-row')
      expect(row.className).not.toContain('seq-card-line')
      expect(row.closest('.seq-card-actions')).toBeNull()
      const actions = el.querySelector('.seq-card-actions')!
      const buttons = [...actions.children]
      expect(buttons.length).toBe(check === SURE ? 3 : 1)
      for (const b of buttons) {
        expect(b.tagName).toBe('BUTTON')
        expect(b.getAttribute('type')).toBe('button')
        expect(b.className).toContain('sx-btn')
        // The default variant: a filled, bordered button; a ghost one reads as a label.
        expect(b.hasAttribute('data-variant')).toBe(false)
        expect(b.getAttribute('data-size')).toBe('sm')
      }
      expect(buttons[0]!.getAttribute('data-testid')).toBe('slice-clearance-arrange')
      // The headline keeps its line to itself.
      expect(el.querySelector('.seq-card-head [data-testid="slice-clearance-arrange"]')).toBeNull()
    }
    flushSync(() => root.unmount())
  })

  it('styles the pair row without a border and gives it and the buttons a focus ring', () => {
    const css = readFileSync(resolve(__dirname, '../src/workspaces/prepare/estimate-footer.css'), 'utf8')
    const rule = (sel: string) => css.split('\n').find((l) => l.startsWith(`${sel} {`)) ?? ''
    expect(rule('.seq-card-row')).toContain('border: none')
    expect(css).not.toContain('.seq-card-line')
    expect(rule('.seq-card-row:focus-visible')).toContain('outline: var(--focus-ring)')
    expect(rule('.seq-card-actions')).toContain('display: flex')
    const ui = readFileSync(resolve(__dirname, '../../ui/src/styles.css'), 'utf8')
    expect(ui).toMatch(/^:focus-visible \{ outline: var\(--focus-ring\)/m)
  })

  it('says nothing for a close call or a clear plate', () => {
    expect(render(CLOSE)).toBe('')
    expect(render(CLEAR)).toBe('')
    expect(checkRows(SURE)).toMatchObject({ sure: [{ a: 'a', b: 'b' }], decides: [] })
  })

  it('adds a quiet line for tool changes only when another object is near', () => {
    const near = render(answer({ unchecked: [{ objectId: 'a', what: 'tool_change_trips', near: ['b'] }] }))
    expect(near).toContain('data-testid="slice-clearance-unchecked"')
    expect(near).toContain('Tool changes: checked when you slice.')
    expect(near).not.toContain('slice-clearance-warning')
    expect(render(answer({ unchecked: [{ objectId: 'a', what: 'tool_change_trips', near: [] }] }))).toBe('')
    // An unknown kind from a newer engine is not worded.
    expect(render(answer({ unchecked: [{ objectId: 'a', what: 'something_new' as never, near: ['b'] }] }))).toBe('')
    const both = render({ ...SURE, unchecked: [{ objectId: 'a', what: 'tree_support', near: ['b'] }] })
    expect(both).toContain('Tree supports: checked when you slice.')
  })

  it('applies a fix as an edit: the new order, or the plate by layer', () => {
    applyPlateCheckFix(reorder)
    expect(get().plate.map((p) => p.id)).toEqual(['b', 'a'])
    applyPlateCheckFix(byLayer)
    expect(get().plates[0]!.settings).toMatchObject({ sequence: 'by-layer' })
  })
})

describe('arrange on a by-object plate with the plate check', () => {
  it('stops after the layout and says which pair is still sure to clash', async () => {
    vi.useRealTimers()
    const checkPlate = vi.fn(async () => SURE)
    stop = startEngineCheck({ kind: 'desktop', capabilities: { threads: 1 }, slicer: { loadModel: async () => ({}), loadParts: async () => ({}), checkPlate } } as unknown as Host)
    await arrangePlate('all')
    expect(checkPlate).toHaveBeenCalled()
    expect(get().toast).toMatchObject({ tone: 'warn', text: 'Arranged, but Cube A and Cube B still clash by object. The warning shows the fixes.' })
    expect(engineVerdict(get())).toBe(SURE)
  })

  it('says nothing more when the engine finds the layout clear', async () => {
    vi.useRealTimers()
    const checkPlate = vi.fn(async () => CLEAR)
    stop = startEngineCheck({ kind: 'desktop', capabilities: { threads: 1 }, slicer: { loadModel: async () => ({}), loadParts: async () => ({}), checkPlate } } as unknown as Host)
    await arrangePlate('all')
    expect(checkPlate).toHaveBeenCalled()
    expect(get().toast?.text ?? '').not.toMatch(/still clash/)
  })
})

describe('the plate check contract', () => {
  it('reads what the engine writes and refuses a certainty list that does not match', () => {
    const raw = JSON.parse(JSON.stringify(SURE))
    expect(readPlateCheck(raw)).toEqual(SURE)
    expect(() => readPlateCheck({ ...raw, certainty: ['sure'] })).toThrow(/certainty/)
    expect(() => readPlateCheck({ ...raw, certainty: ['sure', 'perhaps'] })).toThrow(/certainty/)
    expect(() => readPlateCheck({ collisions: [{}], certainty: ['sure'] })).toThrow(/collision/)
    expect(readPlateCheck({ collisions: [], certainty: [] })).toEqual({ collisions: [], collisionFixes: [], certainty: [], unchecked: [], order: [], micros: 0 })
  })
})
