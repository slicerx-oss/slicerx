// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 3D view's part of the modeling tools: the push and pull preview, the sketch layer and kept
// dimensions. Each one draws only while its tool has something to show, and keeps its buffers:
// a drag moves a matrix or rewrites a few floats in place, never builds geometry. The app does the
// geometry (the sx-geom worker) and hands over prisms, outlines and labels.
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Sprite,
  SpriteMaterial,
} from 'three'
import type { V3 } from './scaling'

export type V2 = [number, number]

/** A plane in bed coordinates (mm): origin, in-plane axes u and v, and the outward normal. */
export interface CadFrame {
  origin: V3
  u: V3
  v: V3
  normal: V3
}

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Plane coordinates of a bed point. */
export function toPlane(f: CadFrame, p: V3): V2 {
  const d: V3 = [p[0] - f.origin[0], p[1] - f.origin[1], p[2] - f.origin[2]]
  return [dot(d, f.u), dot(d, f.v)]
}

/** A plane point in bed coordinates. */
export function fromPlane(f: CadFrame, [x, y]: V2): V3 {
  return [f.origin[0] + f.u[0] * x + f.v[0] * y, f.origin[1] + f.u[1] * x + f.v[1] * y, f.origin[2] + f.u[2] * x + f.v[2] * y]
}

/** Where a ray (bed coordinates) meets the plane, in plane coordinates; null when it runs along it or points away. */
export function rayOnPlane(f: CadFrame, o: V3, d: V3): V2 | null {
  const den = dot(d, f.normal)
  if (Math.abs(den) < 1e-9) return null
  const t = dot([f.origin[0] - o[0], f.origin[1] - o[1], f.origin[2] - o[2]], f.normal) / den
  if (t < 0) return null
  return toPlane(f, [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t])
}

/** The plane's matrix: plane coordinates (x, y, 0) to bed coordinates. */
export function frameMatrix(f: CadFrame, out = new Matrix4()): Matrix4 {
  return out.set(f.u[0], f.v[0], f.normal[0], f.origin[0], f.u[1], f.v[1], f.normal[1], f.origin[1], f.u[2], f.v[2], f.normal[2], f.origin[2], 0, 0, 0, 1)
}

/**
 * A 1 mm push prism stretched to `d` mm: a scale by `d` along the normal about the face's plane.
 * The walls of a push run straight along the normal, so this is exactly the prism for `d`.
 */
export function prismMatrix(point: V3, normal: V3, d: number, out = new Matrix4()): Matrix4 {
  const [nx, ny, nz] = normal
  const k = d - 1
  // I + k n nᵀ, about the plane through `point`.
  const m00 = 1 + k * nx * nx
  const m01 = k * nx * ny
  const m02 = k * nx * nz
  const m11 = 1 + k * ny * ny
  const m12 = k * ny * nz
  const m22 = 1 + k * nz * nz
  const pn = dot(point, normal)
  return out.set(m00, m01, m02, -k * nx * pn, m01, m11, m12, -k * ny * pn, m02, m12, m22, -k * nz * pn, 0, 0, 0, 1)
}

const JOIN = '#50fa7b'
const CUT = '#ff5555'

/** What a fillet or chamfer would change: the removed pieces red, the added ones green, drawn through the model. Built only when set. */
export class EdgePreview {
  readonly group = new Group()
  private readonly cutFill = new MeshBasicMaterial({ color: new Color(CUT), transparent: true, opacity: 0.45, depthTest: false, depthWrite: false, side: DoubleSide, toneMapped: false })
  private readonly joinFill = new MeshBasicMaterial({ color: new Color(JOIN), transparent: true, opacity: 0.45, depthTest: false, depthWrite: false, side: DoubleSide, toneMapped: false })

  constructor() {
    this.group.name = 'edge-preview'
    this.group.renderOrder = 9
    this.group.visible = false
  }

  set(p: { cut: { positions: ArrayLike<number>; indices: ArrayLike<number> } | null; join: { positions: ArrayLike<number>; indices: ArrayLike<number> } | null } | null): void {
    this.clear()
    if (!p) return
    for (const [m, mat] of [[p.cut, this.cutFill], [p.join, this.joinFill]] as const) {
      if (!m || m.indices.length < 3) continue
      const g = new BufferGeometry()
      g.setAttribute('position', new Float32BufferAttribute(Array.from(m.positions), 3))
      g.setIndex(Array.from(m.indices))
      const mesh = new Mesh(g, mat)
      mesh.renderOrder = 9
      mesh.raycast = () => {}
      this.group.add(mesh)
    }
    this.group.visible = this.group.children.length > 0
  }

  private clear(): void {
    for (const c of [...this.group.children]) {
      c.removeFromParent()
      ;(c as Mesh).geometry.dispose()
    }
    this.group.visible = false
  }

  dispose(): void {
    this.clear()
    this.cutFill.dispose()
    this.joinFill.dispose()
  }
}

/** The push and pull preview: the swept prism, green when it adds and red when it cuts, drawn through the model. */
export class PushPreview {
  readonly group = new Group()
  private readonly fill = new MeshBasicMaterial({ color: new Color(JOIN), transparent: true, opacity: 0.28, depthTest: false, depthWrite: false, side: DoubleSide, toneMapped: false })
  private readonly edge = new LineBasicMaterial({ color: new Color(JOIN), transparent: true, opacity: 0.95, depthTest: false, toneMapped: false })
  private mesh: Mesh | null = null
  private lines: LineSegments | null = null
  private face: { point: V3; normal: V3 } | null = null

  constructor() {
    this.group.name = 'push-preview'
    this.group.matrixAutoUpdate = false
    this.group.renderOrder = 9
  }

  /** The 1 mm prism (bed coordinates) for the picked face; null clears it. */
  setPrism(prism: { positions: ArrayLike<number>; indices: ArrayLike<number> } | null, face: { point: V3; normal: V3 } | null): void {
    this.clear()
    this.face = face
    if (!prism || !face || prism.indices.length < 3) return
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(Array.from(prism.positions), 3))
    g.setIndex(Array.from(prism.indices))
    this.mesh = new Mesh(g, this.fill)
    this.mesh.renderOrder = 9
    this.mesh.raycast = () => {}
    this.lines = new LineSegments(new EdgesGeometry(g, 20), this.edge)
    this.lines.renderOrder = 10
    this.lines.raycast = () => {}
    this.group.add(this.mesh, this.lines)
  }

  /** Stretches the prism to `d` mm; 0 hides it. */
  setDistance(d: number): void {
    const f = this.face
    this.group.visible = !!f && !!this.mesh && Math.abs(d) > 1e-6
    if (!f) return
    prismMatrix(f.point, f.normal, d, this.group.matrix)
    this.group.matrixWorldNeedsUpdate = true
    const c = d < 0 ? CUT : JOIN
    this.fill.color.set(c)
    this.edge.color.set(c)
  }

  get hasPrism(): boolean {
    return this.mesh !== null
  }

  private clear(): void {
    for (const o of [this.mesh, this.lines]) {
      if (!o) continue
      o.removeFromParent()
      o.geometry.dispose()
    }
    this.mesh = null
    this.lines = null
  }

  dispose(): void {
    this.clear()
    this.fill.dispose()
    this.edge.dispose()
    this.group.removeFromParent()
  }
}

export type SketchTone = 'normal' | 'selected' | 'issue' | 'soft' | 'axis' | 'grid'

/** What the sketch layer shows, all in plane coordinates (mm). */
export interface SketchScene {
  frame: CadFrame
  /** Polylines: drawn segments, the picked face's outline (soft), problems (issue), a revolve axis. */
  paths: readonly { points: readonly V2[]; closed?: boolean; tone?: SketchTone }[]
  /** Points a press can grab when `dragHandles` is on; drawn as dots. */
  handles: readonly V2[]
  dragHandles?: boolean
  /** A faint grid, every `stepMm`, over the rectangle `min` to `max`. */
  grid?: { stepMm: number; min: V2; max: V2 }
  /** Problem spots, drawn as red dots. */
  marks?: readonly V2[]
}

/** The line being drawn (a polyline from the last point to the cursor), the snapped cursor and an alignment guide. */
export interface SketchCursor {
  path?: readonly V2[] | null
  at?: V2 | null
  guide?: readonly [V2, V2] | null
}

const TONE: Record<SketchTone, { color: string; opacity: number }> = {
  normal: { color: '#8be9fd', opacity: 1 },
  selected: { color: '#f1fa8c', opacity: 1 },
  issue: { color: '#ff5555', opacity: 1 },
  soft: { color: '#bd93f9', opacity: 0.55 },
  axis: { color: '#ffb86c', opacity: 1 },
  grid: { color: '#6272a4', opacity: 0.32 },
}

/** Room for the line being drawn: an arc preview needs the most points. */
const CURSOR_POINTS = 256

/**
 * The sketch on its plane. A group placed by the frame's matrix holds flat geometry, lifted a hair off
 * the plane and drawn through the model so it reads from any angle. `set` rebuilds the drawn sketch
 * (on a click or a point drag); `cursor` rewrites the rubber band in place.
 */
export class SketchLayer {
  readonly group = new Group()
  private readonly mats = new Map<SketchTone, LineBasicMaterial>()
  private readonly dotMat = new PointsMaterial({ color: new Color('#f8f8f2'), size: 7, sizeAttenuation: false, depthTest: false, toneMapped: false })
  private readonly markMat = new PointsMaterial({ color: new Color('#ff5555'), size: 10, sizeAttenuation: false, depthTest: false, toneMapped: false })
  private readonly snapMat = new PointsMaterial({ color: new Color('#f1fa8c'), size: 11, sizeAttenuation: false, depthTest: false, toneMapped: false })
  private drawn: (LineSegments | Points)[] = []
  private readonly band: Line
  private readonly bandPos = new Float32Array(CURSOR_POINTS * 3)
  private readonly snap: Points
  private readonly snapPos = new Float32Array(3)
  private readonly guide: Line
  private readonly guidePos = new Float32Array(6)
  scene: SketchScene | null = null

  constructor() {
    this.group.name = 'sketch'
    this.group.matrixAutoUpdate = false
    this.group.visible = false
    for (const [tone, t] of Object.entries(TONE) as [SketchTone, { color: string; opacity: number }][]) {
      this.mats.set(tone, new LineBasicMaterial({ color: new Color(t.color), transparent: true, opacity: t.opacity, depthTest: false, toneMapped: false }))
    }
    const bandGeo = new BufferGeometry()
    bandGeo.setAttribute('position', new BufferAttribute(this.bandPos, 3))
    bandGeo.setDrawRange(0, 0)
    this.band = new Line(bandGeo, this.mats.get('selected'))
    this.band.frustumCulled = false
    this.band.renderOrder = 12
    const snapGeo = new BufferGeometry()
    snapGeo.setAttribute('position', new BufferAttribute(this.snapPos, 3))
    snapGeo.setDrawRange(0, 0)
    this.snap = new Points(snapGeo, this.snapMat)
    this.snap.frustumCulled = false
    this.snap.renderOrder = 13
    const guideGeo = new BufferGeometry()
    guideGeo.setAttribute('position', new BufferAttribute(this.guidePos, 3))
    guideGeo.setDrawRange(0, 0)
    this.guide = new Line(guideGeo, this.mats.get('axis'))
    this.guide.frustumCulled = false
    this.guide.renderOrder = 11
    for (const o of [this.band, this.snap, this.guide]) o.raycast = () => {}
    this.group.add(this.band, this.snap, this.guide)
  }

  set(scene: SketchScene | null): void {
    for (const d of this.drawn) {
      d.removeFromParent()
      d.geometry.dispose()
    }
    this.drawn = []
    this.scene = scene
    this.group.visible = !!scene
    if (!scene) return this.cursor(null)
    frameMatrix(scene.frame, this.group.matrix)
    this.group.matrixWorldNeedsUpdate = true
    const lift = 0.02
    const byTone = new Map<SketchTone, number[]>()
    const push = (tone: SketchTone, a: readonly number[], b: readonly number[]) => {
      let list = byTone.get(tone)
      if (!list) byTone.set(tone, (list = []))
      list.push(a[0] ?? 0, a[1] ?? 0, lift, b[0] ?? 0, b[1] ?? 0, lift)
    }
    const g = scene.grid
    if (g && g.stepMm > 0) {
      const n = (lo: number, hi: number) => Math.min(400, Math.floor((hi - lo) / g.stepMm))
      const x0 = Math.ceil(g.min[0] / g.stepMm) * g.stepMm
      const y0 = Math.ceil(g.min[1] / g.stepMm) * g.stepMm
      for (let i = 0; i <= n(x0, g.max[0]); i++) push('grid', [x0 + i * g.stepMm, g.min[1]], [x0 + i * g.stepMm, g.max[1]])
      for (let i = 0; i <= n(y0, g.max[1]); i++) push('grid', [g.min[0], y0 + i * g.stepMm], [g.max[0], y0 + i * g.stepMm])
    }
    for (const p of scene.paths) {
      const pts = p.points
      for (let i = 0; i + 1 < pts.length; i++) push(p.tone ?? 'normal', pts[i]!, pts[i + 1]!)
      if (p.closed && pts.length > 2) push(p.tone ?? 'normal', pts[pts.length - 1]!, pts[0]!)
    }
    // Draw order: grid, soft, normal, axis, selected, issue on top.
    const order: SketchTone[] = ['grid', 'soft', 'normal', 'axis', 'selected', 'issue']
    order.forEach((tone, k) => {
      const pos = byTone.get(tone)
      if (!pos?.length) return
      const geo = new BufferGeometry()
      geo.setAttribute('position', new Float32BufferAttribute(pos, 3))
      const seg = new LineSegments(geo, this.mats.get(tone))
      seg.renderOrder = 6 + k * 0.1
      seg.raycast = () => {}
      this.group.add(seg)
      this.drawn.push(seg)
    })
    const dots = (list: readonly V2[] | undefined, mat: PointsMaterial, order: number) => {
      if (!list?.length) return
      const geo = new BufferGeometry()
      geo.setAttribute('position', new Float32BufferAttribute(list.flatMap((p) => [p[0], p[1], lift]), 3))
      const pts = new Points(geo, mat)
      pts.renderOrder = order
      pts.raycast = () => {}
      this.group.add(pts)
      this.drawn.push(pts)
    }
    dots(scene.handles, this.dotMat, 8)
    dots(scene.marks, this.markMat, 9)
  }

  /** The rubber band and snap marker; rewrites the fixed buffers, nothing is allocated. */
  cursor(c: SketchCursor | null): void {
    const path = c?.path ?? null
    const n = path ? Math.min(CURSOR_POINTS, path.length) : 0
    for (let i = 0; i < n; i++) {
      const p = path![i]!
      this.bandPos[3 * i] = p[0]
      this.bandPos[3 * i + 1] = p[1]
      this.bandPos[3 * i + 2] = 0.03
    }
    const bg = this.band.geometry
    bg.setDrawRange(0, n >= 2 ? n : 0)
    ;(bg.getAttribute('position') as BufferAttribute).needsUpdate = true
    const at = c?.at ?? null
    if (at) {
      this.snapPos[0] = at[0]
      this.snapPos[1] = at[1]
      this.snapPos[2] = 0.04
    }
    this.snap.geometry.setDrawRange(0, at ? 1 : 0)
    ;(this.snap.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true
    const gd = c?.guide ?? null
    if (gd) this.guidePos.set([gd[0][0], gd[0][1], 0.025, gd[1][0], gd[1][1], 0.025])
    this.guide.geometry.setDrawRange(0, gd ? 2 : 0)
    ;(this.guide.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true
  }

  /** The handle within `tolMm` of a plane point, nearest first, or -1. */
  handleAt(at: V2, tolMm: number): number {
    const s = this.scene
    if (!s?.dragHandles) return -1
    let best = -1
    let bestD = tolMm
    s.handles.forEach((h, i) => {
      const d = Math.hypot(h[0] - at[0], h[1] - at[1])
      if (d <= bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }

  /** Construction lines take the theme's selection color. */
  setAccent(hex: string): void {
    this.mats.get('soft')?.color.set(hex)
  }

  dispose(): void {
    this.set(null)
    for (const o of [this.band, this.snap, this.guide]) o.geometry.dispose()
    for (const m of this.mats.values()) m.dispose()
    this.dotMat.dispose()
    this.markMat.dispose()
    this.snapMat.dispose()
    this.group.removeFromParent()
  }
}

/** A kept dimension as the view draws it: a line between two bed points and its value. */
export interface DimensionMark {
  id: string
  from: V3
  to: V3
  label: string
  /** Extra dots, such as a circle's center. */
  points?: readonly V3[]
}

/** Label height on screen, CSS pixels. */
const LABEL_PX = 20

/**
 * Kept dimensions: leader lines through the model and a value label that always faces the camera.
 * Labels are sprites with their text drawn once into a small texture, so orbiting moves no DOM and
 * runs no code per frame; only a change of field of view or view height rescales them.
 */
export class DimensionLayer {
  readonly group = new Group()
  private readonly line = new LineBasicMaterial({ color: new Color('#f1fa8c'), depthTest: false, transparent: true, opacity: 0.95, toneMapped: false })
  private readonly dot = new PointsMaterial({ color: new Color('#f1fa8c'), size: 6, sizeAttenuation: false, depthTest: false, toneMapped: false })
  private drawn: (LineSegments | Points)[] = []
  private labels: { sprite: Sprite; aspect: number }[] = []
  private scaledFor = ''

  constructor() {
    this.group.name = 'dimensions'
  }

  set(marks: readonly DimensionMark[]): boolean {
    const had = this.drawn.length > 0 || this.labels.length > 0
    for (const d of this.drawn) {
      d.removeFromParent()
      d.geometry.dispose()
    }
    for (const l of this.labels) {
      l.sprite.removeFromParent()
      l.sprite.material.map?.dispose()
      l.sprite.material.dispose()
    }
    this.drawn = []
    this.labels = []
    this.scaledFor = ''
    if (marks.length === 0) return had
    const pos: number[] = []
    const dots: number[] = []
    for (const m of marks) {
      pos.push(...m.from, ...m.to)
      dots.push(...m.from, ...m.to)
      for (const p of m.points ?? []) dots.push(...p)
    }
    const lg = new BufferGeometry()
    lg.setAttribute('position', new Float32BufferAttribute(pos, 3))
    const ls = new LineSegments(lg, this.line)
    ls.renderOrder = 14
    const dg = new BufferGeometry()
    dg.setAttribute('position', new Float32BufferAttribute(dots, 3))
    const ds = new Points(dg, this.dot)
    ds.renderOrder = 14
    for (const o of [ls, ds]) {
      o.raycast = () => {}
      this.group.add(o)
      this.drawn.push(o)
    }
    for (const m of marks) {
      const label = makeLabel(m.label)
      if (!label) continue
      label.sprite.position.set((m.from[0] + m.to[0]) / 2, (m.from[1] + m.to[1]) / 2, (m.from[2] + m.to[2]) / 2)
      this.group.add(label.sprite)
      this.labels.push(label)
    }
    return true
  }

  /** Keeps labels LABEL_PX tall on screen. Cheap to call every frame: it works only when the lens or the view height changed. */
  fit(fovDeg: number, heightPx: number): void {
    const key = `${fovDeg}:${heightPx}:${this.labels.length}`
    if (key === this.scaledFor || this.labels.length === 0) return
    this.scaledFor = key
    // A sprite without size attenuation covers scale / (2 tan(fov / 2)) of the view height.
    const h = (LABEL_PX / Math.max(1, heightPx)) * 2 * Math.tan((fovDeg * Math.PI) / 360)
    for (const l of this.labels) l.sprite.scale.set(h * l.aspect, h, 1)
  }

  dispose(): void {
    this.set([])
    this.line.dispose()
    this.dot.dispose()
    this.group.removeFromParent()
  }
}

function makeLabel(text: string): { sprite: Sprite; aspect: number } | null {
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')
  if (!ctx) return null
  const px = 40
  const font = `600 ${px * 0.62}px ui-monospace, SFMono-Regular, Menlo, monospace`
  ctx.font = font
  const w = Math.ceil(ctx.measureText(text).width + px * 0.6)
  c.width = w
  c.height = px
  ctx.font = font
  ctx.fillStyle = 'rgba(30, 31, 41, 0.9)'
  ctx.beginPath()
  ctx.roundRect?.(0, 0, w, px, px * 0.22)
  ctx.fill()
  ctx.fillStyle = '#f1fa8c'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, px * 0.3, px / 2 + 1)
  const tex = new CanvasTexture(c)
  const sprite = new Sprite(new SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false, transparent: true, toneMapped: false }))
  sprite.renderOrder = 15
  sprite.raycast = () => {}
  return { sprite, aspect: w / px }
}
