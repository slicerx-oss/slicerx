// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Guides for the modeling tools: measured end points with the line between them, the outline of a picked
// face and the profile about to be extruded. Drawn through the model so they read from any angle.
import { BufferGeometry, Color, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, SphereGeometry } from 'three'
import { SCENE } from './palette'

export type GuidePoint = [number, number, number]

export interface Guides {
  /** Straight segments, such as a measured distance. */
  lines?: readonly { from: GuidePoint; to: GuidePoint }[]
  /** Closed outlines, such as a shape profile. `soft` draws the dimmer line used for the face behind the shape. */
  loops?: readonly { points: readonly GuidePoint[]; soft?: boolean }[]
  /** End points, drawn as dots. */
  points?: readonly GuidePoint[]
}

const DOT = new SphereGeometry(0.7, 12, 8)

export class GuideLines {
  /** Child of the objects root (bed frame, Z up, mm). */
  readonly group = new Group()
  private readonly line = new LineBasicMaterial({ color: new Color(SCENE.selection), depthTest: false, transparent: true, opacity: 0.98, toneMapped: false })
  private readonly soft = new LineBasicMaterial({ color: new Color(SCENE.selection), depthTest: false, transparent: true, opacity: 0.45, toneMapped: false })
  private readonly dot = new MeshBasicMaterial({ color: new Color(SCENE.selection), depthTest: false, toneMapped: false })
  private drawn: (LineSegments | Mesh)[] = []

  constructor() {
    this.group.name = 'guides'
    this.group.renderOrder = 5
  }

  /** True when something was or is now drawn, so the caller knows to redraw. */
  set(g: Guides): boolean {
    const had = this.drawn.length > 0
    for (const d of this.drawn) {
      this.group.remove(d)
      if (d instanceof LineSegments) d.geometry.dispose()
    }
    this.drawn = []
    const segments = (positions: number[], material: LineBasicMaterial): void => {
      if (positions.length < 6) return
      const geo = new BufferGeometry()
      geo.setAttribute('position', new Float32BufferAttribute(positions, 3))
      const seg = new LineSegments(geo, material)
      seg.renderOrder = 5
      this.group.add(seg)
      this.drawn.push(seg)
    }
    segments((g.lines ?? []).flatMap((l) => [...l.from, ...l.to]), this.line)
    for (const soft of [false, true]) {
      const pos: number[] = []
      for (const loop of g.loops ?? []) {
        if (Boolean(loop.soft) !== soft || loop.points.length < 2) continue
        loop.points.forEach((p, i) => pos.push(...p, ...(loop.points[(i + 1) % loop.points.length] as GuidePoint)))
      }
      segments(pos, soft ? this.soft : this.line)
    }
    for (const p of g.points ?? []) {
      const dot = new Mesh(DOT, this.dot)
      dot.position.set(p[0], p[1], p[2])
      dot.renderOrder = 5
      this.group.add(dot)
      this.drawn.push(dot)
    }
    return had || this.drawn.length > 0
  }

  setColor(color: string): void {
    this.line.color.set(color)
    this.soft.color.set(color)
    this.dot.color.set(color)
  }

  dispose(): void {
    this.set({})
    this.line.dispose()
    this.soft.dispose()
    this.dot.dispose()
  }
}
