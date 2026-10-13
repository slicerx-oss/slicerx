// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The B-rep kernel's wasm module (packages/brep/lib) through the worker's wrapper: a hole as deep as the part comes
// out closed with its exact volume, every triangle names its face, the Add shapes stand where their meshes do, and
// errors arrive as thrown messages.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import init from '../../brep/lib/sx_brep.mjs'
import { brepModule, type BrepModule } from '../src/geom/brep'
import { bake, primitive } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'

const wasm = readFileSync(new URL('../../brep/lib/sx_brep.wasm', import.meta.url))
let kernel: Promise<BrepModule> | null = null
const brep = () => (kernel ??= init({ wasmBinary: wasm }).then(brepModule))

interface Body {
  body: number
}
interface Info {
  manifold: boolean
  volumeMm3: number
  faces: number
  faceTypes: Record<string, number>
}
interface Mesh {
  positions: number[]
  indices: number[]
  faceIds: number[]
  faces: { id: number; type: string }[]
}

function openEdges(indices: number[]): number {
  const count = new Map<string, number>()
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k] as number
      const b = indices[t + ((k + 1) % 3)] as number
      const key = a < b ? `${a},${b}` : `${b},${a}`
      count.set(key, (count.get(key) ?? 0) + 1)
    }
  }
  return [...count.values()].filter((n) => n !== 2).length
}

// exact to the kernel's volume integration, the same tolerance as packages/brep/tests/kernel.rs
function close(got: number, want: number) {
  expect(Math.abs(got - want)).toBeLessThanOrEqual(1e-6 * Math.max(Math.abs(want), 1))
}

function boxOf(p: ArrayLike<number>): number[] {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) [b[k], b[k + 3]] = [Math.min(b[k]!, p[i + k]!), Math.max(b[k + 3]!, p[i + k]!)]
  return b
}

function meshVolume(x: ArrayLike<number>, ix: ArrayLike<number>): number {
  let v = 0
  for (let t = 0; t + 2 < ix.length; t += 3) {
    const [a, b, c] = [ix[t]! * 3, ix[t + 1]! * 3, ix[t + 2]! * 3]
    v += (x[a]! * (x[b + 1]! * x[c + 2]! - x[b + 2]! * x[c + 1]!) - x[a + 1]! * (x[b]! * x[c + 2]! - x[b + 2]! * x[c]!) + x[a + 2]! * (x[b]! * x[c + 1]! - x[b + 1]! * x[c]!)) / 6
  }
  return v
}

describe('B-rep kernel module', () => {
  it('cuts a hole as deep as the part into a closed solid', async () => {
    const k = await brep()
    const { body: cube } = k.call('box', { min: [0, 0, 0], max: [20, 20, 20] }) as Body
    const { body } = k.call('subtract', {
      body: cube,
      solids: [{ type: 'cylinder', origin: [10, 10, 0], axis: [0, 0, 1], diameterMm: 8, heightMm: 20.5 }],
    }) as Body
    const info = k.call('info', { body }) as Info
    expect(info.manifold).toBe(true)
    close(info.volumeMm3, 8000 - Math.PI * 16 * 20)
    expect(info.faces).toBe(7)
    const mesh = k.call('tessellate', { body }) as Mesh
    expect(mesh.indices.length / 3).toBe(mesh.faceIds.length)
    expect(openEdges(mesh.indices)).toBe(0)
    expect(new Set(mesh.faceIds).size).toBe(7)
    expect(mesh.faces.filter((f) => f.type !== 'plane')).toHaveLength(1)
    for (const b of [cube, body]) expect((k.call('free', { body: b }) as { freed: boolean }).freed).toBe(true)
  })

  it('cuts a body into two closed halves', async () => {
    const k = await brep()
    const { body: cube } = k.call('box', { min: [0, 0, 0], max: [20, 20, 20] }) as Body
    const halves = k.call('cut', { body: cube, plane: { point: [0, 0, 8], normal: [0, 0, 1] } }) as { below: number; above: number }
    close((k.call('info', { body: halves.below }) as Info).volumeMm3, 3200)
    close((k.call('info', { body: halves.above }) as Info).volumeMm3, 4800)
    for (const b of [cube, halves.below, halves.above]) k.call('free', { body: b })
  })

  it('carries bodies as text, the same text the native build reads', async () => {
    const k = await brep()
    const { body: cube } = k.call('box', { min: [0, 0, 0], max: [20, 20, 20] }) as Body
    const holed = k.call('subtract', {
      body: cube,
      solids: [{ type: 'cylinder', origin: [10, 10, 0], axis: [0, 0, 1], diameterMm: 8, heightMm: 20.5 }],
      save: true,
    }) as Body & { bodySmb: string }
    const carried = { smb: holed.bodySmb }
    close((k.call('info', { body: carried }) as Info).volumeMm3, 8000 - Math.PI * 16 * 20)
    // saved by the native build (packages/brep/tests/fixtures), read here
    const native = readFileSync(new URL('../../brep/tests/fixtures/holed-cube.smb', import.meta.url), 'utf8')
    close((k.call('info', { body: { smb: native } }) as Info).volumeMm3, 8000 - Math.PI * 16 * 20)
    expect(() => k.call('info', { body: { smb: holed.bodySmb.replace('20.5000000000000000', '20.6000000000000000') } })).toThrow(/^body:/)
    for (const b of [cube, holed.body]) k.call('free', { body: b })
  })

  it('builds each Add shape where its mesh stands, with the true volume', async () => {
    const k = await brep()
    const at = compose({ position: [128, 96, 0], rotation: [0, 0, 35], scale: [1, 1, 1] })
    for (const s of ['box', 'cylinder', 'cone', 'sphere'] as const) {
      const m = bake(primitive(s, 20), at)
      const { body } = k.call('primitive', m.primitive) as Body
      const info = k.call('info', { body }) as Info
      expect(info.manifold, s).toBe(true)
      close(info.volumeMm3, { box: 8000, cylinder: Math.PI * 100 * 20, cone: (Math.PI * 100 * 20) / 3, sphere: (4 / 3) * Math.PI * 1000 }[s])
      // the mesh is the same shape in facets: the same box around it, and a little less inside
      const t = k.call('tessellate', { body }) as Mesh
      const [a, b] = [boxOf(t.positions), boxOf(m.positions)]
      for (let i = 0; i < 6; i++) expect(Math.abs(a[i]! - b[i]!), `${s} bounds`).toBeLessThan(0.3)
      const ratio = meshVolume(m.positions, m.indices) / info.volumeMm3
      expect(ratio, s).toBeGreaterThan(0.98)
      expect(ratio, s).toBeLessThanOrEqual(1.000001)
      k.call('free', { body })
    }
  })

  it('tapers an extrude, its leaning sides read as planes', async () => {
    const k = await brep()
    const t = Math.tan((10 * Math.PI) / 180)
    const { body } = k.call('extrude', {
      frame: { origin: [0, 0, 0], u: [1, 0, 0], normal: [0, 0, 1] },
      polygons: [{ outer: { points: [[-10, -10], [10, -10], [10, 10], [-10, 10]] } }],
      fromMm: 0,
      toMm: 10,
      taperDeg: 10,
    }) as Body
    close((k.call('info', { body }) as Info).volumeMm3, (8000 - (20 - 20 * t) ** 3) / (6 * t))
    const mesh = k.call('tessellate', { body }) as Mesh
    expect(mesh.faces.map((f) => f.type)).toEqual(Array(6).fill('plane'))
    expect(openEdges(mesh.indices)).toBe(0)
    k.call('free', { body })
  })

  it('throws the message of a failed call', async () => {
    const k = await brep()
    const bodies = () => (k.call('count', {}) as { bodies: number }).bodies
    const before = bodies()
    expect(() => k.call('box', { min: [0, 0, 0], max: [-1, 2, 2] })).toThrow(/^max:/)
    expect(() => k.call('info', { body: 123456 })).toThrow(/^body:/)
    expect(() => k.call('nope', {})).toThrow(/^op:/)
    expect(bodies()).toBe(before)
  })
})
