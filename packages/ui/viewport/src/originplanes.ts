// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The origin planes Create Sketch offers before anything is picked: XY (the bed's plane, Z up), XZ (front) and YZ
// (side), as translucent squares through the origin, each with its name. The one under the cursor lights up.
import { Color, DoubleSide, EdgesGeometry, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3, type Raycaster } from 'three'
import { frameMatrix, type CadFrame } from './cadtools'
import type { V3 } from './scaling'

export type OriginPlane = 'xy' | 'xz' | 'yz'

/** Each origin plane's frame at `center`: u and v span it, the normal faces the viewer it is seen square on from. */
export function originFrame(plane: OriginPlane, center: V3): CadFrame {
  switch (plane) {
    case 'xy':
      return { origin: center, u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] }
    case 'xz':
      // seen from the front, which is -Y
      return { origin: center, u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] }
    case 'yz':
      // seen from the right, +X
      return { origin: center, u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] }
  }
}

const PLANES: readonly OriginPlane[] = ['xy', 'xz', 'yz']
const FILL = '#bd93f9'

// each name at its own corner, in the plane's u, v: XY front right on the bed, XZ top left, YZ top back. the
// names are page text over the canvas (the viewport places them), so no model or outline pass draws over them
const CORNER: Record<OriginPlane, [number, number]> = { xy: [0.45, -0.45], xz: [-0.45, 0.45], yz: [0.45, 0.45] }

export class OriginPlanes {
  readonly group = new Group()
  private readonly quads = new Map<OriginPlane, Mesh>()
  private hovered: OriginPlane | null = null
  private fill = 0.12

  constructor() {
    this.group.name = 'origin-planes'
    this.group.visible = false
    const geo = new PlaneGeometry(1, 1)
    const edges = new EdgesGeometry(geo)
    for (const p of PLANES) {
      const holder = new Group()
      holder.matrixAutoUpdate = false
      const quad = new Mesh(geo, new MeshBasicMaterial({ color: new Color(FILL), transparent: true, opacity: 0.12, side: DoubleSide, depthWrite: false, toneMapped: false }))
      quad.renderOrder = 9
      quad.userData['plane'] = p
      const rim = new LineSegments(edges, new LineBasicMaterial({ color: new Color(FILL), transparent: true, opacity: 0.6, toneMapped: false }))
      rim.raycast = () => {}
      holder.add(quad, rim)
      this.quads.set(p, quad)
      this.group.add(holder)
    }
  }

  /** Shows the planes as squares `sizeMm` across through `center` (bed coordinates), or hides them. */
  set(o: { center: V3; sizeMm: number } | null): boolean {
    const was = this.group.visible
    this.group.visible = !!o
    if (!o) {
      this.hover(null)
      return was
    }
    for (const p of PLANES) {
      const holder = this.quads.get(p)!.parent!
      frameMatrix(originFrame(p, o.center), holder.matrix)
      holder.matrixWorldNeedsUpdate = true
      for (const c of holder.children) c.scale.set(o.sizeMm, o.sizeMm, 1)
      holder.userData['size'] = o.sizeMm
    }
    return true
  }

  /** On a light background the faint squares get a stronger fill and edge, so each name sits on something. */
  setLight(light: boolean): void {
    this.fill = light ? 0.2 : 0.12
    for (const [k, q] of this.quads) {
      ;(q.material as MeshBasicMaterial).opacity = k === this.hovered ? 0.32 : this.fill
      const rim = q.parent!.children.find((c): c is LineSegments => c instanceof LineSegments)
      if (rim) (rim.material as LineBasicMaterial).opacity = light ? 0.95 : 0.6
    }
  }

  /** Where each plane's name goes, in world space (after the group's matrices are current). */
  names(): { name: string; at: Vector3 }[] {
    if (!this.group.visible) return []
    this.group.updateMatrixWorld(true)
    return PLANES.map((p) => {
      const holder = this.quads.get(p)!.parent!
      const size = (holder.userData['size'] as number | undefined) ?? 0
      return { name: p.toUpperCase(), at: new Vector3(size * CORNER[p][0], size * CORNER[p][1], 0).applyMatrix4(holder.matrixWorld) }
    })
  }

  get shown(): boolean {
    return this.group.visible
  }

  /** The plane nearest along the ray, or null. */
  at(ray: Raycaster): { plane: OriginPlane; distance: number } | null {
    if (!this.group.visible) return null
    this.group.updateMatrixWorld(true)
    const hit = ray.intersectObjects([...this.quads.values()], false)[0]
    return hit ? { plane: hit.object.userData['plane'] as OriginPlane, distance: hit.distance } : null
  }

  /** Lights one plane; true when that changed what is drawn. */
  hover(p: OriginPlane | null): boolean {
    if (p === this.hovered) return false
    this.hovered = p
    for (const [k, q] of this.quads) (q.material as MeshBasicMaterial).opacity = k === p ? 0.32 : this.fill
    return true
  }

  dispose(): void {
    for (const q of this.quads.values()) (q.material as MeshBasicMaterial).dispose()
    this.group.removeFromParent()
  }
}
