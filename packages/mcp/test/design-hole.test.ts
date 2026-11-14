// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client makes a hole another size the way the hole tool does: picked by its axis or by a point on its wall, made
// narrower with a counterbore or shallower, as the same hole step the app records, and read back before and after.
// A pick that finds no hole says what face is there, and leaves the design as it was. A new hole is geom.hole's: cut
// square into a flat face by its center and axis or a point on the face, through the wall or to a depth, with a
// counterbore or a countersink, and read back as made. A spot that cannot take it is refused, and nothing changes.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { designToolset, NO_ENGINE_HOST } from '../src/toolset'
import { connect, data, text } from './helpers'
import { useGeomEngine } from './geom-engine'

type V3 = [number, number, number]
interface Read {
  center: V3
  axis: V3
  diameterMm: number
  depthMm: number
  kind: 'through' | 'blind'
  head?: string
  counterbore?: { diameterMm: number; depthMm: number }
}
interface Out {
  design: string
  steps: number
  volumeMm3: number
  part: number
  before: Read
  after: Read
  lastStep: { name: string; op: string; state: string; value?: { label: string; value: number } }
}

const geom = useGeomEngine('design-hole-replies')
const engine = (op: string, request: unknown): Promise<unknown> => geom.engine(op, request)
const top = (z: number) => ({ origin: [0, 0, z], normal: [0, 0, 1] })

describe('a hole made another size on a design', () => {
  it('finds a hole by its axis, makes it an M3 counterbore as the hole step, and reads it back', async () => {
    const h = await connect({ geomEngine: engine })
    const ok = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: T }>(r).output
    }
    const d = (await ok<{ design: string }>('slicerx_design_new', { name: 'Plate' })).design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 20 }, placement: { center: [15, 10] }, distance_mm: 5 })
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'circle', diameterMm: 6 }, frame: top(5), placement: { center: [15, 10] }, distance_mm: 5, operation: 'cut' })

    // the axis given from below still enters at the end nearest the point
    const r = await ok<Out>('slicerx_geom_hole_edit', { design: d, center: [15, 10, 5], axis: [0, 0, -1], diameter_mm: 3.4, counterbore: { diameter_mm: 6.5, depth_mm: 3 }, label: 'M3 counterbore' })
    expect(r.part).toBe(0)
    expect(r.before).toEqual({ center: [15, 10, 5], axis: [0, 0, 1], diameterMm: 6, depthMm: 5, kind: 'through' })
    expect(r.after).toEqual({ center: [15, 10, 5], axis: [0, 0, 1], diameterMm: 3.4, depthMm: 5, kind: 'through', head: 'counterbore', counterbore: { diameterMm: 6.5, depthMm: 3 } })
    expect(r.steps).toBe(3)
    expect(r.lastStep).toMatchObject({ name: 'M3 counterbore', op: 'hole.apply', state: 'done', value: { label: 'Diameter', value: 3.4 } })
    const removed = Math.PI * (1.7 ** 2 * 2 + 3.25 ** 2 * 3)
    expect(Math.abs(r.volumeMm3 - (3000 - removed))).toBeLessThan(0.01 * removed)

    // the step keeps the hole as found and the spec, as the hole tool writes them, so an edit replays it
    const edited = await ok<{ volumeMm3: number }>('slicerx_design_edit_step', { design: d, step: 3, value: 4 })
    const wider = Math.PI * (2 ** 2 * 2 + 3.25 ** 2 * 3)
    expect(Math.abs(edited.volumeMm3 - (3000 - wider))).toBeLessThan(0.01 * wider)
    const shaft = await ok<{ measurement: { diameterMm?: number; radiusMm?: number } }>('slicerx_geom_measure', { design: d, a: { at: [17, 10, 1], normal: [-1, 0, 0] } })
    expect(shaft.measurement.diameterMm ?? (shaft.measurement.radiusMm ?? 0) * 2).toBeCloseTo(4, 1)
  }, 60_000)

  it('picks a blind hole by a point on its wall and makes it narrower and shallower', async () => {
    const h = await connect({ geomEngine: engine })
    const ok = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: T }>(r).output
    }
    const d = (await ok<{ design: string }>('slicerx_design_new', { name: 'Block' })).design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, placement: { center: [10, 10] }, distance_mm: 20 })
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'circle', diameterMm: 6 }, frame: top(20), placement: { center: [10, 10] }, distance_mm: 8, operation: 'cut' })

    const r = await ok<Out>('slicerx_geom_hole_edit', { design: d, face: { at: [13, 10, 16], normal: [-1, 0, 0] }, diameter_mm: 5, depth_mm: 4 })
    expect(r.before).toEqual({ center: [10, 10, 20], axis: [0, 0, 1], diameterMm: 6, depthMm: 8, kind: 'blind' })
    expect(r.after).toEqual({ center: [10, 10, 20], axis: [0, 0, 1], diameterMm: 5, depthMm: 4, kind: 'blind', head: 'none' })
    expect(r.lastStep).toMatchObject({ name: 'Hole 5 mm', op: 'hole.apply', state: 'done' })
    const hole = Math.PI * 2.5 ** 2 * 4
    expect(Math.abs(r.volumeMm3 - (8000 - hole))).toBeLessThan(0.01 * hole)
  }, 60_000)

  it('says what face is there when a pick finds no hole, and leaves the design as it was', async () => {
    const h = await connect({ geomEngine: engine })
    const d = data<{ output: { design: string } }>(await h.call('slicerx_design_new', { name: 'Plain' })).output.design
    await h.call('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 20 }, placement: { center: [15, 10] }, distance_mm: 5 })

    const axis = await h.call('slicerx_geom_hole_edit', { design: d, center: [5, 5, 5], axis: [0, 0, 1], diameter_mm: 4 })
    expect(axis.isError).toBe(true)
    expect(text(axis)).toMatch(/no round hole on that axis line; the nearest face to the point is a flat face/)
    // a pick that finds no hole most often wanted a new one, which this tool does not make
    expect(text(axis)).toMatch(/This tool changes a hole that is already there; for a new hole, use geom\.hole/)
    const wall = await h.call('slicerx_geom_hole_edit', { design: d, face: { at: [5, 5, 5], normal: [0, 0, 1] }, diameter_mm: 4 })
    expect(wall.isError).toBe(true)
    expect(text(wall)).toMatch(/no round hole there: the pick is on a flat face/)
    expect(text(wall)).toMatch(/for a new hole, use geom\.hole/)
    // and the tool says so before it is called, so a new hole is cut the first time
    const listed = (await h.client.listTools()).tools.find((t) => t.name === 'slicerx_geom_hole_edit')
    expect(listed?.description).toMatch(/^Change a round hole already in a model or a design.*It never makes a new hole; for one, use geom\.hole\./)
    const nothing = await h.call('slicerx_geom_hole_edit', { design: d, center: [5, 5, 5], axis: [0, 0, 1] })
    expect(text(nothing)).toMatch(/give what the hole becomes/)
    const both = await h.call('slicerx_geom_hole_edit', { design: d, center: [5, 5, 5], axis: [0, 0, 1], face: { at: [5, 5, 5] }, diameter_mm: 4 })
    expect(text(both)).toMatch(/not both/)

    const steps = data<{ output: { steps: unknown[] } }>(await h.call('slicerx_design_steps', { design: d })).output.steps
    expect(steps).toHaveLength(1)
  }, 60_000)

  it('lists the wall of a hole made by Subtract with a face key, and makes that hole another size by it', async () => {
    const h = await connect({ geomEngine: engine })
    const ok = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: T }>(r).output
    }
    const d = (await ok<{ design: string }>('slicerx_design_new', { name: 'Block' })).design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, placement: { center: [10, 10] }, distance_mm: 20 })
    await ok('slicerx_geom_subtract', { design: d, solids: [{ type: 'cylinder', origin: [10, 10, -1], axis: [0, 0, 1], diameterMm: 6.8, heightMm: 22 }] })

    type Face = { part: number; faceKey: number | null; surfaceType: string; ambiguity: string; dimensions: { diameterMm?: number } }
    const topology = (await ok<{ topology: { bodyId: string; revision: string; faces: Face[] } }>('slicerx_geom_faces', { design: d, format: 'topology', limit: 500 })).topology
    const walls = topology.faces.filter((f) => f.surfaceType === 'cylinder')
    expect(walls).toHaveLength(1)
    expect(walls[0]).toMatchObject({ part: 0, ambiguity: 'none' })
    expect(walls[0]!.faceKey).toBeGreaterThan(0)
    expect(walls[0]!.dimensions.diameterMm).toBeCloseTo(6.8, 3)
    // the block's faces the cut left whole keep their keys too
    expect(topology.faces.filter((f) => f.surfaceType === 'plane' && f.faceKey !== null)).toHaveLength(6)

    const reference = { bodyId: topology.bodyId, revision: topology.revision, part: 0, faceKey: walls[0]!.faceKey }
    const r = await ok<Out>('slicerx_geom_hole_edit', { design: d, face: { topology: reference }, diameter_mm: 5 })
    // a through hole picked by its wall is entered from the end nearest the point the key stands for
    expect(r.before).toMatchObject({ diameterMm: 6.8, depthMm: 20, kind: 'through' })
    expect(r.after).toMatchObject({ diameterMm: 5, depthMm: 20, kind: 'through' })
    expect(r.after.center.slice(0, 2)).toEqual([10, 10])
    expect(r.lastStep).toMatchObject({ op: 'hole.apply', state: 'done' })
  }, 60_000)
})

interface Made {
  design: string
  steps: number
  volumeMm3: number
  part: number
  hole: Read & { countersink?: { diameterMm: number; angleDeg: number } }
  lastStep: { name: string; op: string; state: string }
}

describe('a new hole cut in a design', () => {
  const client = async () => {
    const h = await connect({ geomEngine: engine })
    const ok = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
      const r = await h.call(name, args)
      expect(r.isError, `${name}: ${text(r)}`).toBeFalsy()
      return data<{ output: T }>(r).output
    }
    return { h, ok }
  }

  it('cuts an M3 counterbored hole through a plate by its center and axis, and reads it back as made', async () => {
    const { ok } = await client()
    const d = (await ok<{ design: string }>('slicerx_design_new', { name: 'Plate' })).design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 20 }, placement: { center: [15, 10] }, distance_mm: 5 })

    // the axis given from below still enters at the face nearest the point
    const r = await ok<Made>('slicerx_geom_hole', { design: d, center: [15, 10, 5], axis: [0, 0, -1], diameter_mm: 3.4, counterbore: { diameter_mm: 6.5, depth_mm: 3 }, feature: 'Mounting hole', label: 'M3 clearance' })
    expect(r.part).toBe(0)
    expect(r.hole).toMatchObject({ center: [15, 10, 5], axis: [0, 0, 1], depthMm: 5, kind: 'through', head: 'counterbore', counterbore: { diameterMm: 6.5, depthMm: 3 } })
    expect(r.hole.diameterMm).toBeCloseTo(3.4, 2)
    // the cut and its head, each a step of its own
    expect(r.steps).toBe(3)
    expect(r.lastStep).toMatchObject({ name: 'Counterbore 6.5 mm', op: 'shape.extrude', state: 'done', value: { value: 3 } })
    const removed = Math.PI * (1.7 ** 2 * 2 + 3.25 ** 2 * 3)
    expect(Math.abs(r.volumeMm3 - (3000 - removed))).toBeLessThan(0.02 * removed)
    const steps = (await ok<{ steps: { name: string; op: string; feature?: string }[] }>('slicerx_design_steps', { design: d })).steps
    expect(steps.slice(1)).toMatchObject([{ name: 'M3 clearance', op: 'shape.extrude', feature: 'Mounting hole' }, { name: 'Counterbore 6.5 mm', op: 'shape.extrude', feature: 'Mounting hole' }])
  }, 60_000)

  it('cuts a blind hole square into the face a point is on, and a countersunk one from the bottom', async () => {
    const { ok } = await client()
    const d = (await ok<{ design: string }>('slicerx_design_new', { name: 'Block' })).design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, placement: { center: [10, 10] }, distance_mm: 20 })

    const blind = await ok<Made>('slicerx_geom_hole', { design: d, face: { at: [6, 10, 20] }, diameter_mm: 5, depth_mm: 4 })
    expect(blind.hole).toMatchObject({ center: [6, 10, 20], axis: [0, 0, 1], depthMm: 4, kind: 'blind', head: 'none' })
    expect(blind.hole.diameterMm).toBeCloseTo(5, 2)
    expect(blind.lastStep).toMatchObject({ name: 'Hole 5 mm', op: 'shape.extrude', state: 'done', value: { value: 4 } })

    const sunk = await ok<Made>('slicerx_geom_hole', { design: d, center: [14, 10, 0], axis: [0, 0, 1], diameter_mm: 4.5, countersink: { diameter_mm: 8.4 } })
    expect(sunk.hole).toMatchObject({ center: [14, 10, 0], axis: [0, 0, -1], depthMm: 20, kind: 'through', head: 'countersink', countersink: { diameterMm: 8.4, angleDeg: 90 } })
    expect(sunk.steps).toBe(4)
  }, 60_000)

  it('cuts a drain hole through the floor of a wider bore round its axis line', async () => {
    const { ok } = await client()
    const d = (await ok<{ design: string }>('slicerx_design_new', { name: 'Cup' })).design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, placement: { center: [10, 10] }, distance_mm: 20 })
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'circle', diameterMm: 16 }, frame: top(20), placement: { center: [10, 10] }, distance_mm: 15, operation: 'cut' })
    // the cup's 16 mm bore holds the line, but it is not a hole on that axis: the drain goes through the 5 mm floor
    const r = await ok<Made>('slicerx_geom_hole', { design: d, center: [13, 10, 0], axis: [0, 0, 1], diameter_mm: 2 })
    expect(r.hole).toMatchObject({ center: [13, 10, 0], axis: [0, 0, -1], depthMm: 5, kind: 'through', head: 'none' })
  }, 60_000)

  it('refuses a spot that cannot take a new hole, says what to send, and leaves the design as it was', async () => {
    const { h, ok } = await client()
    const d = (await ok<{ design: string }>('slicerx_design_new', { name: 'Boss plate' })).design
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'rectangle', widthMm: 30, heightMm: 20 }, placement: { center: [15, 10] }, distance_mm: 5 })
    await ok('slicerx_geom_extrude', { design: d, shape: { type: 'circle', diameterMm: 8 }, frame: top(5), placement: { center: [20, 10] }, distance_mm: 6, operation: 'join', part: 0 })
    await ok('slicerx_geom_hole', { design: d, center: [8, 10, 5], axis: [0, 0, 1], diameter_mm: 3 })
    const before = (await ok<{ steps: unknown[] }>('slicerx_design_steps', { design: d })).steps.length
    const refused = async (args: Record<string, unknown>): Promise<string> => {
      const r = await h.call('slicerx_geom_hole', { design: d, ...args })
      expect(r.isError, JSON.stringify(args)).toBe(true)
      return text(r)
    }

    // a point on the boss's round side: a screw hole goes in from its flat top
    expect(await refused({ face: { at: [24, 10, 8], normal: [1, 0, 0] }, diameter_mm: 3 })).toMatch(/is not flat across the hole's 3 mm circle .*a hole starts on a flat face, such as the top of a boss/)
    // the boss's top takes a hole that fits on it, and not one wider than it
    expect(await refused({ center: [20, 10, 11], axis: [0, 0, 1], diameter_mm: 9 })).toMatch(/not flat across the hole's 9 mm circle/)
    // running off the plate's edge, and missing the part
    expect(await refused({ center: [1, 1, 5], axis: [0, 0, 1], diameter_mm: 4 })).toMatch(/not flat across the hole's 4 mm circle/)
    expect(await refused({ center: [100, 100, 5], axis: [0, 0, 1], diameter_mm: 4 })).toMatch(/meets no part of the design/)
    // a hole there already is geom.hole_edit's to change
    expect(await refused({ center: [8, 10, 5], axis: [0, 0, 1], diameter_mm: 4 })).toMatch(/a 3 mm hole is on that axis already, entering at \(8, 10, 5\); to change it, use geom\.hole_edit/)
    expect(await refused({ center: [15, 10, 5], axis: [1, 0, 1], diameter_mm: 3 })).toMatch(/45 degrees off square to the axis/)
    expect(await refused({ center: [15, 10, 5], axis: [0, 0, 1], diameter_mm: 3, counterbore: { diameter_mm: 2.5, depth_mm: 1 } })).toMatch(/counterbore: its diameter_mm must be more than the hole's 3 mm/)
    expect(await refused({ center: [5, 15, 5], axis: [0, 0, 1], diameter_mm: 3, counterbore: { diameter_mm: 6, depth_mm: 5 } })).toMatch(/counterbore: its depth_mm must be less than the hole's 5 mm/)
    expect(await refused({ center: [5, 15, 5], axis: [0, 0, 1], diameter_mm: 3, countersink: { diameter_mm: 6, angle_deg: 30 } })).toMatch(/countersink: its cone, 5\.598 mm deep, must be less deep than the hole's 5 mm/)
    expect(await refused({ center: [15, 10, 5], face: { at: [15, 10, 5] }, diameter_mm: 3 })).toMatch(/not both/)
    expect(await refused({ face: { at: [15, 10, 5] }, axis: [0, 0, 1], diameter_mm: 3 })).toMatch(/goes square into it/)
    expect(await refused({ diameter_mm: 3 })).toMatch(/center: give the hole's center/)

    expect((await ok<{ steps: unknown[] }>('slicerx_design_steps', { design: d })).steps).toHaveLength(before)
    // the tool says what it makes, and where a change goes, before it is called
    const listed = (await h.client.listTools()).tools.find((t) => t.name === 'slicerx_geom_hole')
    expect(listed?.description).toMatch(/^Make a new round hole in a model or a design.*To change a hole already there, use geom\.hole_edit/)
  }, 60_000)
})

describe('the change files for the hole tools', () => {
  // a change that moves a tool on names its new version in its own file, so the version served is named in one of them,
  // or in CHANGELOG.md once a release has folded the files in
  it('name each tool at the version it has', () => {
    const dir = join(__dirname, '..', 'changes')
    const texts = [...readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => join(dir, f)), join(__dirname, '..', 'CHANGELOG.md')]
    const named = texts.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/`slicerx_(\w+?)` (\d+\.\d+\.\d+)/g)].map(([, n, v]) => [n!, v!] as const))
    const tools = new Map(designToolset(NO_ENGINE_HOST).map((t) => [t.name.replace('.', '_'), t.version]))
    for (const n of ['geom_hole', 'geom_hole_edit']) expect(named.filter(([m]) => m === n).map(([, v]) => v), n).toContain(tools.get(n))
  })
})
