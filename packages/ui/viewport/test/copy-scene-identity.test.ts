// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Sharing geometry between copies changes no pixel: a plate of sources and their copies, built once with the copies on
// the source arrays (one geometry each) and once with every object on its own copy of the arrays (one geometry per
// part, as before sharing), makes the same scene object for object. Only how many distinct geometries there are differs.
import { BoxGeometry, Color, LineSegments, Mesh, TorusKnotGeometry, type BufferGeometry, type Camera, type Material, type Object3D, type Scene, type WebGLRenderer } from 'three'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { describe, expect, it } from 'vitest'
import { MaterialCache, sharedMaterials } from '../src/materials'
import { buildObject, wideEdges, type ObjectEntry, type SharedParts } from '../src/model'
import type { FilamentFinish, RenderMode, ViewportObject, ViewportPart } from '../src/types'

type Arrays = { positions: Float32Array; indices: Uint32Array | Uint16Array }

const knot = (): Arrays => {
  const g = new TorusKnotGeometry(10, 3, 64, 12)
  return { positions: g.getAttribute('position').array as Float32Array, indices: new Uint32Array(g.getIndex()!.array) }
}
const box = (): Arrays => {
  const g = new BoxGeometry(12, 8, 5)
  return { positions: g.getAttribute('position').array as Float32Array, indices: new Uint16Array(g.getIndex()!.array) }
}

/** Column-major, a turn about Z and a place, so a matrix that is not applied shows. */
const at = (x: number, y: number, turn: number): number[] => {
  const c = Math.cos(turn), s = Math.sin(turn)
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, x, y, 0, 1]
}

const part = (name: string, a: Arrays, color: string, finish?: FilamentFinish): ViewportPart => ({ name, positions: a.positions, indices: a.indices, color, ...(finish ? { finish } : {}) })

const COPIES = 4

/** Two sources (one of two colors, one single part) and COPIES copies of each on the source arrays, as Duplicate makes them. */
function plate(): ViewportObject[] {
  const k = knot()
  const b = box()
  const sources: ViewportObject[] = [
    { id: 'knot', name: 'knot', transform: at(0, 0, 0), parts: [part('body', k, '#d0d4d8', 'silk'), part('cap', b, '#e04040', 'matte')] },
    { id: 'block', name: 'block', transform: at(0, 60, 0.3), parts: [part('p', b, '#3070c0')] },
  ]
  const out = [...sources]
  for (const src of sources) {
    for (let i = 1; i <= COPIES; i++) {
      // a copy may take its own color, so one copy differs in color only
      const parts = src.parts.map((p, j) => (i === 2 && j === 0 ? { ...p, color: '#20a060' } : { ...p }))
      out.push({ id: `${src.id}-${i}`, name: src.name, transform: at(40 * i, src.transform[13]!, 0.2 * i), parts })
    }
  }
  return out
}

/** The same plate with no two parts on the same arrays: the path every object took before copies shared. */
const unshared = (objs: ViewportObject[]): ViewportObject[] =>
  objs.map((o) => ({ ...o, parts: o.parts.map((p) => ({ ...p, positions: p.positions.slice(), indices: p.indices.slice() })) }))

/** FNV-1a over the bytes of a buffer. */
function hash(a: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }): string {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
  let h = 0x811c9dc5
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i]!, 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}
type Typed = Float32Array | Uint32Array | Uint16Array
const attr = (g: BufferGeometry, name: string): string => hash(g.getAttribute(name).array as Typed)

const round = (m: ArrayLike<number>): number[] => Array.from(m, (v) => Math.round(v * 1e4) / 1e4 + 0)

/** The polygon offset a part's mesh draws with, read by running its onBeforeRender on a copy of its material. */
function offset(mesh: Mesh): [number, number] {
  const m = (mesh.material as Material).clone()
  mesh.onBeforeRender({} as WebGLRenderer, {} as Scene, {} as Camera, mesh.geometry, m, null as never)
  return [m.polygonOffsetFactor + 0, m.polygonOffsetUnits + 0]
}

function look(o: Object3D): Record<string, unknown> {
  const mat = (o as Mesh).material as Material & { color?: Color }
  return {
    type: o.type,
    material: mat.type,
    color: mat.color?.getHexString(),
    visible: o.visible,
    castShadow: o.castShadow,
    receiveShadow: o.receiveShadow,
    renderOrder: o.renderOrder,
  }
}

/** Everything a frame draws for one object, part by part. */
function snapshot(e: ObjectEntry): Record<string, unknown> {
  return {
    id: e.id,
    matrix: round(e.group.matrix.elements),
    parts: e.parts.map((p) => {
      const g = p.mesh.geometry
      return {
        ...look(p.mesh),
        finish: p.finish,
        partColor: p.color,
        offset: offset(p.mesh),
        objectId: p.mesh.userData.objectId,
        triangles: g.getIndex()!.count / 3,
        position: attr(g, 'position'),
        normal: attr(g, 'normal'),
        index: hash(g.getIndex()!.array as Typed),
        edges: { ...look(p.edges), segments: p.edges.geometry.getAttribute('position').count / 2, position: attr(p.edges.geometry, 'position') },
        wide: p.wide ? { ...look(p.wide), segments: p.wide.geometry.getAttribute('instanceStart').count, position: hash((p.wide.geometry.getAttribute('instanceStart') as unknown as { data: { array: Float32Array } }).data.array) } : null,
        children: p.mesh.children.length,
      }
    }),
  }
}

/** The draws a frame of these objects issues: one per visible mesh or line, with the triangles of each mesh. */
function draws(all: ObjectEntry[]): { calls: number; triangles: number } {
  let calls = 0
  let triangles = 0
  for (const e of all) {
    e.group.traverseVisible((o) => {
      if (o instanceof Mesh) {
        calls++
        // a wide edge mesh is instanced quads; its triangles are the instances' (two each)
        triangles += o instanceof LineSegments2 ? 2 * o.geometry.getAttribute('instanceStart').count : o.geometry.getIndex()!.count / 3
      } else if (o instanceof LineSegments) calls++
    })
  }
  return { calls, triangles }
}

const distinct = (all: ObjectEntry[]): number => new Set(all.flatMap((e) => e.parts.map((p) => p.mesh.geometry))).size
const distinctEdges = (all: ObjectEntry[]): number => new Set(all.flatMap((e) => e.parts.map((p) => p.edges.geometry))).size

/** Builds a plate the way setPlate does in this render mode: cached materials per color and finish, one store. */
function build(objs: ViewportObject[], mode: RenderMode, store: SharedParts = new Map()): ObjectEntry[] {
  const mats = new MaterialCache()
  const sh = sharedMaterials()
  const edge = mode === 'xray' ? sh.edgeXray : mode === 'cad' ? sh.edgeCad : sh.edgeDark
  const all = objs.map((o) => buildObject(o, (p) => mats.get(mode, { color: p.color, finish: p.finish ?? 'basic' }), edge, undefined, store))
  if (mode === 'cad') {
    const wide = new LineMaterial()
    for (const e of all) for (const p of e.parts) wideEdges(p, wide)
  }
  for (const e of all) e.group.updateMatrixWorld(true)
  return all
}

const MODES: RenderMode[] = ['studio', 'cad', 'xray', 'filament', 'clay', 'overhang']

describe('copies sharing their source geometry draw the same scene as copies with their own', () => {
  for (const mode of MODES) {
    it(`in ${mode}`, () => {
      const objs = plate()
      const shared = build(objs, mode)
      const own = build(unshared(objs), mode)
      expect(shared.map(snapshot)).toEqual(own.map(snapshot))
      expect(draws(shared)).toEqual(draws(own))
      // only the number of geometries differs: one per source part (the knot's cap and the block share the box) against one per part
      const parts = objs.reduce((n, o) => n + o.parts.length, 0)
      expect(distinct(shared)).toBe(2)
      expect(distinctEdges(shared)).toBe(2)
      expect(distinct(own)).toBe(parts)
      expect(distinctEdges(own)).toBe(parts)
      if (mode === 'cad') {
        const wide = (all: ObjectEntry[]) => new Set(all.flatMap((e) => e.parts.map((p) => p.wide!.geometry))).size
        expect(wide(shared)).toBe(2)
        expect(wide(own)).toBe(parts)
      }
    })
  }

  it('the draws are the plate, part by part', () => {
    const objs = plate()
    const all = build(objs, 'studio')
    const tris = (a: Arrays) => a.indices.length / 3
    const perCopy = { calls: 2 * 2 + 2, triangles: tris(knot()) + 2 * tris(box()) }
    // a mesh and its edge lines per part: knot (two parts) and block (one), each with COPIES copies
    expect(draws(all)).toEqual({ calls: (COPIES + 1) * perCopy.calls, triangles: (COPIES + 1) * perCopy.triangles })
  })

  it('a copy whose arrays differ (scaled into new positions) gets its own geometry, drawn from its own arrays', () => {
    const objs = plate()
    const src = objs[0]!
    const k = src.parts[0]!
    const scaledPositions = k.positions.map((v) => v * 1.5)
    const scaled: ViewportObject = { ...src, id: 'knot-scaled', transform: at(0, -60, 0.1), parts: [{ ...k, positions: scaledPositions }, src.parts[1]!] }
    const store: SharedParts = new Map()
    const all = build([...objs, scaled], 'studio', store)
    const e = all.at(-1)!
    const source = all[0]!
    expect(e.parts[0]!.mesh.geometry).not.toBe(source.parts[0]!.mesh.geometry)
    expect(e.parts[0]!.edges.geometry).not.toBe(source.parts[0]!.edges.geometry)
    // its second part kept the source arrays, so it still shares
    expect(e.parts[1]!.mesh.geometry).toBe(source.parts[1]!.mesh.geometry)
    expect(distinct(all)).toBe(3)
    // the same as if it were built alone, with nothing to share
    const [alone] = build([unshared([scaled])[0]!], 'studio')
    expect(snapshot(e)).toEqual(snapshot(alone!))
    expect(e.parts[0]!.mesh.geometry.getIndex()!.count / 3).toBe(k.indices.length / 3)
    expect(attr(e.parts[0]!.mesh.geometry, 'position')).not.toBe(attr(source.parts[0]!.mesh.geometry, 'position'))
    // and the source and its copies are untouched by it
    const [first] = build([unshared([src])[0]!], 'studio')
    expect(snapshot(source)).toEqual(snapshot(first!))
  })
})
