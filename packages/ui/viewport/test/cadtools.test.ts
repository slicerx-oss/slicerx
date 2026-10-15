// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { FrontSide, InterleavedBufferAttribute, LineSegments, Matrix4, Mesh, Vector3 } from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { describe, expect, it, vi } from 'vitest'
import { DimensionLayer, EdgePreview, OP_LOOK, OpPreviewLook, PLANE_EDGE, PLANE_EDGE_LIGHT, PLANE_FILL, PLANE_FILL_LIGHT, PushPreview, SketchLayer, frameMatrix, fromPlane, glyphInk, glyphPixels, prismMatrix, rayOnPlane, toPlane, type CadFrame, type SketchGlyphKind } from '../src/cadtools'
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

  it('tints added material, draws a cut as a ghost with dashes that keep their size, and shows nothing at zero', () => {
    const look = new OpPreviewLook()
    const p = new PushPreview(look)
    const prism = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], indices: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3] }
    p.setPrism(prism, { point: [0, 0, 0], normal: [0, 0, 1] })
    p.setDistance(5)
    expect(p.group.visible).toBe(true)
    const fill = p.group.children[0] as Mesh
    const lines = p.group.children[1] as LineSegments
    expect(fill.material).toBe(look.addFill)
    expect(lines.material).toBe(look.addEdge)
    expect(look.addFill.depthTest).toBe(true)
    expect(p.shows()).toEqual({ added: true, removed: false })
    expect(p.group.matrix.elements[10]).toBeCloseTo(5)
    p.setDistance(-2)
    expect(fill.material).toBe(look.cutFill)
    expect(lines.material).toBe(look.cutEdge)
    // the ghost is seen through the part, fainter than added material
    expect(look.cutFill.depthTest).toBe(false)
    expect(look.cutFill.side).toBe(FrontSide)
    expect(look.cutFill.opacity).toBeLessThan(look.addFill.opacity)
    expect(p.shows()).toEqual({ added: false, removed: true })
    // the edge along the normal is 2 mm long on screen, so its dashes measure 2 mm, not the 1 mm prism's
    const dist = lines.geometry.getAttribute('lineDistance')
    const pos = lines.geometry.getAttribute('position')
    let along = 0
    for (let i = 0; i + 1 < pos.count; i += 2) if (pos.getZ(i) !== pos.getZ(i + 1) && pos.getX(i) === 0 && pos.getY(i) === 0) along = dist.getX(i + 1)
    expect(along).toBeCloseTo(2)
    p.setDistance(0)
    expect(p.group.visible).toBe(false)
    expect(p.shows()).toEqual({ added: false, removed: false })
    p.setPrism(null, null)
    expect(p.hasPrism).toBe(false)
    p.dispose()
    look.dispose()
  })

  it('follows the theme: the accent for added material, a deeper red and lighter fills on a light studio', () => {
    const look = new OpPreviewLook()
    look.setColors('#bd93f9', '#ff4b5c', false)
    expect(look.colors()).toEqual({ add: '#bd93f9', cut: '#ff4b5c', addFill: OP_LOOK.addFill, cutFill: OP_LOOK.cutFill })
    look.setColors('#7c4dcc', '#ff4b5c', true)
    expect(look.colors()).toEqual({ add: '#7c4dcc', cut: '#d32f2f', addFill: OP_LOOK.addFillLight, cutFill: OP_LOOK.cutFillLight })
    expect(look.cutEdge.color.getHexString()).toBe('d32f2f')
    look.dispose()
  })
})

describe('edge preview', () => {
  it('draws what a fillet removes as a ghost and what it adds tinted, each with its edges, and clears', () => {
    const look = new OpPreviewLook()
    const p = new EdgePreview(look)
    const tri = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }
    p.set({ cut: tri, join: null })
    expect(p.group.visible).toBe(true)
    // a fill and its edges
    expect(p.group.children).toHaveLength(2)
    expect((p.group.children[0] as Mesh).material).toBe(look.cutFill)
    expect((p.group.children[1] as LineSegments).material).toBe(look.cutEdge)
    expect(p.shows()).toEqual({ removed: true, added: false })
    p.set({ cut: tri, join: tri })
    expect(p.group.children).toHaveLength(4)
    expect((p.group.children[2] as Mesh).material).toBe(look.addFill)
    expect(p.shows()).toEqual({ removed: true, added: true })
    p.set({ cut: { positions: [], indices: [] }, join: null })
    expect(p.group.visible).toBe(false)
    p.set(null)
    expect(p.group.children).toHaveLength(0)
    p.dispose()
    look.dispose()
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
