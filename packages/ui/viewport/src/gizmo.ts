// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Scale gizmo handles, laid out as in OrcaSlicer's GLGizmoScale3D (Orca v2.4.2): an x and a y handle on
// each side at the middle of the bottom edges, one z handle at the top, four uniform handles at the
// bottom corners of the selected model's box (in the model's own axes). They keep a constant size on
// screen and draw over the model.
import { BoxGeometry, Box3, BufferGeometry, Group, Mesh, MeshBasicMaterial, Raycaster, Vector3, type Camera, type Object3D } from 'three'
import { SCENE, type HandleColors } from './palette'
import { handleAxis, handleIds, handleLocal, oppositeHandle, type HandleId, type ScaleLayout, type V3 } from './scaling'

const SIZE_PX = 9
/** Width of the outline under each handle, px; a stem's is thinner, so the stem keeps its color. */
export const HALO_PX = 1.5
const STEM_HALO_PX = 1
/** A stem's width as a share of a handle's. */
const STEM = 0.28
const ALL_IDS = handleIds('faces')

/** The fill of a handle on `axis`: the axis colors, and the uniform color for the corners. */
export function axisFill(c: HandleColors, axis: 'x' | 'y' | 'z' | 'uniform'): string {
  return axis === 'x' ? c.axisX : axis === 'y' ? c.axisY : axis === 'z' ? c.axisZ : c.axisUniform
}

/**
 * A handle material: unlit, fully opaque and drawn over everything in the theme's color. The view draws the handles over
 * its finished picture (FrameOptions.overlay), so the token color is what reaches the screen and the 3:1 it is chosen
 * for holds there. No depth: the handles never hide anything from the frame's depth.
 */
export function handleMaterial(color: string): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 1, toneMapped: false })
}

export class ScaleGizmo {
  readonly group = new Group()
  private readonly handles = new Map<HandleId, Mesh>()
  private readonly lines = new Map<HandleId, Mesh>()
  /** The outline under each handle and under each stem: the same shape a little wider, in the halo color. */
  private readonly halos = new Map<HandleId, Mesh>()
  private readonly lineHalos = new Map<HandleId, Mesh>()
  private readonly haloMat: MeshBasicMaterial
  private readonly cube = new BoxGeometry(1, 1, 1)
  private colors: HandleColors
  private hover: HandleId | null = null
  private dragging: HandleId | null = null

  constructor(colors: HandleColors = SCENE) {
    this.colors = { ...colors }
    this.group.name = 'scale-gizmo'
    this.group.visible = false
    this.haloMat = handleMaterial(colors.handleHalo)
    const add = (mat: MeshBasicMaterial, order: number): Mesh => {
      const m = new Mesh(this.cube, mat)
      m.renderOrder = order
      this.group.add(m)
      return m
    }
    for (const id of ALL_IDS) {
      const axis = handleAxis(id)
      // outlines first (7, 8), then the stems (9), then the handles (10): every fill sits on its outline
      const halo = add(this.haloMat, 8)
      halo.raycast = () => {}
      this.halos.set(id, halo)
      const h = add(handleMaterial(axisFill(colors, axis)), 10)
      h.userData.handle = id
      this.handles.set(id, h)
      if (axis !== 'uniform') {
        const lh = add(this.haloMat, 7)
        lh.raycast = () => {}
        this.lineHalos.set(id, lh)
        const l = add(handleMaterial(axisFill(colors, axis)), 9)
        l.raycast = () => {}
        this.lines.set(id, l)
      }
    }
  }

  private layout: ScaleLayout = 'bottom'
  private uniformOnly = false
  private rootPivot: 'bottom-center' | 'center' = 'bottom-center'

  /** The theme's handle colors. A hovered, dragged or pinned handle takes its color at the next update. */
  setColors(colors: HandleColors): void {
    this.colors = { ...colors }
    this.haloMat.color.set(colors.handleHalo)
    for (const [id, h] of this.handles) {
      const fill = axisFill(colors, handleAxis(id))
      ;(h.material as MeshBasicMaterial).color.set(fill)
      const l = this.lines.get(id)
      if (l) (l.material as MeshBasicMaterial).color.set(fill)
    }
  }

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
      const on = shown.has(id)
      h.visible = on
      const halo = this.halos.get(id) as Mesh
      halo.visible = on
      const line = this.lines.get(id)
      const lineHalo = this.lineHalos.get(id)
      if (line) line.visible = on
      if (lineHalo) lineHalo.visible = on
      const p = pos[id]
      if (!p) continue
      const dist = camera.position.distanceTo(p)
      const mmPerPx = (2 * dist * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, viewHeightPx)
      const size = mmPerPx * SIZE_PX
      const edge = 2 * HALO_PX * mmPerPx
      const s = size * (handleAxis(id) === 'uniform' ? 1.15 : 1)
      h.position.copy(p)
      h.scale.setScalar(s)
      halo.position.copy(p)
      halo.scale.setScalar(s + edge)
      const pinned = ctrl && active !== null && oppositeHandle(active, this.layout) === id
      const color = id === active ? this.colors.handleHot : pinned ? this.colors.handlePinned : axisFill(this.colors, handleAxis(id))
      ;(h.material as MeshBasicMaterial).color.set(color)
      if (line && lineHalo) {
        const len = root.distanceTo(p)
        for (const m of [lineHalo, line]) {
          m.position.copy(root).lerp(p, 0.5)
          if (len > 1e-6) m.lookAt(p)
        }
        const w = size * STEM
        const wh = w + 2 * STEM_HALO_PX * mmPerPx
        line.scale.set(w, w, Math.max(len, 1e-6))
        lineHalo.scale.set(wh, wh, Math.max(len, 1e-6))
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
    const geos = new Set<BufferGeometry>()
    const mats = new Set<MeshBasicMaterial>()
    for (const m of [...this.handles.values(), ...this.lines.values(), ...this.halos.values(), ...this.lineHalos.values()]) {
      geos.add(m.geometry)
      mats.add(m.material as MeshBasicMaterial)
    }
    for (const g of geos) g.dispose()
    for (const m of mats) m.dispose()
    this.group.removeFromParent()
  }
}
