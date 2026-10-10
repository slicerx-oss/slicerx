// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Move handles: an x, a y and a z arrow from the middle of the selected model's box, in the bed's axes and the axis
// colors of the rotate rings and scale handles. A drag on one moves the model along that axis only; z stops at the
// bed. They keep a constant size on screen and draw over the model.
import { Color, ConeGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three'

export type ArrowAxis = 'x' | 'y' | 'z'
type V3 = [number, number, number]

const AXIS: Record<ArrowAxis, string> = { x: '#ff6b6b', y: '#51cf66', z: '#4dabf7' }
const DIR: Record<ArrowAxis, V3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
const HOT = '#ffe066'
/** Arrow length on screen, px. */
export const ARROW_PX = 64
const SHAFT = 0.022
const TIP_LEN = 0.22
const TIP_R = 0.075

export class MoveArrows {
  readonly group = new Group()
  private readonly arrows = new Map<ArrowAxis, Group>()
  private hover: ArrowAxis | null = null
  private active: ArrowAxis | null = null

  constructor() {
    this.group.name = 'move-arrows'
    this.group.visible = false
    // one unit long along +y (three's cylinder and cone axis), turned onto each axis
    const shaft = new CylinderGeometry(SHAFT, SHAFT, 1 - TIP_LEN, 8)
    shaft.translate(0, (1 - TIP_LEN) / 2, 0)
    const tip = new ConeGeometry(TIP_R, TIP_LEN, 16)
    tip.translate(0, 1 - TIP_LEN / 2, 0)
    for (const id of ['x', 'y', 'z'] as const) {
      const mat = new MeshBasicMaterial({ color: new Color(AXIS[id]), depthTest: false, transparent: true, opacity: 0.95, toneMapped: false })
      const g = new Group()
      for (const geo of [shaft, tip]) {
        const m = new Mesh(geo, mat)
        m.renderOrder = 10
        m.raycast = () => {}
        g.add(m)
      }
      g.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...DIR[id]))
      this.arrows.set(id, g)
      this.group.add(g)
    }
  }

  get visible(): boolean {
    return this.group.visible
  }

  show(on: boolean): void {
    this.group.visible = on
  }

  /** Puts the arrows at `origin` (bed mm), `length` mm long, and colors the hovered or dragged one. */
  place(origin: V3, length: number): void {
    for (const [id, g] of this.arrows) {
      g.position.set(...origin)
      g.scale.setScalar(length)
      const hot = id === (this.active ?? this.hover)
      for (const m of g.children) ((m as Mesh).material as MeshBasicMaterial).color.set(hot ? HOT : AXIS[id])
    }
  }

  setHover(id: ArrowAxis | null): boolean {
    if (id === this.hover) return false
    this.hover = id
    return true
  }

  setActive(id: ArrowAxis | null): void {
    this.active = id
  }

  dispose(): void {
    const first = this.arrows.get('x')
    for (const m of first?.children ?? []) (m as Mesh).geometry.dispose()
    for (const g of this.arrows.values()) ((g.children[0] as Mesh).material as MeshBasicMaterial).dispose()
  }
}

export const arrowDir = (id: ArrowAxis): V3 => DIR[id]

/**
 * Where along the line `origin + t * axis` the ray `o + s * d` passes closest, as t; null when the ray runs along
 * the line, so the drag holds still rather than jump.
 */
export function alongAxis(o: V3, d: V3, origin: V3, axis: V3): number | null {
  const w: V3 = [origin[0] - o[0], origin[1] - o[1], origin[2] - o[2]]
  const a = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
  const b = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]
  const c = axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]
  const dd = d[0] * w[0] + d[1] * w[1] + d[2] * w[2]
  const e = axis[0] * w[0] + axis[1] * w[1] + axis[2] * w[2]
  const den = a * c - b * b
  if (den < 1e-6 * a * c) return null
  return (b * dd - a * e) / den
}

/** Distance from the ray to the segment `origin` to `origin + axis * length`, mm. */
export function rayToSegment(o: V3, d: V3, origin: V3, axis: V3, length: number): number {
  const t = Math.min(length, Math.max(0, alongAxis(o, d, origin, axis) ?? 0))
  const p = new Vector3(origin[0] + axis[0] * t, origin[1] + axis[1] * t, origin[2] + axis[2] * t)
  const ro = new Vector3(...o)
  const rd = new Vector3(...d).normalize()
  const s = Math.max(0, p.clone().sub(ro).dot(rd))
  return p.distanceTo(ro.add(rd.multiplyScalar(s)))
}
