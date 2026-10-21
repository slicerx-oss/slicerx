// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Move handles: an x, a y and a z arrow from the middle of the selected model's box, in the bed's axes and the axis
// colors of the rotate rings and scale handles. A drag on one moves the model along that axis only; z stops at the
// bed. They keep a constant size on screen and draw over the model.
import { ConeGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, Vector3, type BufferGeometry } from 'three'
import { handleMaterial, HALO_PX } from './gizmo'
import { SCENE, type HandleColors } from './palette'

export type ArrowAxis = 'x' | 'y' | 'z'
type V3 = [number, number, number]

const DIR: Record<ArrowAxis, V3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
/** Arrow length on screen, px. */
export const ARROW_PX = 64
const SHAFT = 0.022
const TIP_LEN = 0.22
const TIP_R = 0.075
/** The outline's width in arrow lengths: HALO_PX on screen. */
const HALO = HALO_PX / ARROW_PX

const fill = (c: HandleColors, id: ArrowAxis): string => (id === 'x' ? c.axisX : id === 'y' ? c.axisY : c.axisZ)

export class MoveArrows {
  readonly group = new Group()
  private readonly arrows = new Map<ArrowAxis, Group>()
  private readonly mats = new Map<ArrowAxis, MeshBasicMaterial>()
  private readonly haloMat: MeshBasicMaterial
  private readonly geos: BufferGeometry[]
  private colors: HandleColors
  private hover: ArrowAxis | null = null
  private active: ArrowAxis | null = null

  constructor(colors: HandleColors = SCENE) {
    this.colors = { ...colors }
    this.group.name = 'move-arrows'
    this.group.visible = false
    // one unit long along +y (three's cylinder and cone axis), turned onto each axis
    const shaft = new CylinderGeometry(SHAFT, SHAFT, 1 - TIP_LEN, 8)
    shaft.translate(0, (1 - TIP_LEN) / 2, 0)
    const tip = new ConeGeometry(TIP_R, TIP_LEN, 16)
    tip.translate(0, 1 - TIP_LEN / 2, 0)
    // the outline: the same arrow a little wider and a little longer at the point, drawn first
    const shaftHalo = new CylinderGeometry(SHAFT + HALO, SHAFT + HALO, 1 - TIP_LEN, 8)
    shaftHalo.translate(0, (1 - TIP_LEN) / 2, 0)
    const tipHaloLen = TIP_LEN + 3 * HALO
    const tipHalo = new ConeGeometry(TIP_R + 2 * HALO, tipHaloLen, 16)
    tipHalo.translate(0, 1 - TIP_LEN - HALO + tipHaloLen / 2, 0)
    this.geos = [shaft, tip, shaftHalo, tipHalo]
    this.haloMat = handleMaterial(colors.handleHalo)
    for (const id of ['x', 'y', 'z'] as const) {
      const mat = handleMaterial(fill(colors, id))
      this.mats.set(id, mat)
      const g = new Group()
      for (const [geo, m, order] of [[shaftHalo, this.haloMat, 8], [tipHalo, this.haloMat, 8], [shaft, mat, 10], [tip, mat, 10]] as const) {
        const mesh = new Mesh(geo, m)
        mesh.renderOrder = order
        mesh.raycast = () => {}
        g.add(mesh)
      }
      g.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...DIR[id]))
      this.arrows.set(id, g)
      this.group.add(g)
    }
  }

  /** The theme's handle colors. */
  setColors(colors: HandleColors): void {
    this.colors = { ...colors }
    this.haloMat.color.set(colors.handleHalo)
    for (const [id, m] of this.mats) m.color.set(id === (this.active ?? this.hover) ? colors.handleHot : fill(colors, id))
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
      this.mats.get(id)?.color.set(hot ? this.colors.handleHot : fill(this.colors, id))
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
    for (const g of this.geos) g.dispose()
    for (const m of [...this.mats.values(), this.haloMat]) m.dispose()
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
