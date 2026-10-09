// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Edges picked in Model, drawn as solid bars along them in the pick color, and the edge under the pointer as a fainter
// one. A bar keeps about the same width on screen: the viewport sizes it from the camera distance and redraws it when
// the camera moves far enough to change it.
import { Color, CylinderGeometry, Group, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from 'three'
import { SCENE } from './palette'

export type MarkLine = { from: [number, number, number]; to: [number, number, number] }

/** Half the bar's width on screen, in pixels: picked, and the hover preview. */
const PICKED_PX = 2.6
const HOVER_PX = 1.7
const UNIT = new CylinderGeometry(1, 1, 1, 8, 1, false)
const UP = new Vector3(0, 1, 0)

export class EdgeMarks {
  /** Child of the objects root (bed frame, Z up, mm). */
  readonly group = new Group()
  private readonly picked = new MeshBasicMaterial({ color: new Color(SCENE.liveLayer), depthTest: false, transparent: true, opacity: 0.98, toneMapped: false })
  private readonly hover = new MeshBasicMaterial({ color: new Color(SCENE.liveLayer), depthTest: false, transparent: true, opacity: 0.55, toneMapped: false })
  private lines: { picked: readonly MarkLine[]; hover: readonly MarkLine[] } = { picked: [], hover: [] }
  private scale = 0

  constructor() {
    this.group.name = 'edge-marks'
    this.group.renderOrder = 6
  }

  /** The edges to draw. True when anything was or is now drawn. */
  set(picked: readonly MarkLine[], hover: readonly MarkLine[], mmPerPx: (p: [number, number, number]) => number): boolean {
    const had = this.group.children.length > 0
    this.lines = { picked, hover }
    this.draw(mmPerPx)
    return had || this.group.children.length > 0
  }

  /** Redraws when the camera has moved enough that the bars would look thicker or thinner. True when it did. */
  refresh(mmPerPx: (p: [number, number, number]) => number): boolean {
    const first = this.lines.picked[0] ?? this.lines.hover[0]
    if (!first) return false
    const s = mmPerPx(first.from)
    if (this.scale > 0 && Math.abs(s - this.scale) / this.scale < 0.15) return false
    this.draw(mmPerPx)
    return true
  }

  private draw(mmPerPx: (p: [number, number, number]) => number): void {
    for (const c of [...this.group.children]) this.group.remove(c)
    const first = this.lines.picked[0] ?? this.lines.hover[0]
    this.scale = first ? mmPerPx(first.from) : 0
    const bar = (l: MarkLine, px: number, m: MeshBasicMaterial) => {
      const a = new Vector3(...l.from)
      const b = new Vector3(...l.to)
      const len = a.distanceTo(b)
      if (len < 1e-6) return
      const r = px * mmPerPx([(l.from[0] + l.to[0]) / 2, (l.from[1] + l.to[1]) / 2, (l.from[2] + l.to[2]) / 2])
      const mesh = new Mesh(UNIT, m)
      mesh.scale.set(r, len, r)
      mesh.position.copy(a.clone().add(b).multiplyScalar(0.5))
      mesh.quaternion.copy(new Quaternion().setFromUnitVectors(UP, b.clone().sub(a).normalize()))
      mesh.renderOrder = 6
      mesh.raycast = () => {}
      this.group.add(mesh)
    }
    for (const l of this.lines.hover) bar(l, HOVER_PX, this.hover)
    for (const l of this.lines.picked) bar(l, PICKED_PX, this.picked)
  }

  setColor(color: string): void {
    this.picked.color.set(color)
    this.hover.color.set(color)
  }

  dispose(): void {
    for (const c of [...this.group.children]) this.group.remove(c)
    this.picked.dispose()
    this.hover.dispose()
  }
}
