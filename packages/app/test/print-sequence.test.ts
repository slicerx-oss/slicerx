// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Print by object on a bed slinger: objects placed closer or taller than the printer profile allows get a heads-up on
// the plate as it sits; the slice goes ahead, heimdall's strikes in it hold Print and Export back, and a slice from
// before the objects moved is held to the profile's rule.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Collision, Host, SliceResult } from '@slicerx/contracts'
import { arrangePlate } from '../src/plate/edit'
import { installPrintMargins } from '../src/plate/footprint'
import { clearanceProblems, hullDistance, sequenceProblem } from '../src/plate/sequence-check'
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

describe('the by-object clearance check', () => {
  const check = (a: [number, number, number], b: [number, number, number], cfg: Record<string, number> = A1) => clearanceProblems([entry('a', 'Cube A', ...a), entry('b', 'Cube B', ...b)], cfg).join('; ')

  it('holds a Bambu Lab printer to the radius heimdall uses, the profile\'s max radius', () => {
    const bambu = { ...A1, printer_model: 'Bambu Lab A1', extruder_clearance_max_radius: 73 } as unknown as Record<string, number>
    expect(check([100, 118, 10], [170, 118, 10], bambu)).toMatch(/50\.0 mm apart; printing by object needs 73 mm between objects/)
    expect(check([100, 118, 10], [193, 118, 10], bambu)).toBe('')
    // Orca's Bambu Lab profiles carry it in extruder_clearance_radius, the max radius left at its default
    const orca = { ...A1, printer_model: 'Bambu Lab A1', extruder_clearance_radius: 73 } as unknown as Record<string, number>
    expect(check([100, 118, 10], [170, 118, 10], orca)).toMatch(/needs 73 mm between objects/)
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
})

describe('one print sequence for the plate', () => {
  const two = [entry('a', 'Cube A', 100, 118, 10), entry('b', 'Cube B', 150, 118, 10)]

  it('follows Print sequence on a plate without its own, and the plate wins when it has one', async () => {
    const { plateConfig } = await import('../src/plate/plates')
    const { plateSliceConfig } = await import('../src/state/actions')
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
    set({ settingsMode: 'expert', plate: two, plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer', bedType: 'cool' } }], activePlate: 'p1', overrides: { print_sequence: 'by object' }, settingsTab: 'effects' })
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
    // Below Expert the row is hidden, and the note shows under the panel instead.
    set({ settingsMode: 'advanced', plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-object' } }] })
    flushSync(() => root.render(createElement(ExpertSettings)))
    expect(document.getElementById('set-print_sequence')).toBeNull()
    expect(el.textContent).toContain('Plate 1 prints by object, set in its plate settings, and that wins over this setting.')
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
