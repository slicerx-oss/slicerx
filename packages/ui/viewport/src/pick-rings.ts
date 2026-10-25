// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The ring in the selection color round the footprint of each part a warning or a collision picked, on the bed: the
// ring a selected object's clearance zone gets printing by object, drawn round the object itself. It shows over the
// toolpaths, where a selected object has no outline, and on a phone, where an outline is a hairline at that zoom.
// Each ring rides with its object, as the clearance zones do.
import { Color, DoubleSide, Group, Matrix4, Mesh, MeshBasicMaterial } from 'three'
import { PICK_GAP, ribbon } from './clearance'

type Pt = readonly [number, number]

export interface PickRing {
  id: string
  /** The object's transform when its footprint was measured. */
  transform: readonly number[]
  /** The footprint (convex hull, counterclockwise) in bed coordinates at that transform. */
  hull: readonly Pt[]
}

/** Width of the ring, mm: wider than a selected zone's, so the parts read at a glance under a strike mark. */
export const RING_EDGE = 5

/** How far a light studio's ring goes from the selection color toward the dark contour ink, so it holds on the pale bed. */
export const LIGHT_DEEPEN = 0.35

/** Height of the ring over the bed, mm: over a first layer's brim or skirt, so the toolpaths there leave it in view. */
export const PICK_Z = 0.45

export class PickRings {
  /** Child of the bed root (bed frame, Z up, mm), so it shows with the models and with the toolpaths. */
  readonly group = new Group()
  private readonly mat = new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })
  private drawn: { id: string; mesh: Mesh; inv: Matrix4 }[] = []

  constructor() {
    this.group.name = 'pick-rings'
    this.group.renderOrder = 3
    this.group.visible = false
    this.setColor('#bd93f9')
  }

  /** The ids ringed now. */
  get ids(): string[] {
    return this.drawn.map((d) => d.id)
  }

  /** The selection color; on a light studio's bed (`light`) a darker tone of it. */
  setColor(selection: string, light = false): void {
    this.mat.color.set(selection)
    if (light) this.mat.color.lerp(new Color('#2d2b38'), LIGHT_DEEPEN)
  }

  /** The ring's color now, as hex. */
  get color(): string {
    return `#${this.mat.color.getHexString()}`
  }

  set(rings: readonly PickRing[] | null): void {
    for (const d of this.drawn) {
      this.group.remove(d.mesh)
      d.mesh.geometry.dispose()
    }
    this.drawn = []
    for (const r of rings ?? []) {
      if (r.hull.length < 3) continue
      const mesh = new Mesh(ribbon(r.hull, RING_EDGE, PICK_Z, PICK_GAP + RING_EDGE / 2), this.mat)
      mesh.name = 'pick-ring'
      mesh.renderOrder = 3
      mesh.matrixAutoUpdate = false
      this.group.add(mesh)
      this.drawn.push({ id: r.id, mesh, inv: new Matrix4().fromArray(r.transform as number[]).invert() })
    }
    this.group.visible = this.drawn.length > 0
  }

  /** Moves each ring with its object; an object the view no longer has loses its ring. */
  follow(matrixOf: (id: string) => Matrix4 | undefined): void {
    for (const d of this.drawn) {
      const now = matrixOf(d.id)
      d.mesh.visible = now !== undefined
      if (!now) continue
      d.mesh.matrix.multiplyMatrices(now, d.inv)
      d.mesh.matrixWorldNeedsUpdate = true
    }
  }

  dispose(): void {
    this.set(null)
    this.mat.dispose()
  }
}
