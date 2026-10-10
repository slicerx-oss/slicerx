// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Scale gizmo handles, laid out as in OrcaSlicer's GLGizmoScale3D (Orca v2.4.2): an x and a y handle on
// each side at the middle of the bottom edges, one z handle at the top, four uniform handles at the
// bottom corners of the selected model's box (in the model's own axes). They keep a constant size on
// screen and draw over the model.
import { BoxGeometry, Box3, Color, Group, Mesh, MeshBasicMaterial, Raycaster, Vector3, type Camera, type Object3D } from 'three'
import { handleAxis, handleIds, handleLocal, oppositeHandle, type HandleId, type ScaleLayout, type V3 } from './scaling'

// Orca colors: the axis colors, cyan for uniform handles, gray for the handle that Ctrl pins.
const AXIS: Record<'x' | 'y' | 'z' | 'uniform', string> = { x: '#ff6b6b', y: '#51cf66', z: '#4dabf7', uniform: '#00ffff' }
const CONSTRAINED = '#808080'
const HOT = '#ffe066'
const SIZE_PX = 9
const ALL_IDS = handleIds('faces')

export class ScaleGizmo {
  readonly group = new Group()
  private readonly handles = new Map<HandleId, Mesh>()
  private readonly lines = new Map<HandleId, Mesh>()
  private hover: HandleId | null = null
  private dragging: HandleId | null = null

  constructor() {
    this.group.name = 'scale-gizmo'
    this.group.visible = false
    for (const id of ALL_IDS) {
      const axis = handleAxis(id)
      const h = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: new Color(AXIS[axis]), depthTest: false, transparent: true, opacity: 0.95, toneMapped: false }))
      h.renderOrder = 10
      h.userData.handle = id
      this.handles.set(id, h)
      this.group.add(h)
      if (axis !== 'uniform') {
        const l = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: new Color(AXIS[axis]), depthTest: false, transparent: true, opacity: 0.6, toneMapped: false }))
        l.renderOrder = 9
        l.raycast = () => {}
        this.lines.set(id, l)
        this.group.add(l)
      }
    }
  }

  private layout: ScaleLayout = 'bottom'
  private uniformOnly = false
  private rootPivot: 'bottom-center' | 'center' = 'bottom-center'

  /** World position of each handle of the current layout for a model whose local box is `box`. */
  positions(obj: Object3D, box: Box3): Partial<Record<HandleId, Vector3>> {
    const min = box.min.toArray() as V3
    const max = box.max.toArray() as V3
    const out: Partial<Record<HandleId, Vector3>> = {}
    for (const id of handleIds(this.layout)) out[id] = obj.localToWorld(new Vector3(...handleLocal(id, min, max, this.layout)))
    return out
  }

  /** Places the handles for this model and camera, or hides the gizmo with null. `ctrl` shows the pinned handle in gray. */
  update(obj: Object3D | null, box: Box3 | null, camera: Camera, viewHeightPx: number, fovDeg: number, opts: { layout: ScaleLayout; pivot: 'bottom-center' | 'center'; pinned: boolean; uniformOnly?: boolean }): void {
    this.layout = opts.layout
    this.uniformOnly = opts.uniformOnly ?? false
    this.rootPivot = opts.pivot
    const ctrl = opts.pinned
    this.group.visible = !!obj && !!box && !box.isEmpty()
    if (!obj || !box || box.isEmpty()) return
    obj.updateMatrixWorld(true)
    const pos = this.positions(obj, box)
    const min = box.min.toArray() as V3
    const max = box.max.toArray() as V3
    const root = obj.localToWorld(new Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, this.rootPivot === 'center' ? (min[2] + max[2]) / 2 : min[2]))
    const shown = new Set(this.shownIds())
    const active = this.dragging ?? this.hover
    for (const [id, h] of this.handles) {
      h.visible = shown.has(id)
      const line0 = this.lines.get(id)
      if (line0) line0.visible = shown.has(id)
      const p = pos[id]
      if (!p) continue
      const dist = camera.position.distanceTo(p)
      const size = (2 * dist * Math.tan((fovDeg * Math.PI) / 360) * SIZE_PX) / Math.max(1, viewHeightPx)
      h.position.copy(p)
      h.scale.setScalar(size * (handleAxis(id) === 'uniform' ? 1.15 : 1))
      const pinned = ctrl && active !== null && oppositeHandle(active, this.layout) === id
      const color = id === active ? HOT : pinned ? CONSTRAINED : AXIS[handleAxis(id)]
      ;(h.material as MeshBasicMaterial).color.set(color)
      const line = this.lines.get(id)
      if (line) {
        const len = root.distanceTo(p)
        line.position.copy(root).lerp(p, 0.5)
        if (len > 1e-6) line.lookAt(p)
        line.scale.set(size * 0.2, size * 0.2, Math.max(len, 1e-6))
        ;(line.material as MeshBasicMaterial).color.set(color)
      }
    }
  }

  /** The handles drawn: every one of the layout, or only the even ones for a multi-selection. */
  private shownIds(): HandleId[] {
    // a multi-selection scales as one, evenly: an axis scale of turned objects would shear them
    return handleIds(this.layout).filter((id) => !this.uniformOnly || handleAxis(id) === 'uniform')
  }

  hit(ray: Raycaster): HandleId | null {
    if (!this.group.visible) return null
    const h = ray.intersectObjects([...this.handles.values()].filter((m) => m.visible), false)[0]
    return (h?.object.userData.handle as HandleId | undefined) ?? null
  }

  setHover(id: HandleId | null): boolean {
    if (id === this.hover) return false
    this.hover = id
    return true
  }

  setDragging(id: HandleId | null): void {
    this.dragging = id
  }

  /** Handle positions in world space, for tests and tutorials. */
  handleWorld(obj: Object3D, box: Box3): Partial<Record<HandleId, V3>> {
    const p = this.positions(obj, box)
    const out: Partial<Record<HandleId, V3>> = {}
    for (const id of this.shownIds()) {
      const v = p[id]
      if (v) out[id] = v.toArray() as V3
    }
    return out
  }

  dispose(): void {
    for (const m of [...this.handles.values(), ...this.lines.values()]) {
      m.geometry.dispose()
      ;(m.material as MeshBasicMaterial).dispose()
    }
    this.group.removeFromParent()
  }
}
