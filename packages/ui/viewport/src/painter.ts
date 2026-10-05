// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Paint tools on the plate: the paint maps of every part, strokes, the clipping plane, cursors and the
// overlay meshes that draw painted pieces on top of the models. How the tools behave (buttons, wheel keys,
// steps, defaults) comes from the preset's paint bindings (gizmobindings.ts).
import {
  BufferAttribute, BufferGeometry, Box3, CircleGeometry, Color, DoubleSide, Group, LineBasicMaterial, LineDashedMaterial, LineLoop, LineSegments, Mesh, MeshBasicMaterial, MeshStandardMaterial, Plane, SphereGeometry,
  Matrix3, Vector3, type Camera, type Object3D,
} from 'three'
import { planeContour } from './contour'
import type { PaintBindings } from './gizmobindings'
import type { ObjectEntry } from './model'
import {
  autoDetail, cylinderRegion, decodeTree, encodeTree, fillByAngle, fillConnected, gapFill, gridFor, isLeaf, leavesOf, paintDab, paintLeafAt, paintPatch, readPaintTexts, replaceEverywhere,
  slabRegion, sphereRegion, stateAt, trianglePoints, withPointFilter,
  type PaintMap, type PaintNode, type PaintRecorder, type PaintRegion, type V3,
} from './paint'
import type { PaintEdit, PaintLayer, PaintSettings, PaintStroke } from './types'

export const DEFAULT_PAINT: PaintSettings = {
  layer: 'color',
  tool: 'brush',
  shape: 'sphere',
  radiusMm: 1,
  state: 1,
  erase: false,
  splitTriangles: true,
  detailMm: 0,
  angleDeg: 30,
  fillAngleDeg: 30,
  heightMm: 0.2,
  heightRangeMm: [0, 10],
  gapAreaMm2: 0,
  secondState: 2,
  overhangOnlyDeg: 0,
  clipRatio: 0,
}

// Cursor tints from OrcaSlicer's painter: hover black, left button blue, right button red, each at 25 percent.
const CURSOR_HOVER = { color: '#000000' }
const CURSOR_LEFT = { color: '#0000ff' }
const CURSOR_RIGHT = { color: '#ff0000' }
const ENFORCER = '#50fa7b'
const BLOCKER = '#ff5555'
// Painted fuzzy skin: Nocturne orange, apart from the support and seam green and red.
const FUZZY = '#ffb86c'
const SLOT_FALLBACK = ['#f7d959', '#fec600', '#ebebe6', '#1d1d21', '#ff9016', '#de4343', '#56b7e6', '#61c680']

interface PartPaint {
  map: PaintMap
  overlay: Mesh | null
  dirty: boolean
}

/** What a pointer hit tells the painter. Point and direction are in world space. */
export interface PaintHit {
  entry: ObjectEntry
  part: number
  point: Vector3
  dir: Vector3
  face: number
}

export class Painter {
  settings: PaintSettings = { ...DEFAULT_PAINT, heightRangeMm: [...DEFAULT_PAINT.heightRangeMm] }
  private colors: readonly string[] = SLOT_FALLBACK
  private readonly parts = new Map<string, PartPaint>()
  /** Edits of the running stroke, by part: a drag can cross onto another part of the model. */
  private stroke: { objectId: string; layer: PaintLayer; parts: Map<number, Map<number, PaintNode | null>> } | null = null
  private cursorGroup: Group | null = null
  active = false
  private strokeErase = false
  private strokeState: number | null = null

  /** The clipping plane (Alt and the wheel in Orca, Ctrl in PrusaSlicer): what lies in front of it is hidden and not painted. */
  private clip: { ratio: number; normal: Vector3 | null; center: Vector3; radius: number } = { ratio: 0, normal: null, center: new Vector3(), radius: 1 }
  onClip: (() => void) | null = null
  private button: 'none' | 'left' | 'right' = 'none'
  private contours: { key: string; lines: LineSegments[] } | null = null

  constructor(
    private readonly entryOf: (id: string) => ObjectEntry | undefined,
    private readonly parent: Object3D,
    private readonly invalidate: () => void,
    private readonly emitStroke: (s: PaintStroke) => void,
    private readonly bindings: () => PaintBindings,
  ) {}

  /** Puts the tool defaults of the current preset into the settings (radius, band, angles, gap area). */
  applyPreset(): void {
    const b = this.bindings()
    this.settings = {
      ...this.settings,
      radiusMm: b.radius.default,
      heightMm: b.height.default,
      angleDeg: b.angle.smart,
      fillAngleDeg: b.angle.bucket,
      gapAreaMm2: b.gapArea?.default ?? 0,
      tool: b.tools.includes(this.settings.tool) ? this.settings.tool : 'brush',
    }
    this.invalidate()
  }

  // ---- clipping plane ----

  /** Plane that keeps what is behind the clip (three.js keeps points with a non-negative distance). Null when off. */
  clipPlane(): Plane | null {
    const c = this.clip
    if (c.ratio === 0 || !c.normal) return null
    return new Plane(c.normal.clone().negate(), c.normal.dot(c.center) + c.radius * (1 - 2 * c.ratio))
  }

  /** True when a world point is in front of the clip and so hidden and skipped by the tools. */
  isClipped(p: Vector3): boolean {
    const c = this.clip
    if (c.ratio === 0 || !c.normal) return false
    return c.normal.dot(p.clone().sub(c.center)) > c.radius * (1 - 2 * c.ratio)
  }

  /**
   * Moves the clip to `ratio` (0 off, 1 everything). The normal points at the camera when the clip first turns on and is
   * kept after that, as in Orca; the plane sweeps from the front of the model's bounding sphere to its back.
   */
  setClip(ratio: number, camera: Camera | null, entry: ObjectEntry | null): void {
    const r = Math.min(1, Math.max(0, Math.round(ratio * 100) / 100))
    if (r === 0) this.clip = { ...this.clip, ratio: 0, normal: null }
    else {
      if (!this.clip.normal && camera) this.clip.normal = camera.getWorldDirection(new Vector3()).negate()
      if (entry) {
        entry.group.updateMatrixWorld(true)
        const box = new Box3().setFromObject(entry.group)
        this.clip.center = box.getCenter(new Vector3())
        this.clip.radius = Math.max(1e-3, box.getSize(new Vector3()).length() / 2)
      }
      this.clip.ratio = r
    }
    this.settings = { ...this.settings, clipRatio: this.clip.ratio }
    for (const p of this.parts.values()) if (p.overlay) this.applyClip(p.overlay.material as MeshStandardMaterial)
    this.onClip?.()
    this.onSettings?.(this.settings)
    this.invalidate()
  }

  /** Puts the clipping plane on a material (the overlays use it; the viewport does the models). */
  applyClip(m: { clippingPlanes: Plane[] | null; needsUpdate: boolean }): void {
    const plane = this.clipPlane()
    const had = m.clippingPlanes !== null && m.clippingPlanes.length > 0
    m.clippingPlanes = plane ? [plane] : null
    if (had !== !!plane) m.needsUpdate = true
  }

  private key(id: string, part: number, layer: PaintLayer): string {
    return `${id}|${part}|${layer}`
  }

  private get(id: string, part: number, layer: PaintLayer): PartPaint {
    const k = this.key(id, part, layer)
    let p = this.parts.get(k)
    if (!p) {
      p = { map: new Map(), overlay: null, dirty: true }
      this.parts.set(k, p)
    }
    return p
  }

  setColors(colors: readonly string[]): void {
    this.colors = colors.length ? colors : SLOT_FALLBACK
    for (const p of this.parts.values()) p.dirty = true
    this.invalidate()
  }

  update(s: Partial<PaintSettings>): void {
    const tools = this.bindings().tools
    const next = { ...this.settings, ...s, heightRangeMm: s.heightRangeMm ? ([s.heightRangeMm[0], s.heightRangeMm[1]] as [number, number]) : this.settings.heightRangeMm }
    // A tool the look's source app does not have is ignored.
    if (s.tool && !tools.includes(s.tool)) next.tool = this.settings.tool
    if (s.clipRatio !== undefined && s.clipRatio !== this.clip.ratio) {
      this.settings = next
      this.setClip(s.clipRatio, null, null)
      return
    }
    this.settings = next
    this.showLayerOverlays()
    this.invalidate()
  }

  /**
   * The wheel in the paint tool, one step per notch (`dir` +1 up, -1 down). `param` changes what the tool has (radius, height
   * band, fill angle or gap area) in the steps of the preset; `clip` moves the clipping plane by 0.01.
   */
  wheel(dir: 1 | -1, what: 'param' | 'clip', camera: Camera | null = null, entry: ObjectEntry | null = null): void {
    const b = this.bindings()
    const s = this.settings
    const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(v * 100) / 100))
    if (what === 'clip') {
      this.setClip(this.clip.ratio + dir * 0.01, camera, entry)
      return
    }
    if (s.tool === 'height') s.heightMm = clamp(s.heightMm + dir * b.height.step, b.height.min, b.height.max)
    else if (s.tool === 'fill' || s.tool === 'smart') {
      const a = b.angle
      const cur = s.tool === 'smart' ? s.angleDeg : s.fillAngleDeg
      const next = clamp(cur + dir * a.step, a.min, a.max)
      if (a.shared) {
        s.angleDeg = next
        s.fillAngleDeg = next
      } else if (s.tool === 'smart') s.angleDeg = next
      else s.fillAngleDeg = next
    } else if (s.tool === 'gap' && b.gapArea) s.gapAreaMm2 = clamp(s.gapAreaMm2 + dir * b.gapArea.step, b.gapArea.min, b.gapArea.max)
    else if (s.tool === 'brush') s.radiusMm = clamp(s.radiusMm + dir * b.radius.step, b.radius.min, b.radius.max)
    this.invalidate()
    this.onSettings?.(this.settings)
  }

  onSettings: ((s: PaintSettings) => void) | null = null

  setActive(on: boolean): void {
    this.active = on
    if (!on) {
      this.setCursor(null, new Vector3())
      if (this.clip.ratio !== 0) this.setClip(0, null, null)
    }
    this.showLayerOverlays()
    this.invalidate()
  }

  private showLayerOverlays(): void {
    for (const [k, p] of this.parts) {
      if (!p.overlay) continue
      const layer = k.split('|')[2] as PaintLayer
      p.overlay.visible = layer === 'color' || (this.active && layer === this.settings.layer)
    }
  }

  // ---- data ----

  getData(id: string, part: number, layer: PaintLayer): Record<number, string> {
    const out: Record<number, string> = {}
    const m = this.parts.get(this.key(id, part, layer))?.map
    if (!m) return out
    for (const [t, n] of m) {
      const s = encodeTree(n)
      if (s) out[t] = s
    }
    return out
  }

  setData(id: string, part: number, layer: PaintLayer, texts: Record<number, string> | null): number[] {
    const p = this.get(id, part, layer)
    const { map, bad } = readPaintTexts(texts ?? {})
    p.map = map
    p.dirty = true
    this.invalidate()
    return bad
  }

  applyEdits(id: string, part: number, layer: PaintLayer, edits: readonly { triangle: number; text: string | null }[]): void {
    const p = this.get(id, part, layer)
    for (const e of edits) {
      const n = e.text ? decodeTree(e.text) : null
      if (n && !(isLeaf(n) && n.state === 0)) p.map.set(e.triangle, n)
      else p.map.delete(e.triangle)
    }
    p.dirty = true
    this.invalidate()
  }

  hasPaint(id: string, part: number, layer: PaintLayer): boolean {
    return (this.parts.get(this.key(id, part, layer))?.map.size ?? 0) > 0
  }

  // ---- strokes ----

  private state(): number {
    if (this.settings.erase || this.strokeErase) return 0
    return this.strokeState ?? this.settings.state
  }

  /** Starts a stroke. `erase` (the erase key) writes state 0; `state` overrides the setting (a blocker, the second color). */
  begin(entry: ObjectEntry, part: number, opts: { erase?: boolean; state?: number; button?: 'left' | 'right' } = {}): void {
    this.strokeErase = opts.erase ?? false
    this.strokeState = opts.state ?? null
    this.button = opts.button ?? 'left'
    this.stroke = { objectId: entry.id, layer: this.settings.layer, parts: new Map([[part, new Map()]]) }
  }

  private strokeBefore(entry: ObjectEntry, part: number): PaintRecorder {
    if (!this.stroke || this.stroke.objectId !== entry.id) this.begin(entry, part)
    const st = this.stroke as NonNullable<Painter['stroke']>
    let before = st.parts.get(part)
    if (!before) {
      before = new Map()
      st.parts.set(part, before)
    }
    const b = before
    return (t, prev) => {
      if (!b.has(t)) b.set(t, prev ?? null)
    }
  }

  /** Gate for the tools that spread over triangles: overhang-only painting and the clipping plane. Null when neither is on. */
  private gateFor(mesh: Mesh, src: { positions: Float32Array; indices: Uint32Array | Uint16Array }, useOverhang: boolean): ((t: number) => boolean) | null {
    const limit = useOverhang && this.settings.overhangOnlyDeg > 0 ? -Math.cos((this.settings.overhangOnlyDeg * Math.PI) / 180) : null
    const clipped = this.clipPlane() !== null
    if (limit === null && !clipped) return null
    const nm = new Matrix3().getNormalMatrix(mesh.matrixWorld)
    const tmp = new Vector3()
    return (t) => {
      const tri = trianglePoints(src.positions, src.indices, t)
      if (limit !== null) {
        const a = tri[0]
        const b = tri[1]
        const c = tri[2]
        tmp.set((b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).applyMatrix3(nm).normalize()
        // World up is the y axis of the scene; Orca compares the world z of the face normal with -cos of the angle.
        if (!(tmp.y < limit)) return false
      }
      if (clipped) for (const v of tri) if (this.isClipped(mesh.localToWorld(new Vector3(v[0], v[1], v[2])))) return false
      return true
    }
  }

  /** One dab or one fill at a hit. Returns true if anything changed. */
  apply(hit: PaintHit): boolean {
    const s = this.settings
    const mesh = hit.entry.parts[hit.part]?.mesh
    const src = mesh?.userData.source as { positions: Float32Array; indices: Uint32Array | Uint16Array } | undefined
    if (!mesh || !src) return false
    const record = this.strokeBefore(hit.entry, hit.part)
    const layer = (this.stroke as NonNullable<Painter['stroke']>).layer
    const pp = this.get(hit.entry.id, hit.part, layer)
    mesh.updateWorldMatrix(true, false)
    const local = mesh.worldToLocal(hit.point.clone())
    const scale = mesh.matrixWorld.getMaxScaleOnAxis() || 1
    const rLocal = s.radiusMm / scale
    const state = this.state()
    const b = this.bindings()
    const mesh2 = { positions: src.positions, indices: src.indices }
    let changed: number[] = []
    if (s.tool === 'brush') {
      const c: V3 = [local.x, local.y, local.z]
      const dirLocal = hit.dir.clone().transformDirection(mesh.matrixWorld.clone().invert())
      const d: V3 = [dirLocal.x, dirLocal.y, dirLocal.z]
      let region: PaintRegion = s.shape === 'sphere' ? sphereRegion(c, rLocal) : cylinderRegion(c, d, rLocal, false)
      if (this.clipPlane()) {
        const tmp = new Vector3()
        region = withPointFilter(region, (p) => !this.isClipped(mesh.localToWorld(tmp.set(p[0], p[1], p[2]))))
      }
      const limit = s.detailMm > 0 ? s.detailMm : Math.min(s.radiusMm / b.detail.divisor, b.detail.cap ?? Infinity)
      changed = paintPatch(mesh2, pp.map, hit.face, region, state, { minEdge: Math.max(0.005, limit / scale), noSplit: !s.splitTriangles }, d, record, this.gateFor(mesh, src, true) ?? undefined)
    } else if (s.tool === 'triangle') {
      const t = hit.face
      const tri = trianglePoints(src.positions, src.indices, t)
      const before = pp.map.get(t) ?? { state: 0 }
      const after = paintLeafAt(tri, before, [local.x, local.y, local.z], state)
      if (after !== before) {
        record(t, pp.map.get(t))
        if (isLeaf(after) && after.state === 0) pp.map.delete(t)
        else pp.map.set(t, after)
        changed = [t]
      }
    } else if (s.tool === 'fill') {
      changed = fillConnected(mesh2, pp.map, hit.face, [local.x, local.y, local.z], state, s.fillAngleDeg, record)
    } else if (s.tool === 'smart') {
      changed = fillByAngle(mesh2, pp.map, hit.face, state, s.angleDeg, record, this.gateFor(mesh, src, true) ?? undefined)
    } else if (s.tool === 'replace') {
      changed = this.replaceAll(hit, state)
    } else if (s.tool === 'height') {
      const z = hit.point.y
      const [lo, hi] = b.height.anchor === 'center' ? [z - s.heightMm / 2, z + s.heightMm / 2] : [z, z + s.heightMm]
      changed = this.heightRange(hit.entry, hit.part, pp, state, lo, hi, record)
      // Orca paints the band on every part of the model, not only the one under the pointer.
      hit.entry.parts.forEach((_, i) => {
        if (i === hit.part) return
        const other = this.get(hit.entry.id, i, layer)
        const rec = this.strokeBefore(hit.entry, i)
        if (this.heightRange(hit.entry, i, other, state, lo, hi, rec).length) other.dirty = true
      })
    }
    if (!changed.length) return false
    pp.dirty = true
    this.invalidate()
    return true
  }

  /** PrusaSlicer's color replace: every piece of the color under the pointer, on every part, takes the new state. */
  private replaceAll(hit: PaintHit, state: number): number[] {
    const layer = this.settings.layer
    const mesh = hit.entry.parts[hit.part]?.mesh
    const src = mesh?.userData.source as { positions: Float32Array; indices: Uint32Array | Uint16Array } | undefined
    if (!mesh || !src) return []
    const local = mesh.worldToLocal(hit.point.clone())
    const pp = this.get(hit.entry.id, hit.part, layer)
    const tri = trianglePoints(src.positions, src.indices, hit.face)
    const target = stateAt(tri, pp.map.get(hit.face) ?? { state: 0 }, [local.x, local.y, local.z])
    if (target === state) return []
    let first: number[] = []
    hit.entry.parts.forEach((part, i) => {
      const m = part.mesh
      const sr = m.userData.source as { positions: Float32Array; indices: Uint32Array | Uint16Array } | undefined
      if (!sr) return
      const p = this.get(hit.entry.id, i, layer)
      const rec = this.strokeBefore(hit.entry, i)
      m.updateWorldMatrix(true, false)
      const gate = this.gateFor(m, sr, false)
      const changed = replaceEverywhere({ positions: sr.positions, indices: sr.indices }, p.map, target, state, gate ?? undefined, rec)
      if (changed.length) p.dirty = true
      if (i === hit.part) first = changed
    })
    return first
  }

  /**
   * Gap fill (Orca and Bambu Studio's Perform button): patches smaller than `gapAreaMm2` merge into a neighbor, on every part of
   * the model, as one stroke per part.
   */
  performGapFill(entry: ObjectEntry): void {
    const layer = this.settings.layer
    entry.parts.forEach((part, i) => {
      const sr = part.mesh.userData.source as { positions: Float32Array; indices: Uint32Array | Uint16Array } | undefined
      if (!sr) return
      const pp = this.get(entry.id, i, layer)
      const before = new Map<number, PaintNode | null>()
      part.mesh.updateWorldMatrix(true, false)
      const scale = part.mesh.matrixWorld.getMaxScaleOnAxis() || 1
      const changed = gapFill({ positions: sr.positions, indices: sr.indices }, pp.map, this.settings.gapAreaMm2 / (scale * scale), (t, prev) => {
        if (!before.has(t)) before.set(t, prev ?? null)
      })
      if (!changed.length) return
      pp.dirty = true
      this.emitStroke({ objectId: entry.id, partIndex: i, layer, edits: this.edits(pp.map, before) })
    })
    this.invalidate()
  }

  /** Paints the bed-height range on one part. */
  private heightRange(entry: ObjectEntry, part: number, pp: PartPaint, state: number, worldLo: number, worldHi: number, record?: PaintRecorder): number[] {
    const mesh = entry.parts[part]?.mesh
    const src = mesh?.userData.source as { positions: Float32Array; indices: Uint32Array | Uint16Array } | undefined
    if (!mesh || !src) return []
    mesh.updateWorldMatrix(true, false)
    const e = mesh.matrixWorld.elements
    // World height of a local point p is row 1 of the matrix times p, plus the y translation.
    const row: V3 = [e[1] ?? 0, e[5] ?? 0, e[9] ?? 0]
    const sc = Math.hypot(...row) || 1
    const ty = e[13] ?? 0
    let region: PaintRegion = slabRegion(row, (Math.min(worldLo, worldHi) - ty) / sc, (Math.max(worldLo, worldHi) - ty) / sc)
    if (this.clipPlane()) {
      const tmp = new Vector3()
      region = withPointFilter(region, (p) => !this.isClipped(mesh.localToWorld(tmp.set(p[0], p[1], p[2]))))
    }
    const box = mesh.geometry.boundingBox
    const bb: [V3, V3] = box ? [[box.min.x, box.min.y, box.min.z], [box.max.x, box.max.y, box.max.z]] : [[-1e6, -1e6, -1e6], [1e6, 1e6, 1e6]]
    // Orca's height range splits down to 0.1 mm whatever the brush radius.
    return paintDab({ positions: src.positions, indices: src.indices }, pp.map, bb, region, state, { minEdge: Math.max(0.005, (this.settings.detailMm > 0 ? this.settings.detailMm : 0.1) / (mesh.matrixWorld.getMaxScaleOnAxis() || 1)), noSplit: !this.settings.splitTriangles }, record)
  }

  /** The band `[lo, hi]` (bed height, mm) over every part of a model, as one stroke. Defaults to `heightRangeMm`. */
  paintHeightRange(entry: ObjectEntry, range?: [number, number]): void {
    const [lo, hi] = range ?? this.settings.heightRangeMm
    const layer = this.settings.layer
    const st = this.settings.erase ? 0 : this.settings.state
    entry.parts.forEach((_, i) => {
      const pp = this.get(entry.id, i, layer)
      const b = new Map<number, PaintNode | null>()
      const changed = this.heightRange(entry, i, pp, st, lo, hi, (t, prev) => {
        if (!b.has(t)) b.set(t, prev ?? null)
      })
      if (!changed.length) return
      pp.dirty = true
      this.emitStroke({ objectId: entry.id, partIndex: i, layer, edits: this.edits(pp.map, b) })
    })
    this.invalidate()
  }

  private edits(map: PaintMap, before: Map<number, PaintNode | null>): PaintEdit[] {
    const out: PaintEdit[] = []
    for (const [t, b] of before) {
      const a = map.get(t) ?? null
      const bt = b ? encodeTree(b) : null
      const at = a ? encodeTree(a) : null
      if (bt !== at) out.push({ triangle: t, before: bt, after: at })
    }
    return out
  }

  /** Ends a stroke and reports it. */
  end(): void {
    const st = this.stroke
    this.stroke = null
    this.strokeErase = false
    this.strokeState = null
    this.button = 'none'
    if (!st) return
    for (const [part, before] of st.parts) {
      const pp = this.parts.get(this.key(st.objectId, part, st.layer))
      if (!pp) continue
      const edits = this.edits(pp.map, before)
      if (edits.length) this.emitStroke({ objectId: st.objectId, partIndex: part, layer: st.layer, edits })
    }
  }

  cancel(): void {
    this.stroke = null
    this.strokeErase = false
    this.strokeState = null
    this.button = 'none'
  }

  // ---- drawing ----

  /**
   * The cursor of the running tool, drawn as OrcaSlicer draws it (GLGizmoPainterBase): a translucent sphere at the hit for the
   * sphere brush, tinted black when hovering, blue with the left button down and red with the right; for the circle brush a
   * dashed green ring with a translucent disc facing the camera; for the height tool the cut of the model at the bottom and top
   * of the band. Other tools show none.
   */
  setCursor(hit: PaintHit | null, dir: Vector3): void {
    const s = this.settings
    const show = !!hit && this.active && (s.tool === 'brush' || s.tool === 'height')
    if (!show || !hit) {
      if (this.cursorGroup) this.cursorGroup.visible = false
      this.clearContours()
      return
    }
    if (s.tool === 'height') {
      if (this.cursorGroup) this.cursorGroup.visible = false
      this.showContours(hit)
      return
    }
    this.clearContours()
    if (!this.cursorGroup) {
      const g = new Group()
      g.renderOrder = 6
      const sphere = new Mesh(new SphereGeometry(1, 24, 16), new MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false }))
      sphere.name = 'sphere'
      const disc = new Mesh(new CircleGeometry(1, 48), new MeshBasicMaterial({ transparent: true, depthWrite: false, depthTest: false, toneMapped: false, side: DoubleSide }))
      disc.name = 'disc'
      const pts: number[] = []
      for (let i = 0; i < 64; i++) pts.push(Math.cos((i / 64) * Math.PI * 2), Math.sin((i / 64) * Math.PI * 2), 0)
      const ringGeo = new BufferGeometry()
      ringGeo.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3))
      const ring = new LineLoop(ringGeo, new LineDashedMaterial({ color: new Color('#00ff4d'), dashSize: 0.12, gapSize: 0.12, depthTest: false, transparent: true }))
      ring.name = 'ring'
      ring.computeLineDistances()
      for (const o of [sphere, disc, ring]) {
        o.raycast = () => {}
        o.renderOrder = 6
        g.add(o)
      }
      this.parent.add(g)
      this.cursorGroup = g
    }
    const g = this.cursorGroup
    g.visible = true
    const sphere = g.getObjectByName('sphere') as Mesh
    const disc = g.getObjectByName('disc') as Mesh
    const ring = g.getObjectByName('ring') as LineLoop
    const sph = s.shape === 'sphere'
    sphere.visible = sph
    disc.visible = !sph
    ring.visible = !sph
    const tint = this.button === 'left' ? CURSOR_LEFT : this.button === 'right' ? CURSOR_RIGHT : CURSOR_HOVER
    for (const m of [sphere, disc]) {
      const mat = m.material as MeshBasicMaterial
      mat.color.set(tint.color)
      mat.opacity = 0.25
    }
    g.position.copy(this.parent.worldToLocal(hit.point.clone()))
    g.scale.setScalar(Math.max(s.radiusMm, 0.05))
    if (!sph) {
      g.up.set(0, 1, 0)
      g.lookAt(g.position.clone().add(dir))
    } else g.quaternion.identity()
    this.invalidate()
  }

  private clearContours(): void {
    if (!this.contours) return
    for (const l of this.contours.lines) {
      l.removeFromParent()
      l.geometry.dispose()
    }
    this.contours = null
  }

  /** The cut of each part at the bottom and top of the height band, in the part's own frame. */
  private showContours(hit: PaintHit): void {
    const b = this.bindings()
    const s = this.settings
    const z = hit.point.y
    const [lo, hi] = b.height.anchor === 'center' ? [z - s.heightMm / 2, z + s.heightMm / 2] : [z, z + s.heightMm]
    const key = `${hit.entry.id}|${lo.toFixed(3)}|${hi.toFixed(3)}`
    if (this.contours?.key === key) return
    this.clearContours()
    const lines: LineSegments[] = []
    const box = new Box3().setFromObject(hit.entry.group)
    for (const part of hit.entry.parts) {
      const mesh = part.mesh
      const src = mesh.userData.source as { positions: Float32Array; indices: Uint32Array | Uint16Array } | undefined
      if (!src) continue
      mesh.updateWorldMatrix(true, false)
      const e = mesh.matrixWorld.elements
      const row: V3 = [e[1] ?? 0, e[5] ?? 0, e[9] ?? 0]
      const sc = Math.hypot(...row) || 1
      const ty = e[13] ?? 0
      const n: V3 = [row[0] / sc, row[1] / sc, row[2] / sc]
      for (const h of [lo, hi]) {
        const clamped = Math.min(box.max.y, Math.max(box.min.y, h))
        const seg = planeContour(src.positions, src.indices, n, (clamped - ty) / sc)
        if (!seg.length) continue
        const g = new BufferGeometry()
        g.setAttribute('position', new BufferAttribute(seg, 3))
        const l = new LineSegments(g, new LineBasicMaterial({ color: new Color('#00ff4d'), depthTest: false, transparent: true, toneMapped: false }))
        l.raycast = () => {}
        l.renderOrder = 6
        mesh.add(l)
        lines.push(l)
      }
    }
    this.contours = { key, lines }
    this.invalidate()
  }

  private colorOf(layer: PaintLayer, state: number): Color {
    if (layer === 'color') return new Color(this.colors[state - 1] ?? SLOT_FALLBACK[(state - 1) % SLOT_FALLBACK.length] ?? '#ffffff')
    if (layer === 'fuzzy') return new Color(FUZZY)
    return new Color(state === 2 ? BLOCKER : ENFORCER)
  }

  /** Rebuilds overlays of parts whose paint changed. Call before rendering. Returns true if any changed. */
  sync(): boolean {
    let any = false
    for (const [k, p] of this.parts) {
      const [id, partS, layerS] = k.split('|') as [string, string, PaintLayer]
      const entry = this.entryOf(id)
      const part = entry?.parts[Number(partS)]
      const mesh = part?.mesh
      if (!mesh) {
        if (p.overlay) {
          p.overlay.removeFromParent()
          p.overlay.geometry.dispose()
          p.overlay = null
          p.dirty = true
        }
        continue
      }
      if (p.overlay && p.overlay.parent !== mesh) {
        p.overlay.removeFromParent()
        p.overlay.geometry.dispose()
        p.overlay = null
        p.dirty = true
      }
      if (!p.dirty) continue
      p.dirty = false
      any = true
      const src = mesh.userData.source as { positions: Float32Array; indices: Uint32Array | Uint16Array } | undefined
      if (!src) continue
      const pos: number[] = []
      const col: number[] = []
      for (const [t, node] of p.map) {
        const tri = trianglePoints(src.positions, src.indices, t)
        for (const leaf of leavesOf(tri, node)) {
          if (leaf.state === 0) continue
          const c = this.colorOf(layerS, leaf.state)
          for (const v of leaf.v) {
            pos.push(v[0], v[1], v[2])
            col.push(c.r, c.g, c.b)
          }
        }
      }
      if (p.overlay) {
        p.overlay.removeFromParent()
        p.overlay.geometry.dispose()
        p.overlay = null
      }
      if (!pos.length) continue
      const g = new BufferGeometry()
      g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
      g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3))
      g.computeVertexNormals()
      const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 })
      const o = new Mesh(g, m)
      o.raycast = () => {}
      o.castShadow = false
      o.renderOrder = 1
      this.applyClip(m)
      o.visible = layerS === 'color' || (this.active && layerS === this.settings.layer)
      mesh.add(o)
      p.overlay = o
    }
    return any
  }

  dispose(): void {
    for (const p of this.parts.values()) {
      p.overlay?.removeFromParent()
      p.overlay?.geometry.dispose()
    }
    this.parts.clear()
    this.cursorGroup?.removeFromParent()
    this.clearContours()
  }
}

/** Keeps `gridFor` linked so a part's triangle grid is built on first use. */
export function warmPaintGrid(positions: ArrayLike<number>, indices: ArrayLike<number>): void {
  gridFor({ positions, indices })
}

/** Whether a layer's state means anything for this tool (seam and support take 1 or 2). */
export function validState(layer: PaintLayer, state: number): boolean {
  return layer === 'color' ? state >= 1 && state <= 32 : state === 1 || state === 2
}
