// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { InterleavedBufferAttribute, LineSegments, Matrix4, Mesh, Vector3 } from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { describe, expect, it, vi } from 'vitest'
import { DimensionLayer, EdgePreview, PLANE_EDGE, PLANE_EDGE_LIGHT, PLANE_FILL, PLANE_FILL_LIGHT, PushPreview, SketchLayer, frameMatrix, fromPlane, glyphInk, glyphPixels, prismMatrix, rayOnPlane, toPlane, type CadFrame, type SketchGlyphKind } from '../src/cadtools'
import type { V3 } from '../src/scaling'

const close = (a: readonly number[], b: readonly number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i] ?? NaN, digits))

// A wall facing +X at x = 10, u along +Y and v up.
const WALL: CadFrame = { origin: [10, 0, 0], u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] }

describe('sketch plane math', () => {
  it('goes to plane coordinates and back', () => {
    close(toPlane(WALL, [10, 4, 7]), [4, 7])
    close(fromPlane(WALL, [4, 7]), [10, 4, 7])
    const m = frameMatrix(WALL)
    close(new Vector3(4, 7, 0).applyMatrix4(m).toArray(), [10, 4, 7])
  })

  it('meets a ray with the plane, and misses one running along it or pointing away', () => {
    close(rayOnPlane(WALL, [50, 3, 2], [-1, 0, 0])!, [3, 2])
    expect(rayOnPlane(WALL, [50, 3, 2], [0, 1, 0])).toBeNull()
    expect(rayOnPlane(WALL, [50, 3, 2], [1, 0, 0])).toBeNull()
  })
})

describe('push preview', () => {
  it('stretches a 1 mm prism to the distance along the normal, about the face', () => {
    const point: V3 = [5, 5, 20]
    const n: V3 = [0, 0, 1]
    // The prism's far corner at 1 mm lands at d mm; points on the face stay.
    close(new Vector3(0, 0, 21).applyMatrix4(prismMatrix(point, n, 5)).toArray(), [0, 0, 25])
    close(new Vector3(3, 4, 20).applyMatrix4(prismMatrix(point, n, 5)).toArray(), [3, 4, 20])
    close(new Vector3(0, 0, 21).applyMatrix4(prismMatrix(point, n, -3)).toArray(), [0, 0, 17])
    // A tilted normal scales only along itself.
    const t: V3 = [Math.SQRT1_2, Math.SQRT1_2, 0]
    const m = prismMatrix([0, 0, 0], t, 4)
    close(new Vector3(Math.SQRT1_2, Math.SQRT1_2, 0).applyMatrix4(m).toArray(), [4 * Math.SQRT1_2, 4 * Math.SQRT1_2, 0])
    close(new Vector3(-1, 1, 3).applyMatrix4(m).toArray(), [-1, 1, 3])
  })

  it('shows green when it adds, red when it cuts, and nothing at zero', () => {
    const p = new PushPreview()
    const prism = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], indices: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3] }
    p.setPrism(prism, { point: [0, 0, 0], normal: [0, 0, 1] })
    p.setDistance(5)
    expect(p.group.visible).toBe(true)
    const fill = (p.group.children[0] as unknown as { material: { color: { getHexString(): string } } }).material
    expect(fill.color.getHexString()).toBe('50fa7b')
    expect(p.group.matrix.elements[10]).toBeCloseTo(5)
    p.setDistance(-2)
    expect(fill.color.getHexString()).toBe('ff5555')
    p.setDistance(0)
    expect(p.group.visible).toBe(false)
    p.setPrism(null, null)
    expect(p.hasPrism).toBe(false)
    p.dispose()
  })
})

describe('sketch layer', () => {
  it('draws paths by tone, handles and a grid, and finds the handle under the cursor', () => {
    const s = new SketchLayer()
    s.set({ frame: WALL, paths: [{ points: [[0, 0], [10, 0], [10, 5]], closed: true }, { points: [[0, 0], [10, 5]], tone: 'issue' }], handles: [[0, 0], [10, 0], [10, 5]], dragHandles: true, grid: { stepMm: 10, min: [-20, -20], max: [20, 20] } })
    expect(s.group.visible).toBe(true)
    // the grid thin, the normal and issue curves 2 px wide (the rubber band is wide too, but not one of them)
    expect(s.group.children.filter((c) => c instanceof LineSegments).length).toBe(1)
    expect(s.group.children.filter((c) => c instanceof LineSegments2 && !(c instanceof Line2)).length).toBe(2)
    expect(s.handleAt([9.6, 0.2], 0.5)).toBe(1)
    expect(s.handleAt([5, 5], 0.5)).toBe(-1)
    s.set({ ...s.scene!, dragHandles: false })
    expect(s.handleAt([9.6, 0.2], 0.5)).toBe(-1)
    s.set(null)
    expect(s.group.visible).toBe(false)
    s.dispose()
  })

  it('draws the rubber band as a wide line to the cursor, and hides it with no path', () => {
    const s = new SketchLayer()
    s.set({ frame: WALL, paths: [], handles: [] })
    const band = s.group.children[0] as Line2
    expect(band).toBeInstanceOf(Line2)
    expect(band.visible).toBe(false)
    s.cursor({ path: [[0, 0], [3, 4]], at: [3, 4] })
    expect(band.visible).toBe(true)
    const start = band.geometry.getAttribute('instanceStart') as InterleavedBufferAttribute
    expect(start.count).toBe(1)
    expect([start.getX(0), start.getY(0)]).toEqual([0, 0])
    const end = band.geometry.getAttribute('instanceEnd') as InterleavedBufferAttribute
    expect([end.getX(0), end.getY(0)]).toEqual([3, 4])
    s.cursor(null)
    expect(band.visible).toBe(false)
    s.dispose()
  })

  it('draws what a trim takes off wider than a curve, in red, and without a fill', () => {
    const s = new SketchLayer()
    s.set({ frame: WALL, paths: [], handles: [] })
    const band = s.group.children[0] as Line2
    const plain = band.material
    const fills = () => s.group.children.filter((o) => o instanceof Mesh).length
    const none = fills()
    const ring: [number, number][] = [[0, 0], [4, 0], [4, 4], [0, 0]]
    s.cursor({ path: ring, cut: true })
    expect(band.material).not.toBe(plain)
    expect(band.material.linewidth).toBeGreaterThan(plain.linewidth)
    expect(fills()).toBe(none)
    s.cursor({ path: ring })
    expect(band.material).toBe(plain)
    expect(fills()).toBe(none + 1)
    s.dispose()
  })

  it('draws a dimension being placed with its extension lines, and drops it with the cursor', () => {
    const s = new SketchLayer()
    s.set({ frame: WALL, paths: [], handles: [] })
    const thin = () => s.group.children.filter((c) => c instanceof LineSegments && !(c instanceof LineSegments2)) as LineSegments[]
    expect(thin()).toHaveLength(0)
    s.cursor({ dim: { from: [0, -4], to: [10, -4], ext: [[[0, 0], [0, -5]], [[10, 0], [10, -5]]], label: '10' } })
    expect(thin()).toHaveLength(1)
    // the dimension line and two extension lines
    expect(thin()[0]!.geometry.getAttribute('position').count).toBe(6)
    s.cursor({ dim: { from: [0, -6], to: [10, -6], label: '10' } })
    expect(thin()).toHaveLength(1)
    s.cursor(null)
    expect(thin()).toHaveLength(0)
    s.dispose()
  })

  it('frames the sketch plane in the accent with a faint wash and a firm border, firmer on a light studio', () => {
    const s = new SketchLayer()
    s.set({ frame: WALL, paths: [], handles: [], plane: { min: [-20, -10], max: [20, 10] } })
    const plane = s.group.children.filter((o) => o.name === 'sketch-plane') as (Mesh | LineSegments)[]
    expect(plane).toHaveLength(2)
    const alpha = () => plane.map((o) => (o.material as { opacity: number }).opacity)
    expect(alpha()).toEqual([PLANE_FILL, PLANE_EDGE])
    s.setLight(true)
    expect(alpha()).toEqual([PLANE_FILL_LIGHT, PLANE_EDGE_LIGHT])
    expect(PLANE_EDGE_LIGHT).toBeGreaterThan(PLANE_EDGE)
    // the wash stays faint in both, well under the border
    for (const f of [PLANE_FILL, PLANE_FILL_LIGHT]) expect(f).toBeLessThanOrEqual(0.06)
    s.setLight(false)
    expect(alpha()).toEqual([PLANE_FILL, PLANE_EDGE])
    s.dispose()
  })
})

describe('kept dimensions', () => {
  it('sizes labels for the lens and the view height only when they change', () => {
    const d = new DimensionLayer()
    // jsdom has no 2D canvas, so labels are skipped; lines and dots still draw.
    expect(d.set([{ id: 'd1', from: [0, 0, 0], to: [0, 0, 20], label: '20.00 mm' }])).toBe(true)
    expect(d.group.children.length).toBeGreaterThanOrEqual(2)
    d.fit(30, 800)
    expect(d.set([])).toBe(true)
    expect(d.group.children.length).toBe(0)
    expect(d.set([])).toBe(false)
    d.dispose()
  })
})

describe('frame matrix', () => {
  it('is a rigid placement for an orthonormal frame', () => {
    const m = frameMatrix({ origin: [1, 2, 3], u: [0, 0, 1], v: [1, 0, 0], normal: [0, 1, 0] }, new Matrix4())
    expect(m.determinant()).toBeCloseTo(1)
  })
})

describe('edge preview', () => {
  it('draws what a fillet removes in red and adds in green, and clears', () => {
    const p = new EdgePreview()
    const tri = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }
    p.set({ cut: tri, join: null })
    expect(p.group.visible).toBe(true)
    expect(p.group.children).toHaveLength(1)
    const color = (i: number) => (p.group.children[i] as unknown as { material: { color: { getHexString(): string } } }).material.color.getHexString()
    expect(color(0)).toBe('ff5555')
    p.set({ cut: tri, join: tri })
    expect(p.group.children).toHaveLength(2)
    expect(color(1)).toBe('50fa7b')
    p.set({ cut: { positions: [], indices: [] }, join: null })
    expect(p.group.visible).toBe(false)
    p.set(null)
    expect(p.group.children).toHaveLength(0)
    p.dispose()
  })
})

describe('constraint glyphs', () => {
  it('uses custom pixel colors and redraws existing glyph textures only when their palette changes', () => {
    const colors = { line: '#123456', pickedLine: '#234567', node: '#345678', pickedNode: '#456789', center: '#56789a', halo: '#6789abdd', pickedEdge: '#789abc', pickedHalo: '#89abcd' }
    for (const light of [false, true]) {
      expect(glyphInk(false, light, colors)).toEqual({ l: colors.line, o: colors.node, w: colors.center, e: colors.halo, h: colors.halo })
      expect(glyphInk(true, light, colors)).toEqual({ l: colors.pickedLine, o: colors.pickedNode, w: colors.center, e: colors.pickedEdge, h: colors.pickedHalo })
    }
    const fills: string[] = []
    const context = { fillStyle: '', fillRect() { fills.push(this.fillStyle) } }
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => context }) })
    const layer = new SketchLayer()
    try {
      layer.set({ frame: WALL, paths: [], handles: [], glyphs: [{ kind: 'horizontal', picked: true, at: [0, 0], slot: 0 }, { kind: 'coincident', picked: true, at: [2, 0], slot: 0 }] })
      const redraw = vi.spyOn(layer, 'set')
      layer.setLight(false, colors)
      expect(redraw).toHaveBeenCalledTimes(1)
      expect(fills).toContain(colors.pickedLine)
      expect(fills).toContain(colors.center)
      layer.setLight(false, { ...colors })
      expect(redraw).toHaveBeenCalledTimes(1)
      layer.setLight(false)
      expect(redraw).toHaveBeenCalledTimes(2)
      expect(fills.at(-1)).toBe(glyphInk(true, false).h)
    } finally { layer.dispose(); vi.unstubAllGlobals() }
  })
  const KINDS: SketchGlyphKind[] = ['coincident', 'horizontal', 'vertical', 'parallel', 'perpendicular', 'tangent', 'equal', 'midpoint', 'concentric', 'collinear', 'symmetric']
  // the halo's reach round a lit pixel
  const reach = (rows: string[], x: number, y: number) => {
    let d = Infinity
    rows.forEach((r, j) => [...r].forEach((ch, i) => 'low'.includes(ch) && (d = Math.min(d, Math.max(Math.abs(i - x), Math.abs(j - y))))))
    return d
  }

  it('draws all eleven on a 16 px grid with no tile, each a different shape', () => {
    const seen = new Set<string>()
    for (const k of KINDS) {
      const rows = glyphPixels(k)
      expect(rows, k).toHaveLength(16)
      for (const r of rows) expect(r, k).toMatch(/^[.lowhe]{16}$/)
      expect(rows.join('').replace(/[.he]/g, '').length, k).toBeGreaterThan(8)
      // empty corners: the glyph keeps the lines under it visible
      for (const [x, y] of [[0, 0], [15, 0], [0, 15], [15, 15]] as const) expect(rows[y]![x], k).toBe('.')
      seen.add(rows.join('|'))
    }
    expect(seen.size).toBe(KINDS.length)
  })

  it('rings every glyph with a 1 px halo, picked or not', () => {
    for (const k of KINDS) {
      const rows = glyphPixels(k)
      rows.forEach((r, y) =>
        [...r].forEach((ch, x) => {
          const d = reach(rows, x, y)
          if (ch === 'h' || ch === 'e') expect(d, `${k} ${x},${y}`).toBeLessThanOrEqual(1)
          if (ch === '.') expect(d, `${k} ${x},${y}`).toBeGreaterThan(1)
        }),
      )
    }
  })

  it('marks the halo beside a lit pixel apart from the corner halo', () => {
    const lit = (rows: string[], x: number, y: number) => 'low'.includes(rows[y]?.[x] ?? '.')
    for (const k of KINDS) {
      const rows = glyphPixels(k)
      rows.forEach((r, y) =>
        [...r].forEach((ch, x) => {
          const side = lit(rows, x - 1, y) || lit(rows, x + 1, y) || lit(rows, x, y - 1) || lit(rows, x, y + 1)
          if (ch === 'e') expect(side, `${k} ${x},${y}`).toBe(true)
          if (ch === 'h') expect(side, `${k} ${x},${y}`).toBe(false)
        }),
      )
    }
  })

  it('swaps line and halo on a picked glyph in dark, uses its own darker gold in light, and leaves the shared gold alone', () => {
    expect(glyphInk(true, true).l).toBe('#8f6a00')
    expect(glyphInk(false, true).l).toBe('#282a36')
    // dark: the picked glyph's line is the unpicked halo's color and its halo is the selected gold
    expect(glyphInk(true, false).l).toBe('#191a21')
    expect(glyphInk(true, false).h).toBe('#f1fa8c')
    expect(glyphInk(false, false).h).toBe('rgba(25, 26, 33, 0.85)')
    expect(glyphInk(true, false).e).toBe('#f1fa8c')
    // light: a picked glyph's halo turns dark beside its strokes and stays light at the corners
    expect(glyphInk(true, true).e).toBe('#282a36')
    expect(glyphInk(true, true).h).toBe(glyphInk(false, true).h)
    // unpicked, the halo is one color all round
    for (const light of [false, true]) expect(glyphInk(false, light).e).toBe(glyphInk(false, light).h)
    const layer = new SketchLayer()
    layer.setLight(true)
    const gold = (layer as unknown as { dimPickMat: { color: { getHexString(): string } } }).dimPickMat.color.getHexString()
    expect(gold).toBe('b8860b')
    layer.dispose()
  })
})
