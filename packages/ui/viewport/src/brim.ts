// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Brim ears (Orca's GLGizmoBrimEars, render_points): flat discs on the bed under a model, in the bed frame.
// An ear is drawn as a cylinder of radius r and 0.2 mm height; an ear that does not connect to the first layer
// is drawn in the alert color. A faint disc follows the cursor while the tool is on.
import { Color, CylinderGeometry, Group, Mesh, MeshBasicMaterial } from 'three'
import { SCENE, type SceneColors } from './palette'

export interface BrimEar {
  x: number
  y: number
  z: number
  r: number
  error?: boolean
  /** Drawn in the selection color. */
  selected?: boolean
}

const HEIGHT = 0.2
const UNIT = new CylinderGeometry(1, 1, HEIGHT, 40).rotateX(Math.PI / 2)

export class BrimEars {
  /** Child of the bed frame (Z up, mm). */
  readonly group = new Group()
  private ears = new Map<string, BrimEar[]>()
  private meshes: Mesh[] = []
  private readonly good = new MeshBasicMaterial({ color: new Color(SCENE.selection), transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false })
  private readonly bad = new MeshBasicMaterial({ color: new Color(SCENE.overhangRed), transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false })
  private readonly picked = new MeshBasicMaterial({ color: new Color(SCENE.liveLayer), transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false })
  private readonly hoverMat = new MeshBasicMaterial({ color: new Color(SCENE.selection), transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false })
  private readonly hover = new Mesh(UNIT, this.hoverMat)
  private hoverR: number | null = null

  constructor() {
    this.group.name = 'brim-ears'
    this.hover.visible = false
    this.hover.renderOrder = 3
    this.group.add(this.hover)
  }

  /** The theme's selection and live layer colors. */
  setColors(scene: Pick<SceneColors, 'selection' | 'overhangRed' | 'liveLayer'>): void {
    this.good.color.set(scene.selection)
    this.hoverMat.color.set(scene.selection)
    this.bad.color.set(scene.overhangRed)
    this.picked.color.set(scene.liveLayer)
  }

  setEars(map: Record<string, readonly BrimEar[]>): void {
    for (const m of this.meshes) this.group.remove(m)
    this.meshes = []
    this.ears = new Map(Object.entries(map).map(([id, list]) => [id, list.map((e) => ({ ...e }))]))
    for (const list of this.ears.values()) {
      for (const e of list) {
        const m = new Mesh(UNIT, e.selected ? this.picked : e.error ? this.bad : this.good)
        m.position.set(e.x, e.y, e.z + HEIGHT / 2)
        m.scale.set(e.r, e.r, 1)
        m.renderOrder = 3
        this.group.add(m)
        this.meshes.push(m)
      }
    }
  }

  /** True when any ear is drawn as selected. */
  get anySelected(): boolean {
    for (const list of this.ears.values()) if (list.some((e) => e.selected)) return true
    return false
  }

  isSelected(objectId: string, index: number): boolean {
    return !!this.ears.get(objectId)?.[index]?.selected
  }

  forEachEar(cb: (objectId: string, index: number, ear: BrimEar) => void): void {
    for (const [id, list] of this.ears) list.forEach((e, i) => cb(id, i, e))
  }

  get count(): number {
    return this.meshes.length
  }

  setHoverRadius(r: number | null): void {
    this.hoverR = r
    if (r === null) this.hover.visible = false
    else this.hover.scale.set(r, r, 1)
  }

  /** The cursor's position on the bed, or null when it is off the model. */
  setHover(at: [number, number] | null): boolean {
    const show = at !== null && this.hoverR !== null
    const changed = show !== this.hover.visible || (show && (this.hover.position.x !== at[0] || this.hover.position.y !== at[1]))
    this.hover.visible = show
    if (show) this.hover.position.set(at[0], at[1], HEIGHT / 2)
    return changed
  }

  /** The ear under a bed point (within its radius, at least 1.5 mm), nearest first. */
  hit(x: number, y: number): { objectId: string; index: number } | null {
    let best: { objectId: string; index: number; d: number } | null = null
    for (const [objectId, list] of this.ears) {
      list.forEach((e, index) => {
        const d = Math.hypot(e.x - x, e.y - y)
        if (d <= Math.max(e.r, 1.5) && (!best || d < best.d)) best = { objectId, index, d }
      })
    }
    return best ? { objectId: (best as { objectId: string }).objectId, index: (best as { index: number }).index } : null
  }

  dispose(): void {
    this.good.dispose()
    this.bad.dispose()
    this.picked.dispose()
    this.hoverMat.dispose()
  }
}
