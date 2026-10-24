// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Print by object on a bed slinger: objects placed closer or taller than the printer profile allows get a heads-up on
// the plate as it sits; the slice goes ahead, heimdall's strikes in it hold Print and Export back, and a slice from
// before the objects moved is held to the profile's rule.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Collision, Host, SliceResult } from '@slicerx/contracts'
import { arrangePlate } from '../src/plate/edit'
import { installPrintMargins } from '../src/plate/footprint'
import { hullOf } from '../src/plate/arrange'
import { clearanceProblems, clearanceTrouble, footprint, hullDistance, sequenceProblem } from '../src/plate/sequence-check'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClearanceWarning, selectClearance } from '../src/workspaces/prepare/seq-warning'
import { exportGcode3mf } from '../src/export/actions'
import { exportGcode, jobFileName, jobName, sendToPrinter, slicePlate } from '../src/state/actions'
import { get, set } from '../src/state/store'

// The printer layer is the profile these tests set by hand; the sync that would rebuild it from a printer stays out.
vi.mock('../src/state/profile-sync', async (load) => ({ ...(await load<typeof import('../src/state/profile-sync')>()), profileReady: async () => {} }))

/** A closed box, `w` by `d` by `h` mm, its footprint's corner at the origin. */
function box(w: number, d: number, h: number) {
  const p = [0, 0, 0, w, 0, 0, w, d, 0, 0, d, 0, 0, 0, h, w, 0, h, w, d, h, 0, d, h]
  const i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7]
  return { name: 'box', slot: 1, positions: new Float32Array(p), indices: new Uint32Array(i) }
}

/** A 20 by 20 mm box `h` tall, its footprint's corner at `x`, `y` on the bed. */
function entry(id: string, name: string, x: number, y: number, h: number) {
  const handle = { id, hash: id, name, triangles: 12, bboxMm: [20, 20, h], openEdges: 0, parts: [{ name: 'box', slot: 1, triangles: 12 }] }
  return { id, name, handle, parts: [box(20, 20, h)], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1] } as never
}

// The Bambu Lab A1: 40 mm around the nozzle, the gantry rod 25 mm up and 56.5 mm behind it, the lid at 256 mm.
const A1 = { extruder_clearance_radius: 40, extruder_clearance_height_to_rod: 25, extruder_clearance_dist_to_rod: 56.5, extruder_clearance_height_to_lid: 256, nozzle_height: 4.76 }
/** The printer profile the slice names: its head is the one heimdall moves, estimated on the A1, measured on the P1S. */
const profileOf = (printerId: string) => ({ printerId }) as never

describe('the by-object clearance check', () => {
  const check = (a: [number, number, number], b: [number, number, number], cfg: Record<string, number> = A1) => clearanceProblems([entry('a', 'Cube A', ...a), entry('b', 'Cube B', ...b)], cfg, 'bambu-a1').join('; ')

  it('holds a Bambu Lab printer to the radius heimdall uses, the profile\'s max radius', () => {
    const bambu = { ...A1, printer_model: 'Bambu Lab A1', extruder_clearance_max_radius: 73 } as unknown as Record<string, number>
    expect(check([100, 118, 10], [170, 118, 10], bambu)).toMatch(/50\.0 mm apart; printing by object needs 73 mm between objects/)
    expect(check([100, 118, 10], [193, 118, 10], bambu)).toBe('')
    // Orca's Bambu Lab profiles carry it in extruder_clearance_radius, the max radius left at its default
    const orca = { ...A1, printer_model: 'Bambu Lab A1', extruder_clearance_radius: 73 } as unknown as Record<string, number>
    expect(check([100, 118, 10], [170, 118, 10], orca)).toMatch(/needs 73 mm between objects/)
  })

  it('counts the support round a part only when that part gets support', () => {
    // A 20 mm box with a 30 mm slab over it, 5 mm out each side at 10 mm: a flat underside that support holds up.
    const ledge = (id: string, name: string, x: number) => {
      const e = entry(id, name, x, 118, 10) as unknown as { parts: ReturnType<typeof box>[]; handle: { bboxMm: number[] } }
      const top = box(30, 20, 3)
      for (let i = 0; i < top.positions.length; i += 3) {
        top.positions[i] = top.positions[i]! - 5
        top.positions[i + 2] = top.positions[i + 2]! + 10
      }
      e.parts = [...e.parts, top]
      return e as never
    }
    const tree = { ...A1, brim_type: 'no_brim', skirt_loops: 0, enable_support: true, support_type: 'tree(auto)', support_threshold_angle: 25 } as unknown as Record<string, number>
    const off = { ...tree, enable_support: false } as unknown as Record<string, number>
    const pair = (b: never, cfg: Record<string, number>, own = {}) => clearanceProblems([entry('a', 'Cube A', 100, 118, 10), b], cfg, 'bambu-a1', own).join('; ')
    // 45 mm apart, past the 40 mm radius, but the tree support pad round the ledge reaches 7.9 mm toward the cube.
    expect(pair(ledge('b', 'Ledge B', 170), tree)).toMatch(/^Cube A and Ledge B are 37\.1 mm apart, counting the brim, skirt or support round Ledge B/)
    // A box with nothing to hold up prints no support, so nothing reaches past it; nor does the ledge with support off.
    expect(pair(entry('b', 'Cube B', 165, 118, 10), tree)).toBe('')
    expect(pair(ledge('b', 'Ledge B', 170), off)).toBe('')
    // The object's own settings decide: support off on the ledge alone, or on for it alone.
    expect(pair(ledge('b', 'Ledge B', 170), tree, { b: { enable_support: false } })).toBe('')
    expect(pair(ledge('b', 'Ledge B', 170), off, { b: { enable_support: true } })).toMatch(/37\.1 mm apart, counting the brim, skirt or support round Ledge B/)
    // An enforcer on a box asks for support, so its pad counts.
    const enforced = { ...(entry('b', 'Cube B', 165, 118, 10) as object), volumes: [{ id: 'v', name: 'Enforcer', role: 'support_enforcer' }] } as never
    expect(pair(enforced, tree)).toMatch(/Cube A and Cube B are 37\.1 mm apart, counting the brim, skirt or support round Cube B/)
  })

  it('refuses objects closer than the clearance radius and passes them at it', () => {
    expect(check([100, 118, 10], [150, 118, 10])).toMatch(/^Cube A and Cube B are 30\.0 mm apart; printing by object needs 40 mm between objects/)
    expect(check([100, 118, 10], [160, 118, 10])).toBe('')
    // Two plates under the nozzle height meet only the nozzle.
    expect(check([100, 118, 2], [130, 118, 2])).toBe('')
    // Corner to corner on a diagonal the footprints are further apart than their boxes.
    expect(check([100, 100, 10], [149, 149, 10])).toBe('')
  })

  it('holds the object that prints first under the rod where the gantry passes over it, and under the lid elsewhere', () => {
    expect(check([60, 118, 30], [140, 118, 6])).toMatch(/Cube A is 30\.0 mm tall and prints before another object; the gantry clears 25 mm/)
    // Printed last, a tall object is fine.
    expect(check([60, 118, 6], [140, 118, 30])).toBe('')
    // 100 mm apart in y the rod never reaches it.
    expect(check([118, 40, 30], [118, 160, 6])).toBe('')
    expect(check([118, 40, 30], [118, 160, 6], { ...A1, extruder_clearance_height_to_lid: 28 })).toMatch(/the lid clears 28 mm/)
    // 40 mm apart in y is within the rod distance.
    expect(check([118, 40, 30], [118, 100, 6])).toMatch(/the gantry clears 25 mm/)
  })
})

const plates = (sequence: 'by-object' | 'by-layer') => [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence } }] as never
const result = { id: 'r1', engine: 'sx', layerCount: 10, layerZ: new Float32Array(), layerTimeS: new Float32Array(), stats: { timeS: 600, filamentMm: [100], filamentG: [3], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1, warnings: [] } as SliceResult
const strike: Collision = { kind: 'gantry', severity: 'hit', part: 'gantry', objectId: 'b', hitId: 'a', layer: 5, segment: 0, timeS: 300, lastLayer: 9, at: [0, 0, 1], point: [0, 0, 26], worstLayer: 5, worstPoint: [0, 0, 26], depthMm: 4, hitHeightMm: 30, limitMm: 25 }
const struck = { ...result, collisions: [strike], collisionFixes: [] } as SliceResult

describe('a plate placed too close or too tall by object', () => {
  beforeEach(() =>
    set({
      plate: [entry('a', 'Cube A', 100, 118, 10), entry('b', 'Cube B', 150, 118, 10)],
      plates: plates('by-object'),
      activePlate: 'p1',
      overrides: { ...A1 },
      profile: profileOf('bambu-a1'),
      // A slice from before Cube B was moved next to Cube A.
      slice: { status: 'done', result, stale: true },
      printSheet: null,
      toast: null,
      calibration: {},
      layerMarks: {},
      resume: null,
    }),
  )

  it('names the objects and the fix, and says nothing by layer or once they are apart', () => {
    expect(sequenceProblem(get())).toMatch(/^Printing by object may collide: Cube A and Cube B are 30\.0 mm apart.*Slice to see where heimdall finds a strike, or move the objects apart, print the tall one last, or print by layer\.$/)
    set({ plates: plates('by-layer') })
    expect(sequenceProblem(get())).toBeNull()
    set({ plates: plates('by-object'), plate: [entry('a', 'Cube A', 100, 118, 10), entry('b', 'Cube B', 170, 118, 10)] })
    expect(sequenceProblem(get())).toBeNull()
  })

  it('is sliced, so heimdall checks every move, and says which printer it slices for', async () => {
    const slice = vi.fn(async (_req: unknown) => struck)
    set({ profile: { printerId: 'bambu-a1', nozzle: 0.4, nozzles: [0.4], nozzleFrom: 'default', tier: 'standard', source: 'orca', shippedGcode: true, gcodeKeys: [], limits: {} } })
    await slicePlate({ kind: 'web', capabilities: { threads: 1 }, slicer: { slice, loadParts: async () => ({ id: 'm' }), getPreview: async () => new ArrayBuffer(0) } } as unknown as Host).catch(() => {})
    const s = get().slice
    expect(slice, s.status === 'error' ? s.message : s.status).toHaveBeenCalledTimes(1)
    expect((slice.mock.calls[0]![0] as { options: { printerId?: string } }).options.printerId).toBe('bambu-a1')
  })

  it('exports no G-code and sends nothing, even from the slice before the move', async () => {
    const saved: string[] = []
    const exportOut = vi.fn(async () => ({ fileName: 'x.gcode', bytes: 1, sha256: '', blob: new Blob(['G28']) }))
    const host = { kind: 'web', files: { save: async (n: string) => void saved.push(n) }, printers: { status: async () => ({ state: 'idle' }) }, approvals: {}, slicer: { exportGcode: exportOut } } as unknown as Host
    await exportGcode(host)
    expect(saved).toEqual([])
    expect(get().toast).toMatchObject({ tone: 'error', text: expect.stringMatching(/Cube A and Cube B are 30\.0 mm apart/) })
    await sendToPrinter(host, { id: 'p1', name: 'A1', vendor: 'Bambu Lab', model: 'A1', plugin: 'demo', nozzleCount: 1 } as never)
    expect(get().printSheet).toBeNull()
    expect(exportOut).not.toHaveBeenCalled()
    // Moved apart, the same slice exports.
    set({ plate: [entry('a', 'Cube A', 100, 118, 10), entry('b', 'Cube B', 170, 118, 10)], slice: { status: 'done', result, stale: false } })
    await exportGcode(host)
    expect(saved).toHaveLength(1)
  })

  it('exports nothing from a slice with a strike in it, and says what heimdall found', async () => {
    const saved: string[] = []
    const host = { kind: 'web', capabilities: { threads: 1 }, files: { save: async (n: string) => void saved.push(n) }, slicer: { exportGcode: vi.fn() } } as unknown as Host
    set({ plate: [entry('a', 'Cube A', 100, 118, 10), entry('b', 'Cube B', 170, 118, 10)], slice: { status: 'done', result: struck, stale: false }, toast: null })
    await exportGcode(host)
    expect(saved).toEqual([])
    expect(get().toast).toMatchObject({ tone: 'error', text: expect.stringMatching(/^heimdall found a collision on this plate\./) })
    set({ toast: null })
    expect(await exportGcode3mf(host)).toBe(false)
    expect(get().toast).toMatchObject({ tone: 'error', text: expect.stringMatching(/^heimdall found a collision/) })
  })
})

describe('the short by-object warning', () => {
  beforeEach(() => set({ plate: [entry('a', 'Cube A', 100, 118, 10), entry('b', 'Cube B', 150, 118, 10), entry('c', 'Cube C', 100, 20, 10)], plates: plates('by-object'), activePlate: 'p1', overrides: { ...A1 }, profile: profileOf('bambu-a1'), slice: { status: 'idle' } as never, selection: null, selectedIds: [] }))

  it('names the closest pair with its gap and the radius, and counts the rest', () => {
    const plan = clearanceTrouble(get())!
    expect(plan.pairs.map((p) => [p.a.id, p.b.id, Math.round(p.gapMm)])).toEqual([['a', 'b', 30]])
    const html = renderToStaticMarkup(createElement(ClearanceWarning, { plan }))
    expect(html).toContain('data-testid="slice-clearance-warning"')
    expect(html).toContain('Too close to print by object')
    expect(html).toContain('Cube A and Cube B')
    // the number and its unit stay on one line
    expect(html).toContain('30 of 40\u00a0mm')
    expect(html).toMatch(/class="seq-card-fig">30 of 40\u00a0mm</)
    expect(html).toContain('data-testid="slice-clearance-arrange"')
  })

  it('gives a pair a measured head clears a calm note of one line with Arrange, and keeps the red for the A1', () => {
    set({ profile: profileOf('bambu-p1s') })
    const plan = clearanceTrouble(get())!
    expect(plan.pairs.map((p) => [p.a.id, p.b.id, p.severity])).toEqual([['a', 'b', 'soft']])
    const html = renderToStaticMarkup(createElement(ClearanceWarning, { plan }))
    expect(html).toContain('data-tone="soft"')
    expect(html).toContain('Cube A and Cube B are close (30 of 40\u00a0mm). Check them before you print.')
    expect(html).not.toContain('Too close to print by object')
    expect(html).toContain('data-testid="slice-clearance-arrange"')
    // heimdall slices a close call, so there is no problem to hold the slice to
    expect(sequenceProblem(get())).toBeNull()
    expect(selectClearance(plan)).toEqual(['a', 'b'])
    set({ profile: profileOf('bambu-a1') })
    const red = renderToStaticMarkup(createElement(ClearanceWarning, { plan: clearanceTrouble(get())! }))
    expect(red).toContain('Too close to print by object')
    expect(red).not.toContain('data-tone="soft"')
  })

  it('selects the pair it names, the first one primary', () => {
    expect(selectClearance(clearanceTrouble(get())!)).toEqual(['a', 'b'])
    expect(get().selection).toBe('a')
    expect(get().selectedIds).toEqual(['a', 'b'])
  })

  it('reads as pressed while its pair is the selection, in either order, and a click on it selects them', async () => {
    const { flushSync } = await import('react-dom')
    const { createRoot } = await import('react-dom/client')
    const plan = clearanceTrouble(get())!
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el)
    flushSync(() => root.render(createElement(ClearanceWarning, { plan })))
    const row = () => el.querySelector('[data-testid="slice-clearance-select"]')!.getAttribute('aria-pressed')
    expect(row()).toBe('false')
    flushSync(() => (el.querySelector('[data-testid="slice-clearance-select"]') as HTMLButtonElement).click())
    expect(get().selectedIds).toEqual(['a', 'b'])
    expect(row()).toBe('true')
    flushSync(() => set({ selection: 'b', selectedIds: ['b', 'a'] }))
    expect(row()).toBe('true')
    // one of the two, or a third object with them, is another selection
    flushSync(() => set({ selection: 'a', selectedIds: ['a'] }))
    expect(row()).toBe('false')
    flushSync(() => set({ selection: 'a', selectedIds: ['a', 'b', 'c'] }))
    expect(row()).toBe('false')
    flushSync(() => root.unmount())
    el.remove()
  })

  it('has nothing to say once the objects are apart or the plate prints by layer', () => {
    set({ plate: [entry('a', 'Cube A', 100, 118, 10), entry('b', 'Cube B', 160, 118, 10)] })
    expect(clearanceTrouble(get())).toBeNull()
    set({ plate: [entry('a', 'Cube A', 100, 118, 10), entry('b', 'Cube B', 150, 118, 10)], plates: plates('by-layer') })
    expect(clearanceTrouble(get())).toBeNull()
  })
})

describe('arrange on a by-object plate', () => {
  const footprint = (e: unknown) => {
    const t = (e as { transform: number[] }).transform
    const [x, y] = [t[12]!, t[13]!]
    return [[x, y], [x + 20, y], [x + 20, y + 20], [x, y + 20]] as [number, number][]
  }

  it('keeps the extruder clearance between objects, as Orca and Bambu Studio do', async () => {
    installPrintMargins(get)
    const plate = [entry('a', 'Cube A', 0, 0, 10), entry('b', 'Cube B', 0, 0, 10), entry('c', 'Cube C', 0, 0, 10)]
    set({ bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, plate, plates: plates('by-object'), activePlate: 'p1', overrides: { ...A1, brim_type: 'no_brim', skirt_loops: 0 }, selection: null, selectedIds: [] })
    await arrangePlate('all', { gapMm: 6, rotate: false })
    expect(sequenceProblem(get())).toBeNull()
    const [a, b, c] = get().plate.map(footprint)
    for (const [p, q] of [[a, b], [a, c], [b, c]] as const) expect(hullDistance(p!, q!)).toBeGreaterThanOrEqual(40)
    // By layer the gap is the arrange setting.
    set({ plate, plates: plates('by-layer') })
    await arrangePlate('all', { gapMm: 6, rotate: false })
    expect(hullDistance(footprint(get().plate[0]), footprint(get().plate[1]))).toBeLessThan(10)
  })

  it('keeps the radius the check holds a Bambu Lab printer to, the max radius of the profile', async () => {
    installPrintMargins(get)
    const plate = [entry('a', 'Cube A', 0, 0, 10), entry('b', 'Cube B', 0, 0, 10), entry('c', 'Cube C', 0, 0, 10)]
    const bambu = { ...A1, printer_model: 'Bambu Lab A1', extruder_clearance_max_radius: 73, brim_type: 'no_brim', skirt_loops: 0 }
    set({ bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, plate, plates: plates('by-object'), activePlate: 'p1', overrides: bambu, selection: null, selectedIds: [] })
    await arrangePlate('all', { gapMm: 6, rotate: false })
    expect(sequenceProblem(get())).toBeNull()
    const [a, b, c] = get().plate.map(footprint)
    for (const [p, q] of [[a, b], [a, c], [b, c]] as const) expect(hullDistance(p!, q!)).toBeGreaterThanOrEqual(73)
  })

  /** Where an entry's parts sit on the bed: the hull of their corners, moved by its transform. */
  const outline = (e: unknown) => {
    const { parts, transform: t } = e as { parts: { positions: Float32Array }[]; transform: number[] }
    const pts: [number, number][] = []
    for (const p of parts) for (let i = 0; i + 2 < p.positions.length; i += 3) pts.push([t[0]! * p.positions[i]! + t[4]! * p.positions[i + 1]! + t[12]!, t[1]! * p.positions[i]! + t[5]! * p.positions[i + 1]! + t[13]!])
    return hullOf(pts)
  }
  /** A 20 mm box under a 30 mm slab, 5 mm out each side at 10 mm: a flat underside support holds up. */
  const ledge = (id: string, name: string) => {
    const e = entry(id, name, 0, 0, 10) as unknown as { parts: ReturnType<typeof box>[] }
    const top = box(30, 20, 3)
    for (let i = 0; i < top.positions.length; i += 3) {
      top.positions[i] = top.positions[i]! - 5
      top.positions[i + 2] = top.positions[i + 2]! + 10
    }
    e.parts = [...e.parts, top]
    return e as never
  }
  const supportOn = { ...A1, brim_type: 'no_brim', skirt_loops: 0, enable_support: true, support_type: 'tree(auto)', support_threshold_angle: 25 }
  const gaps = () => {
    const shapes = get().plate.map((e) => ({ id: e.id, hull: outline(e) }))
    const out: Record<string, number> = {}
    for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) out[`${shapes[i]!.id}${shapes[j]!.id}`] = hullDistance(shapes[i]!.hull, shapes[j]!.hull)
    return out
  }

  it('spaces parts with nothing to hold up by the clearance alone, with support on', async () => {
    installPrintMargins(get)
    const plate = [entry('a', 'Cube A', 0, 0, 10), entry('b', 'Cube B', 0, 0, 10), entry('c', 'Cube C', 0, 0, 10)]
    set({ bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, plate, plates: plates('by-object'), activePlate: 'p1', overrides: supportOn, objectSettings: {}, selection: null, selectedIds: [] })
    await arrangePlate('all', { gapMm: 6, rotate: false })
    expect(sequenceProblem(get())).toBeNull()
    const g = Object.values(gaps())
    for (const d of g) expect(d).toBeGreaterThanOrEqual(40)
    // No cube gets support, so no pair keeps the 7.9 mm a tree support pad would reach.
    expect(Math.min(...g)).toBeLessThan(47.9)
  })

  it('keeps a supported part its pad from each neighbor, and drops it once the part prints no support', async () => {
    installPrintMargins(get)
    const plate = [entry('a', 'Cube A', 0, 0, 10), entry('b', 'Cube B', 0, 0, 10), entry('c', 'Cube C', 0, 0, 10), ledge('l', 'Ledge')]
    set({ bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, plate, plates: plates('by-object'), activePlate: 'p1', overrides: supportOn, objectSettings: {}, selection: null, selectedIds: [] })
    await arrangePlate('all', { gapMm: 6, rotate: false })
    expect(sequenceProblem(get())).toBeNull()
    const g = gaps()
    for (const [pair, d] of Object.entries(g)) expect(d, pair).toBeGreaterThanOrEqual(pair.includes('l') ? 47.9 - 0.01 : 40)
    // Support off for the ledge alone: no pair keeps a pad.
    set({ objectSettings: { l: { enable_support: false } } })
    await arrangePlate('all', { gapMm: 6, rotate: false })
    expect(sequenceProblem(get())).toBeNull()
    expect(Math.min(...Object.entries(gaps()).filter(([pair]) => pair.includes('l')).map(([, d]) => d))).toBeLessThan(47.9)
  })

  // The z27 plate: a 45 mm bracket on a printer whose gantry rod clears 34 mm, listed first.
  const z27 = { ...A1, extruder_clearance_height_to_rod: 34, brim_type: 'no_brim', skirt_loops: 0 }
  const span = (e: unknown) => {
    const ys = footprint(e).map((p) => p[1])
    return [Math.min(...ys), Math.max(...ys)] as const
  }

  it('prints a part taller than the gantry rod last, so the gantry never passes over it', async () => {
    installPrintMargins(get)
    const plate = [entry('t', 'Bracket', 0, 0, 45), entry('a', 'Cube A', 0, 0, 10), entry('b', 'Cube B', 0, 0, 10)]
    set({ bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, plate, plates: plates('by-object'), activePlate: 'p1', overrides: z27, selection: null, selectedIds: [] })
    await arrangePlate('all', { gapMm: 6, rotate: false })
    expect(sequenceProblem(get())).toBeNull()
    expect(get().plate.map((p) => p.id)).toEqual(['a', 'b', 't'])
    // By layer the order is the plate's own.
    set({ plate, plates: plates('by-layer') })
    await arrangePlate('all', { gapMm: 6, rotate: false })
    expect(get().plate.map((p) => p.id)).toEqual(['t', 'a', 'b'])
  })

  it('gives two tall parts lanes of their own, so the gantry over the later one clears the first', async () => {
    installPrintMargins(get)
    const plate = [entry('t', 'Bracket', 0, 0, 45), entry('u', 'Post', 0, 0, 40), entry('a', 'Cube A', 0, 0, 10)]
    set({ bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, plate, plates: plates('by-object'), activePlate: 'p1', overrides: z27, selection: null, selectedIds: [] })
    await arrangePlate('all', { gapMm: 6, rotate: false })
    expect(sequenceProblem(get())).toBeNull()
    const ids = get().plate.map((p) => p.id)
    expect(ids[0]).toBe('a')
    const [t, u] = [get().plate.find((p) => p.id === 't'), get().plate.find((p) => p.id === 'u')]
    const [st, su] = [span(t), span(u)]
    // their footprints keep the rod's reach apart in y
    expect(Math.max(st[0], su[0]) - Math.min(st[1], su[1])).toBeGreaterThanOrEqual(56.5)
  })
})

describe('one print sequence for the plate', () => {
  const two = [entry('a', 'Cube A', 100, 118, 10), entry('b', 'Cube B', 150, 118, 10)]

  it('follows Print sequence on a plate without its own, and the plate wins when it has one', async () => {
    const { plateConfig } = await import('../src/plate/plates')
    const { plateSliceConfig } = await import('../src/state/slice-plate')
    set({ plate: two, plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', overrides: { ...A1, print_sequence: 'by object' } })
    expect(plateConfig(get().plates[0])).not.toHaveProperty('print_sequence')
    expect(plateSliceConfig(get(), get().plates[0])['print_sequence']).toBe('by object')
    // By object from the settings alone gets the heads-up as the plate's own choice does.
    expect(sequenceProblem(get())).toMatch(/^Printing by object may collide/)
    set({ plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }] })
    expect(plateSliceConfig(get(), get().plates[0])['print_sequence']).toBe('by layer')
    expect(sequenceProblem(get())).toBeNull()
  })

  it('says in the settings panel when the plate prints otherwise, and a change there or the link makes them one', async () => {
    const { createElement } = await import('react')
    const { flushSync } = await import('react-dom')
    const { createRoot } = await import('react-dom/client')
    const { ExpertSettings } = await import('../src/workspaces/prepare/expert-settings')
    set({ settingsMode: 'expert', plate: two, plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer', bedType: 'cool' } }], activePlate: 'p1', overrides: { print_sequence: 'by object' }, settingsTab: 'output' })
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el)
    flushSync(() => root.render(createElement(ExpertSettings)))
    const row = () => document.getElementById('set-print_sequence')?.closest('li') ?? null
    expect(row()).not.toBeNull()
    expect(row()!.textContent).toContain('Plate 1 prints by layer, set in its plate settings, and that wins over this setting.')
    const link = [...row()!.querySelectorAll('button')].find((b) => b.textContent === 'Print Plate 1 by object')!
    flushSync(() => link.click())
    expect(get().plates[0]!.settings).toEqual({ bedType: 'cool' })
    expect(row()!.textContent).not.toContain('wins over this setting')
    // Picking a sequence in the panel drops the plate's own, so the plate prints what the panel shows.
    set({ plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-object' } }] })
    const select = document.getElementById('set-print_sequence') as HTMLSelectElement
    flushSync(() => {
      select.value = 'by layer'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(get().overrides['print_sequence']).toBe('by layer')
    expect(get().plates[0]!.settings.sequence).toBeUndefined()
    // Below Expert a changed sequence stays listed with its note, said once.
    const note = 'Plate 1 prints by object, set in its plate settings, and that wins over this setting.'
    set({ settingsMode: 'advanced', plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-object' } }] })
    flushSync(() => root.render(createElement(ExpertSettings)))
    expect(row()).not.toBeNull()
    expect(el.textContent!.split(note).length - 1).toBe(1)
    // Unchanged, the row is an Advanced row of the Output tab; on another tab the note shows under the panel instead.
    set({ overrides: {} })
    flushSync(() => root.render(createElement(ExpertSettings)))
    expect(row()).not.toBeNull()
    expect(el.textContent!.split(note).length - 1).toBe(1)
    set({ settingsTab: 'quality' })
    flushSync(() => root.render(createElement(ExpertSettings)))
    expect(document.getElementById('set-print_sequence')).toBeNull()
    expect(el.textContent).toContain(note)
    flushSync(() => root.unmount())
    el.remove()
  })
})

describe('the job name', () => {
  const plate = [entry('a', 'Cylinder', 0, 0, 5), entry('b', 'Layered X', 50, 0, 5)]
  const s = { plate, plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1' } as never
  it('follows the plate, not whichever object a new order prints first', () => {
    expect(jobName(s)).toBe('Plate 1')
    expect(jobFileName(s, 'Cylinder_PLA_1h12m.gcode')).toBe('Plate 1_PLA_1h12m.gcode')
    const one = { ...(s as object), plate: [plate[1]] } as never
    expect(jobName(one)).toBe('Layered X')
    expect(jobFileName(one, 'Layered X_PLA_40m.gcode')).toBe('Layered X_PLA_40m.gcode')
  })
})

describe('the footprint of a big model', () => {
  /** The hull as it was taken before: every vertex placed by the transform, then the hull of them all. */
  const plain = (lists: Float32Array[], m: number[]) => {
    const pts: [number, number][] = []
    for (const p of lists) for (let i = 0; i + 2 < p.length; i += 3) pts.push([m[0]! * p[i]! + m[4]! * p[i + 1]! + m[8]! * p[i + 2]! + m[12]!, m[1]! * p[i]! + m[5]! * p[i + 1]! + m[9]! * p[i + 2]! + m[13]!])
    return hullOf(pts)
  }
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const turned = (deg: number, x: number, y: number) => {
    const [c, s] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)]
    return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, x, y, 0, 1]
  }
  const clouds: [string, Float32Array[]][] = [
    ['a ball of points', [Float32Array.from({ length: 3 * 4000 }, () => rand() * 50 - 25)]],
    ['a grid with ties on every side', [Float32Array.from({ length: 3 * 21 * 21 }, (_, i) => [Math.floor(i / 3 / 21), (i / 3) % 21, 5][i % 3]! * 1)]],
    ['points along one line', [Float32Array.from({ length: 3 * 50 }, (_, i) => [i / 3, i / 3, 0][i % 3]!)]],
    ['one point', [new Float32Array([3, 4, 5])]],
    ['two parts', [Float32Array.from({ length: 3 * 500 }, () => rand() * 10), Float32Array.from({ length: 3 * 500 }, () => 40 + rand() * 10)]],
  ]
  for (const [what, lists] of clouds) {
    it(`takes the same hull as every vertex would, for ${what}`, () => {
      for (const m of [turned(0, 0, 0), turned(33, 120, 80), turned(90, 10, 10), [2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 5, 5, 0, 1]]) {
        expect(footprint(lists, m).hull).toEqual(plain(lists, m))
      }
    })
  }

  it('keeps the top of the placed model', () => {
    const lists = [new Float32Array([0, 0, 0, 1, 0, 7, 0, 1, 3])]
    expect(footprint(lists, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 1, 1]).top).toBe(15)
  })
})
