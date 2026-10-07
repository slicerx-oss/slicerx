// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Fit check gaps: a line between the closest points of two parts that sit closer than the printer
// can keep apart, drawn through the model so it reads from any angle. Amber for a tight gap, red
// for parts that touch or overlap. A line measured on one object follows it as it moves; a line between two
// objects shows only while both stay where they were measured.
import { BufferGeometry, Color, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial, SphereGeometry } from 'three'
import { SCENE } from './palette'

export interface GapLine {
  from: [number, number, number]
  to: [number, number, number]
  kind: 'horizontal' | 'vertical' | 'fused' | 'apart'
  /** The objects it was measured on, with their transforms then. None: it stays put. */
  on?: readonly { id: string; transform: readonly number[] }[]
}

interface Drawn {
  group: Group
  /** Measured transform, inverted, per object. */
  on: { id: string; inv: Matrix4; at: Matrix4 }[]
}

const DOT = new SphereGeometry(0.6, 10, 8)

export class GapLines {
  /** Child of the objects root (bed frame, Z up, mm). */
  readonly group = new Group()
  private readonly amber = new LineBasicMaterial({ color: new Color(SCENE.overhangAmber), depthTest: false, transparent: true, opacity: 0.95, toneMapped: false })
  private readonly red = new LineBasicMaterial({ color: new Color(SCENE.overhangRed), depthTest: false, transparent: true, opacity: 0.95, toneMapped: false })
  private readonly amberDot = new MeshBasicMaterial({ color: new Color(SCENE.overhangAmber), depthTest: false, toneMapped: false })
  private readonly redDot = new MeshBasicMaterial({ color: new Color(SCENE.overhangRed), depthTest: false, toneMapped: false })
  private drawn: Drawn[] = []

  constructor() {
    this.group.name = 'fit-gaps'
    this.group.renderOrder = 4
  }

  set(lines: readonly GapLine[]): void {
    for (const d of this.drawn) {
      this.group.remove(d.group)
      for (const c of d.group.children) if (c instanceof LineSegments) c.geometry.dispose()
    }
    this.drawn = []
    for (const l of lines) {
      const fused = l.kind === 'fused'
      const g = new Group()
      g.matrixAutoUpdate = false
      const geo = new BufferGeometry()
      geo.setAttribute('position', new Float32BufferAttribute([...l.from, ...l.to], 3))
      const seg = new LineSegments(geo, fused ? this.red : this.amber)
      seg.renderOrder = 4
      g.add(seg)
      for (const p of [l.from, l.to]) {
        const dot = new Mesh(DOT, fused ? this.redDot : this.amberDot)
        dot.position.set(p[0], p[1], p[2])
        dot.renderOrder = 4
        g.add(dot)
      }
      this.group.add(g)
      const on = (l.on ?? []).map((o) => {
        const at = new Matrix4().fromArray(o.transform as number[])
        return { id: o.id, at, inv: at.clone().invert() }
      })
      this.drawn.push({ group: g, on })
    }
  }

  /**
   * Puts each line where its object is now: one object carries its lines along (the object's matrix now, times
   * the inverse of the one it was measured at); a line between two objects hides once either has moved.
   */
  follow(matrixOf: (id: string) => Matrix4 | undefined): void {
    for (const d of this.drawn) {
      if (d.on.length === 1) {
        const o = d.on[0]!
        const now = matrixOf(o.id)
        if (now) d.group.matrix.multiplyMatrices(now, o.inv)
        d.group.visible = now !== undefined
      } else if (d.on.length > 1) {
        d.group.visible = d.on.every((o) => {
          const now = matrixOf(o.id)
          return now !== undefined && now.equals(o.at)
        })
      }
      d.group.matrixWorldNeedsUpdate = true
    }
  }

  setColors(amber: string, red: string): void {
    this.amber.color.set(amber)
    this.amberDot.color.set(amber)
    this.red.color.set(red)
    this.redDot.color.set(red)
  }
}
