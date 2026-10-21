// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Rotation rings: the rotate tool's three rings and the cut plane's two tilt rings. Laid out as in
// OrcaSlicer's GLGizmoRotate3D (v2.4.2): one ring per axis around the selection's box center, a little
// wider than the box. A ring drag turns by the angle the cursor sweeps around the center on the
// ring's plane (GLGizmoRotate::on_dragging); a ring seen edge on turns by the cursor's travel along
// the ring's screen tangent instead. Everything is in bed coordinates (mm, Z up). The math is pure
// and unit tested; RingSet only draws.
import { BufferAttribute, BufferGeometry, DoubleSide, Group, Matrix4, Mesh, MeshBasicMaterial, Quaternion, TorusGeometry, Vector3 } from 'three'
import { handleMaterial } from './gizmo'
import { SCENE, type HandleColors } from './palette'
import type { V3 } from './scaling'

export type RingAxis = 'x' | 'y' | 'z'
export type RotateSpace = 'world' | 'local'

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2])
export const unit = (a: V3): V3 => {
  const l = len(a)
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1]
}

/** Signed angle in radians that turns `a` onto `b` about `n`, with `a` and `b` taken on the plane square to `n`. */
export function angleAround(a: V3, b: V3, n: V3): number {
  const flat = (v: V3): V3 => {
    const k = dot(v, n)
    return [v[0] - n[0] * k, v[1] - n[1] * k, v[2] - n[2] * k]
  }
  const fa = flat(a)
  const fb = flat(b)
  return Math.atan2(dot(cross(fa, fb), n), dot(fa, fb))
}

/** `raw` (in -PI to PI) moved by whole turns to land nearest `prev`, so a drag can go past half a turn. */
export function unwrapAngle(prev: number, raw: number): number {
  const turn = Math.PI * 2
  return raw + Math.round((prev - raw) / turn) * turn
}

/** An angle in radians rounded to a step in degrees. */
export function snapAngle(rad: number, stepDeg: number): number {
  const step = (stepDeg * Math.PI) / 180
  return step > 0 ? Math.round(rad / step) * step : rad
}

/** Where a ray meets the plane through `p` square to `n`, or null when it runs along the plane. */
export function rayPlane(o: V3, d: V3, p: V3, n: V3): V3 | null {
  const den = dot(d, n)
  if (Math.abs(den) < 1e-9) return null
  const t = dot(sub(p, o), n) / den
  return t < 0 ? null : [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]
}

/** Two unit vectors square to `n` and to each other, so (u, v, n) is right handed. */
export function planeBasis(n: V3): [V3, V3] {
  const a: V3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  const u = unit(cross(a, n))
  return [u, cross(n, u)]
}

/**
 * Distance from a ray to the nearest point of a ring, and how far along the ray that point lies.
 * Sampled: a ring seen edge on still has a nearest point, which a plane hit would miss.
 */
export function ringDistance(o: V3, d: V3, center: V3, axis: V3, radius: number, samples = 96): { dist: number; along: number } {
  const [u, v] = planeBasis(axis)
  const dd = dot(d, d)
  let best = { dist: Infinity, along: Infinity }
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2
    const c = Math.cos(a) * radius
    const s = Math.sin(a) * radius
    const p: V3 = [center[0] + u[0] * c + v[0] * s, center[1] + u[1] * c + v[1] * s, center[2] + u[2] * c + v[2] * s]
    const w = sub(p, o)
    const t = Math.max(0, dot(w, d) / dd)
    const q: V3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]
    const dist = len(sub(p, q))
    if (dist < best.dist) best = { dist, along: t }
  }
  return best
}

/** The ring a ray picks: the nearest to the camera of those within `tol` mm, or null. */
export function pickRing<K extends string>(o: V3, d: V3, center: V3, axes: readonly { id: K; axis: V3 }[], radius: number, tol: number): K | null {
  let best: { id: K; along: number } | null = null
  for (const r of axes) {
    const h = ringDistance(o, d, center, r.axis, radius)
    if (h.dist <= tol && (!best || h.along < best.along)) best = { id: r.id, along: h.along }
  }
  return best?.id ?? null
}

/** The three rotation axes in bed coordinates: the bed's own, or the columns of the object's transform (scale removed). */
export function ringAxes(m: ArrayLike<number>, space: RotateSpace): Record<RingAxis, V3> {
  if (space === 'world') return { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
  const col = (i: number): V3 => unit([m[i * 4] ?? 0, m[i * 4 + 1] ?? 0, m[i * 4 + 2] ?? 0])
  const x = col(0)
  const y = col(1)
  // A mirrored object has a left handed frame; its z is taken from x and y so the rings stay a proper rotation.
  return { x, y, z: unit(cross(x, y)) }
}

/** Column-major transform `m` turned by `rad` about the line through `center` along unit `axis` (bed coordinates). */
export function rotateAbout(m: ArrayLike<number>, center: V3, axis: V3, rad: number): number[] {
  const r = new Matrix4().makeTranslation(center[0], center[1], center[2]).multiply(new Matrix4().makeRotationAxis(new Vector3(...axis), rad)).multiply(new Matrix4().makeTranslation(-center[0], -center[1], -center[2]))
  return new Matrix4().fromArray(Array.from(m)).premultiply(r).toArray()
}

/** Turns a vector by `rad` about unit `axis`. */
export function turnVector(v: V3, axis: V3, rad: number): V3 {
  return new Vector3(...v).applyAxisAngle(new Vector3(...axis), rad).toArray() as V3
}

/** The rotate rings' colors: the theme's axis colors. */
export function axisRingColors(c: Pick<HandleColors, 'axisX' | 'axisY' | 'axisZ'>): Record<RingAxis, string> {
  return { x: c.axisX, y: c.axisY, z: c.axisZ }
}

const FAN_STEPS = 360
/** Tube radius of a ring and of the outline under it, in ring radii. */
const TUBE = 0.012
const HALO_TUBE = 0.02

/**
 * The rings and the swept sector of a running drag. Lives in the bed frame (add `group` under the bed root). `place`
 * is called from the render pass, so it only writes transforms and colors; geometry is built once. Each ring draws
 * over a slightly thicker ring in the halo color, so it reads on a light bed and on a plate surface.
 */
export class RingSet<K extends string = RingAxis> {
  readonly group = new Group()
  private readonly rings = new Map<K, Mesh>()
  private readonly halos = new Map<K, Mesh>()
  private readonly haloMat: MeshBasicMaterial
  private readonly fan: Mesh
  private hot: string
  private hover: K | null = null
  private active: K | null = null

  constructor(ids: readonly K[], colors: Record<K, string> = axisRingColors(SCENE) as unknown as Record<K, string>, look: Pick<HandleColors, 'handleHot' | 'handleHalo'> = SCENE) {
    this.group.name = 'ring-gizmo'
    this.group.visible = false
    this.hot = look.handleHot
    const torus = new TorusGeometry(1, TUBE, 6, 128)
    const haloTorus = new TorusGeometry(1, HALO_TUBE, 6, 128)
    this.haloMat = handleMaterial(look.handleHalo)
    for (const id of ids) {
      const halo = new Mesh(haloTorus, this.haloMat)
      halo.renderOrder = 8
      halo.raycast = () => {}
      this.halos.set(id, halo)
      this.group.add(halo)
      const m = new Mesh(torus, handleMaterial(colors[id]))
      m.renderOrder = 10
      m.raycast = () => {}
      m.userData.color = colors[id]
      this.rings.set(id, m)
      this.group.add(m)
    }
    // One triangle per degree; a drag shows the first |angle| of them.
    const pos = new Float32Array(FAN_STEPS * 9)
    for (let i = 0; i < FAN_STEPS; i++) {
      const a0 = (i / FAN_STEPS) * Math.PI * 2
      const a1 = ((i + 1) / FAN_STEPS) * Math.PI * 2
      pos.set([0, 0, 0, Math.cos(a0), Math.sin(a0), 0, Math.cos(a1), Math.sin(a1), 0], i * 9)
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(pos, 3))
    this.fan = new Mesh(g, new MeshBasicMaterial({ color: look.handleHot, side: DoubleSide, depthTest: false, depthWrite: false, transparent: true, opacity: 0.22, toneMapped: false }))
    this.fan.renderOrder = 9
    this.fan.raycast = () => {}
    this.fan.visible = false
    this.group.add(this.fan)
  }

  /** Puts ring `id` around `center` square to `axis`, `radius` mm wide. A ring left out of a call keeps its place. */
  place(id: K, center: V3, axis: V3, radius: number): void {
    const m = this.rings.get(id)
    if (!m) return
    m.position.set(center[0], center[1], center[2])
    m.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(...axis))
    m.scale.setScalar(radius)
    const halo = this.halos.get(id)
    if (halo) {
      halo.position.copy(m.position)
      halo.quaternion.copy(m.quaternion)
      halo.scale.setScalar(radius)
    }
    ;(m.material as MeshBasicMaterial).color.set(id === (this.active ?? this.hover) ? this.hot : (m.userData.color as string))
  }

  /** The theme's hot and outline colors; a hovered or dragged ring takes the new hot color when it is placed again. */
  setHandleColors(look: Pick<HandleColors, 'handleHot' | 'handleHalo'>): void {
    this.hot = look.handleHot
    this.haloMat.color.set(look.handleHalo)
    ;(this.fan.material as MeshBasicMaterial).color.set(look.handleHot)
  }

  show(on: boolean): void {
    this.group.visible = on
  }

  /** Recolors ring `id`; a hovered or dragged ring keeps the hot color until it is placed again. */
  setColor(id: K, hex: string): void {
    const m = this.rings.get(id)
    if (!m) return
    m.userData.color = hex
    if (id !== (this.active ?? this.hover)) (m.material as MeshBasicMaterial).color.set(hex)
  }

  get visible(): boolean {
    return this.group.visible
  }

  setHover(id: K | null): boolean {
    if (id === this.hover) return false
    this.hover = id
    return true
  }

  setActive(id: K | null): void {
    this.active = id
    if (id === null) this.fan.visible = false
  }

  /** The sector swept by a drag: from `from` (a unit vector on the ring's plane) by `rad` about `axis`. */
  sweep(center: V3, axis: V3, from: V3, rad: number, radius: number): void {
    const steps = Math.min(FAN_STEPS, Math.ceil((Math.abs(rad) * 180) / Math.PI))
    this.fan.visible = steps > 0
    if (!steps) return
    // The fan always turns the positive way, so a negative sweep starts where it ends.
    const start = rad < 0 ? turnVector(from, axis, rad) : from
    const v = cross(axis, start)
    const basis = new Matrix4().makeBasis(new Vector3(...start), new Vector3(...v), new Vector3(...axis))
    this.fan.quaternion.copy(new Quaternion().setFromRotationMatrix(basis))
    this.fan.position.set(center[0], center[1], center[2])
    this.fan.scale.setScalar(radius)
    this.fan.geometry.setDrawRange(0, steps * 3)
  }

  dispose(): void {
    const geos = new Set<BufferGeometry>()
    const mats = new Set<MeshBasicMaterial>()
    for (const m of [...this.rings.values(), ...this.halos.values(), this.fan]) {
      geos.add(m.geometry)
      mats.add(m.material as MeshBasicMaterial)
    }
    for (const g of geos) g.dispose()
    for (const m of mats) m.dispose()
    this.group.removeFromParent()
  }
}
