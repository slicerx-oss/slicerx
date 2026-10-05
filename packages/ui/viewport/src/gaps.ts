// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Fit check gaps: a line between the closest points of two parts that sit closer than the printer
// can keep apart, drawn through the model so it reads from any angle. Amber for a tight gap, red
// for parts that touch or overlap.
import { BufferGeometry, Color, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, SphereGeometry } from 'three'
import { SCENE } from './palette'

export interface GapLine {
  from: [number, number, number]
  to: [number, number, number]
  kind: 'horizontal' | 'vertical' | 'fused'
}

const DOT = new SphereGeometry(0.6, 10, 8)

export class GapLines {
  /** Child of the objects root (bed frame, Z up, mm). */
  readonly group = new Group()
  private readonly amber = new LineBasicMaterial({ color: new Color(SCENE.overhangAmber), depthTest: false, transparent: true, opacity: 0.95, toneMapped: false })
  private readonly red = new LineBasicMaterial({ color: new Color(SCENE.overhangRed), depthTest: false, transparent: true, opacity: 0.95, toneMapped: false })
  private readonly amberDot = new MeshBasicMaterial({ color: new Color(SCENE.overhangAmber), depthTest: false, toneMapped: false })
  private readonly redDot = new MeshBasicMaterial({ color: new Color(SCENE.overhangRed), depthTest: false, toneMapped: false })
  private drawn: (LineSegments | Mesh)[] = []

  constructor() {
    this.group.name = 'fit-gaps'
    this.group.renderOrder = 4
  }

  set(lines: readonly GapLine[]): void {
    for (const d of this.drawn) {
      this.group.remove(d)
      if (d instanceof LineSegments) d.geometry.dispose()
    }
    this.drawn = []
    for (const l of lines) {
      const fused = l.kind === 'fused'
      const geo = new BufferGeometry()
      geo.setAttribute('position', new Float32BufferAttribute([...l.from, ...l.to], 3))
      const seg = new LineSegments(geo, fused ? this.red : this.amber)
      seg.renderOrder = 4
      this.group.add(seg)
      this.drawn.push(seg)
      for (const p of [l.from, l.to]) {
        const dot = new Mesh(DOT, fused ? this.redDot : this.amberDot)
        dot.position.set(p[0], p[1], p[2])
        dot.renderOrder = 4
        this.group.add(dot)
        this.drawn.push(dot)
      }
    }
  }

  setColors(amber: string, red: string): void {
    this.amber.color.set(amber)
    this.amberDot.color.set(amber)
    this.red.color.set(red)
    this.redDot.color.set(red)
  }
}
