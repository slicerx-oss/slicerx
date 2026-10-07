// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The strike: heimdall's mark where the machine would meet a printed part. The slicerx X drawn as two offset
// perimeters per stroke, cracked at the point of contact, inside a ring. Drawn over the toolpaths at a fixed size on
// screen, so a strike inside a part still shows.
import { CanvasTexture, Group, Sprite, SpriteMaterial, type Texture } from 'three'

export interface StrikeMark {
  /** Bed frame, mm. */
  x: number
  y: number
  z: number
  /** Only inside the profile's clearance radius: drawn in the warning color. */
  close?: boolean
  /** The strike the list has selected: drawn larger. */
  selected?: boolean
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
  private readonly materials = new Map<string, SpriteMaterial>()
  private colors = { hit: '#ff4b5c', close: '#ffb86c' }

  constructor() {
    this.root.name = 'strikes'
    this.root.renderOrder = 10
  }

  /** The colors of hits and close calls (the theme's overhang red and amber). */
  setColors(hit: string, close: string): void {
    if (hit === this.colors.hit && close === this.colors.close) return
    this.colors = { hit, close }
    this.disposeMaterials()
  }

  private material(color: string): SpriteMaterial {
    let m = this.materials.get(color)
    if (!m) {
      m = new SpriteMaterial({ map: strikeTexture(color), color: 0xffffff, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false })
      this.materials.set(color, m)
    }
    return m
  }

  /** Places one strike per mark; null or an empty list clears them. */
  set(marks: readonly StrikeMark[] | null): void {
    this.root.clear()
    for (const m of marks ?? []) {
      const s = new Sprite(this.material(m.close ? this.colors.close : this.colors.hit))
      s.name = m.selected ? 'strike selected' : 'strike'
      s.position.set(m.x, m.y, m.z)
      const k = m.selected ? SELECTED : SIZE
      s.scale.set(k, k, 1)
      s.renderOrder = m.selected ? 12 : 11
      this.root.add(s)
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
    this.root.clear()
    this.disposeMaterials()
  }
}
