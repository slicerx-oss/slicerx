// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The strike: heimdall's mark where the machine would meet a printed part. The slicerx X drawn as two offset
// perimeters per stroke, cracked at the point of contact, inside a ring. Drawn over the toolpaths at a fixed size on
// screen, so a strike inside a part still shows.
import { BufferGeometry, CanvasTexture, DoubleSide, Group, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, Shape, ShapeGeometry, Sprite, SpriteMaterial, Vector2, Vector3, type Texture } from 'three'

export interface StrikeMark {
  /** Bed frame, mm. */
  x: number
  y: number
  z: number
  /** Only inside the profile's clearance radius: drawn in the warning color. */
  close?: boolean
  /** The strike the list has selected: drawn larger. */
  selected?: boolean
  /** Before the layer it starts on, picked or pointed at in the list: a faint mark that shows where to look. */
  ghost?: boolean
}

/** The outline under every mark. */
const OUTLINE = '#15161c'

/** Screen share of a strike's width, and of the selected one's. */
const SIZE = 0.05
const SELECTED = 0.075

/** The strike on a 128 px canvas in `color`; null where there is no canvas (tests in Node). */
function strikeTexture(color: string): Texture | null {
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  if (!g) return null
  g.translate(64, 64)
  g.scale(2, 2)
  g.lineCap = 'round'
  // A dark outline under the ring and the X, so the mark reads on a part of its own color (an amber close call on
  // an orange print).
  const strokes: [number, number, number, number][] = [
    [-17.5, -14.5, -5.5, -2.5], [3.5, 6.5, 14.5, 17.5], [-14.5, -17.5, -2.5, -5.5], [6.5, 3.5, 17.5, 14.5],
    [14.5, -17.5, 3.5, -6.5], [-6.5, 3.5, -17.5, 14.5], [17.5, -14.5, 6.5, -3.5], [-3.5, 6.5, -14.5, 17.5],
  ]
  g.strokeStyle = OUTLINE
  g.lineWidth = 4.4
  g.beginPath()
  g.arc(0, 0, 27, 0, Math.PI * 2)
  g.stroke()
  g.lineWidth = 5.2
  g.beginPath()
  for (const [x0, y0, x1, y1] of strokes) {
    g.moveTo(x0, y0)
    g.lineTo(x1, y1)
  }
  g.stroke()
  g.strokeStyle = color
  g.lineWidth = 2
  g.beginPath()
  g.arc(0, 0, 27, 0, Math.PI * 2)
  g.stroke()
  g.globalAlpha = 0.18
  g.fillStyle = color
  g.beginPath()
  g.arc(0, 0, 20, 0, Math.PI * 2)
  g.fill()
  g.globalAlpha = 1
  g.lineWidth = 2.8
  // Each stroke of the X as two parallel perimeters, broken at the center where it lands.
  g.beginPath()
  for (const [x0, y0, x1, y1] of strokes) {
    g.moveTo(x0, y0)
    g.lineTo(x1, y1)
  }
  g.stroke()
  g.fillStyle = '#ffffff'
  g.rotate(Math.PI / 4)
  g.fillRect(-2.6, -2.6, 5.2, 5.2)
  const t = new CanvasTexture(c)
  t.needsUpdate = true
  return t
}

export class Strikes {
  readonly root = new Group()
  /** The outlined area (see `setArea`), kept apart from the marks so placing marks leaves it. */
  private readonly areaGroup = new Group()
  private areaDisposables: { dispose(): void }[] = []
  private readonly materials = new Map<string, SpriteMaterial>()
  private colors = { hit: '#ff4b5c', close: '#ffb86c' }

  constructor() {
    this.root.name = 'strikes'
    this.root.renderOrder = 10
    this.areaGroup.name = 'strike area'
  }

  /** The colors of hits and close calls (the theme's overhang red and amber). */
  setColors(hit: string, close: string): void {
    if (hit === this.colors.hit && close === this.colors.close) return
    this.colors = { hit, close }
    this.disposeMaterials()
  }

  private material(color: string, ghost = false): SpriteMaterial {
    const key = ghost ? `${color} ghost` : color
    let m = this.materials.get(key)
    if (!m) {
      m = new SpriteMaterial({ map: strikeTexture(color), color: 0xffffff, depthTest: false, depthWrite: false, transparent: true, opacity: ghost ? 0.35 : 1, sizeAttenuation: false })
      this.materials.set(key, m)
    }
    return m
  }

  /** Places one strike per mark; null or an empty list clears them. */
  set(marks: readonly StrikeMark[] | null): void {
    for (const c of [...this.root.children]) if (c !== this.areaGroup) this.root.remove(c)
    for (const m of marks ?? []) {
      const s = new Sprite(this.material(m.close ? this.colors.close : this.colors.hit, m.ghost))
      s.name = `${m.selected ? 'strike selected' : 'strike'}${m.ghost ? ' ghost' : ''}`
      s.position.set(m.x, m.y, m.z)
      const k = m.selected ? SELECTED : SIZE
      s.scale.set(k, k, 1)
      s.renderOrder = m.selected ? 12 : 11
      this.root.add(s)
    }
  }

  /**
   * Outlines a patch of the bed (bed frame, mm) in the hit color over a faint wash of it, drawn over everything like
   * the marks; null clears it. The refusal of a slice into an excluded area outlines that area this way.
   */
  setArea(poly: readonly (readonly [number, number])[] | null, z = 0): void {
    for (const d of this.areaDisposables) d.dispose()
    this.areaDisposables = []
    this.areaGroup.clear()
    this.root.remove(this.areaGroup)
    if (!poly || poly.length < 3) return
    this.root.add(this.areaGroup)
    const shape = new ShapeGeometry(new Shape(poly.map(([x, y]) => new Vector2(x, y))))
    const fill = new Mesh(shape, new MeshBasicMaterial({ color: this.colors.hit, transparent: true, opacity: 0.26, depthTest: false, depthWrite: false, side: DoubleSide, toneMapped: false }))
    fill.position.z = z
    fill.renderOrder = 9
    this.areaGroup.add(fill)
    this.areaDisposables.push(shape, fill.material)
    // The outline is a band of three lines (a pixel wide each, whatever the zoom): a dark one a hair outside, so it reads
    // on a bright or dark bed, then two in the hit color.
    const cx = poly.reduce((a, q) => a + q[0], 0) / poly.length
    const cy = poly.reduce((a, q) => a + q[1], 0) / poly.length
    const loop = (grow: number): Vector3[] => {
      const pts = poly.map(([x, y]) => {
        const d = Math.hypot(x - cx, y - cy) || 1
        return new Vector3(x + ((x - cx) / d) * grow, y + ((y - cy) / d) * grow, z)
      })
      return [...pts, pts[0] as Vector3]
    }
    for (const [grow, color, order] of [[0.5, OUTLINE, 10], [0, this.colors.hit, 11], [-0.5, this.colors.hit, 11]] as const) {
      const line = new Line(new BufferGeometry().setFromPoints(loop(grow)), new LineBasicMaterial({ color, depthTest: false, depthWrite: false, toneMapped: false }))
      line.renderOrder = order
      this.areaGroup.add(line)
      this.areaDisposables.push(line.geometry, line.material)
    }
  }

  private disposeMaterials(): void {
    for (const m of this.materials.values()) {
      m.map?.dispose()
      m.dispose()
    }
    this.materials.clear()
  }

  dispose(): void {
    this.setArea(null)
    this.root.clear()
    this.disposeMaterials()
  }
}
