// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The cut tool in the 3D view, after OrcaSlicer's GLGizmoCut3D (v2.4.2): a plane through the model
// with a grabber on a stem along the plane normal (drag it, or the plane, to move the plane along
// its normal) and two rings to tilt it. The preview clips the model at the plane: the side the cut
// keeps draws as it is, a side it drops draws faint, and keeping both tints the upper piece. Clipping planes are uniforms, so moving the
// plane rewrites no geometry and compiles no shader; only attaching to a model does, once.
import { Color, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Plane, Quaternion, SphereGeometry, Vector3, type Material, type Matrix4 } from 'three'
import type { ObjectEntry } from './model'
import { planeBasis, unit } from './rings'
import type { V3 } from './scaling'

export type CutKeep = 'both' | 'above' | 'below'

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Smallest and largest signed distance of a box's corners from the plane through `point` along unit `normal`. */
export function extentAlong(min: V3, max: V3, m: ArrayLike<number>, point: V3, normal: V3): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? max[0] : min[0]
    const y = i & 2 ? max[1] : min[1]
    const z = i & 4 ? max[2] : min[2]
    const w: V3 = [(m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0), (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0), (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0)]
    const d = dot([w[0] - point[0], w[1] - point[1], w[2] - point[2]], normal)
    lo = Math.min(lo, d)
    hi = Math.max(hi, d)
  }
  return [lo, hi]
}

/** The plane moved `t` mm along its normal, kept within the model's extent so it always crosses it. */
export function movePlane(point: V3, normal: V3, t: number, extent: [number, number]): V3 {
  const c = Math.max(extent[0], Math.min(extent[1], t))
  return [point[0] + normal[0] * c, point[1] + normal[1] * c, point[2] + normal[2] * c]
}

const PLANE_COLOR = '#8be9fd'
const HOT = '#ffe066'

/** Plane, stem and grabber. The tilt rings are a RingSet the viewport owns. */
export class CutGizmo {
  readonly group = new Group()
  readonly quad: Mesh
  readonly grabber: Mesh
  private readonly stem: Mesh
  private hot: 'plane' | 'grabber' | null = null

  constructor() {
    this.group.name = 'cut-gizmo'
    this.group.visible = false
    this.quad = new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial({ color: new Color(PLANE_COLOR), side: DoubleSide, transparent: true, opacity: 0.18, depthWrite: false, toneMapped: false }))
    this.quad.renderOrder = 8
    this.stem = new Mesh(new CylinderGeometry(1, 1, 1, 6), new MeshBasicMaterial({ color: new Color(PLANE_COLOR), depthTest: false, transparent: true, opacity: 0.8, toneMapped: false }))
    this.stem.renderOrder = 10
    this.stem.raycast = () => {}
    this.grabber = new Mesh(new SphereGeometry(1, 16, 12), new MeshBasicMaterial({ color: new Color(PLANE_COLOR), depthTest: false, transparent: true, opacity: 0.95, toneMapped: false }))
    this.grabber.renderOrder = 11
    this.group.add(this.quad, this.stem, this.grabber)
  }

  /** Places everything for a plane through `point` along `normal`, `radius` mm wide; `px` is one screen pixel in mm at the plane. */
  place(point: V3, normal: V3, radius: number, px: number): void {
    const n = new Vector3(...normal)
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), n)
    this.quad.position.set(...point)
    this.quad.quaternion.copy(q)
    this.quad.scale.setScalar(radius)
    const tip = new Vector3(...point).addScaledVector(n, radius * 0.6)
    this.grabber.position.copy(tip)
    this.grabber.scale.setScalar(px * 7)
    this.stem.position.set(...point).addScaledVector(n, radius * 0.3)
    this.stem.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), n)
    this.stem.scale.set(px * 1.2, radius * 0.6, px * 1.2)
    const color = (m: Mesh, on: boolean): void => void (m.material as MeshBasicMaterial).color.set(on ? HOT : PLANE_COLOR)
    color(this.grabber, this.hot === 'grabber')
    color(this.stem, this.hot === 'grabber')
    color(this.quad, this.hot === 'plane')
  }

  setHot(part: 'plane' | 'grabber' | null): boolean {
    if (part === this.hot) return false
    this.hot = part
    return true
  }

  dispose(): void {
    for (const m of [this.quad, this.stem, this.grabber]) {
      m.geometry.dispose()
      ;(m.material as MeshBasicMaterial).dispose()
    }
    this.group.removeFromParent()
  }
}

/**
 * A copy of a model material that draws the same: `clone` drops the shader hooks the layer look adds
 * (materials.ts), and a shader material keeps the page-wide uniform objects instead of copies.
 */
function lookAlike(base: Material): Material {
  const m = base.clone()
  m.onBeforeCompile = base.onBeforeCompile
  m.customProgramCacheKey = base.customProgramCacheKey
  if ('uniforms' in base && 'uniforms' in m) (m as { uniforms: unknown }).uniforms = (base as { uniforms: unknown }).uniforms
  return m
}

/**
 * The clipped look of the model being cut. Each part gets its own copy of its material clipped to
 * the side below the plane, and a second mesh on the same geometry clipped to the side above. The
 * planes are in three.js world space and are moved in place.
 */
export class CutPreview {
  private readonly below = new Plane()
  private readonly above = new Plane()
  private attached: { entry: ObjectEntry; saved: Material[]; mats: Material[]; uppers: Mesh[] } | null = null

  get entry(): ObjectEntry | null {
    return this.attached?.entry ?? null
  }

  attach(entry: ObjectEntry, keep: CutKeep): void {
    this.detach()
    const saved: Material[] = []
    const mats: Material[] = []
    const uppers: Mesh[] = []
    for (const p of entry.parts) {
      const base = p.mesh.material as Material
      saved.push(base)
      const lower = lookAlike(base)
      const upper = lookAlike(base)
      for (const [m, plane, kept] of [[lower, this.below, keep !== 'above'], [upper, this.above, keep !== 'below']] as const) {
        m.clippingPlanes = [plane]
        m.side = DoubleSide
        if (!kept) {
          m.transparent = true
          m.opacity = 0.18
          m.depthWrite = false
        }
      }
      // Keeping both, the upper piece takes a tint of the plane's color so the two pieces read apart.
      const tint = (upper as Material & { color?: Color }).color
      if (keep === 'both' && tint instanceof Color) tint.lerp(new Color(PLANE_COLOR), 0.35)
      p.mesh.material = lower
      const u = new Mesh(p.mesh.geometry, upper)
      u.raycast = () => {}
      u.renderOrder = p.mesh.renderOrder
      p.mesh.add(u)
      mats.push(lower, upper)
      uppers.push(u)
    }
    this.attached = { entry, saved, mats, uppers }
  }

  /** The cut plane in bed coordinates, turned into the two world space clipping planes. */
  setPlane(point: V3, normal: V3, bedToWorld: Matrix4): void {
    const n = new Vector3(...unit(normal))
    const p = new Vector3(...point)
    // three.js keeps what lies on the positive side of a clipping plane.
    this.above.setFromNormalAndCoplanarPoint(n, p).applyMatrix4(bedToWorld)
    this.below.setFromNormalAndCoplanarPoint(n.negate(), p).applyMatrix4(bedToWorld)
  }

  detach(): void {
    const a = this.attached
    if (!a) return
    this.attached = null
    a.entry.parts.forEach((p, i) => {
      const s = a.saved[i]
      if (s) p.mesh.material = s
    })
    for (const u of a.uppers) u.removeFromParent()
    for (const m of a.mats) m.dispose()
  }
}

/** The plane's two tilt axes: square to the normal and to each other. */
export function tiltAxes(normal: V3): { u: V3; v: V3 } {
  const [u, v] = planeBasis(normal)
  return { u, v }
}
