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
  CustomBlending,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MaxEquation,
  Mesh,
  MeshBasicMaterial,
  OneMinusSrcAlphaFactor,
  Points,
  PointsMaterial,
  ShapeUtils,
  SrcAlphaFactor,
  Vector2,
  Sprite,
  SpriteMaterial,
} from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
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

/** normal is free geometry; defined is fully defined by its constraints, fixed is held by Fix. */
export type SketchTone = 'normal' | 'defined' | 'fixed' | 'selected' | 'issue' | 'soft' | 'axis' | 'grid' | 'construction'

/** What the sketch layer shows, all in plane coordinates (mm). */
export interface SketchScene {
  frame: CadFrame
  /** Polylines: drawn segments, the picked face's outline (soft), problems (issue), a revolve axis. */
  paths: readonly { points: readonly V2[]; closed?: boolean; tone?: SketchTone }[]
  /** Points a press can grab when `dragHandles` is on; drawn as dots. */
  handles: readonly V2[]
  dragHandles?: boolean
  /**
   * The plane being sketched on, from `min` to `max`: a translucent fill and a border in the accent tint, drawn under
   * the grid so it reads apart from the world grid.
   */
  plane?: { min: V2; max: V2 }
  /** A faint grid, every `stepMm`, over the rectangle `min` to `max`. */
  grid?: { stepMm: number; min: V2; max: V2 }
  /** Problem spots, drawn as red dots. */
  marks?: readonly V2[]
  /**
   * Dimensions: a line from `from` to `to` with the value at its middle, extension lines out to it, and the picked
   * one drawn bright. A press on a value comes back as the event's `mark`.
   */
  dims?: readonly { from: V2; to: V2; at?: V2; ext?: readonly (readonly [V2, V2])[]; label: string; picked?: boolean }[]
  /** Points held by Fix, drawn as squares. */
  fixed?: readonly V2[]
  /** Closed loops, shaded faintly so a closed profile reads at a glance. */
  profiles?: readonly (readonly V2[])[]
  /** Constraint marks beside the geometry; `slot` sets marks at one spot side by side. */
  glyphs?: readonly { at: V2; kind: SketchGlyphKind; slot: number; picked?: boolean }[]
  /** In a drawing tool, a point a press can drag from (the open end of the line being drawn); the drag goes out as handle -1. */
  dragFrom?: V2
}

/** A dimension's value or a constraint glyph on screen, by its index in the scene's dims or glyphs. */
export type SketchMark = { dim: number } | { glyph: number }

export type SketchGlyphKind = 'coincident' | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'tangent' | 'equal' | 'midpoint' | 'concentric' | 'collinear' | 'symmetric'

/** A dimension as the sketch layer draws it. */
export type SketchDimMark = NonNullable<SketchScene['dims']>[number]

/** The line being drawn (a polyline from the last point to the cursor), the snapped cursor, an alignment guide, and a dimension being placed. */
export interface SketchCursor {
  path?: readonly V2[] | null
  /** The path is what a trim takes off: red and wider than a curve, so it reads apart from one with a problem. */
  cut?: boolean
  at?: V2 | null
  guide?: readonly [V2, V2] | null
  dim?: SketchDimMark | null
}

const TONE: Record<SketchTone, { color: string; opacity: number }> = {
  normal: { color: '#8be9fd', opacity: 1 },
  defined: { color: '#f8f8f2', opacity: 1 },
  fixed: { color: '#50fa7b', opacity: 1 },
  selected: { color: '#f1fa8c', opacity: 1 },
  issue: { color: '#ff5555', opacity: 1 },
  soft: { color: '#bd93f9', opacity: 0.55 },
  axis: { color: '#ffb86c', opacity: 1 },
  grid: { color: '#6272a4', opacity: 0.32 },
  // dashed orange (see below), as the plan's colors have it
  construction: { color: '#ffb86c', opacity: 0.9 },
}

// the same tones on a light studio, dark enough to read on it; projected and grid lines keep theirs
const LIGHT_TONE: Partial<Record<SketchTone, string>> = {
  normal: '#1f6fd1',
  defined: '#282a36',
  fixed: '#1e9e4a',
  selected: '#b8860b',
  issue: '#d32f2f',
  axis: '#d9731c',
  construction: '#e07b12',
}

/** Room for the line being drawn: an arc preview needs the most points. */
const CURSOR_POINTS = 256

/**
 * The sketch on its plane. A group placed by the frame's matrix holds flat geometry, lifted a hair off
 * the plane and drawn through the model so it reads from any angle. `set` rebuilds the drawn sketch
 * (on a click or a point drag); `cursor` rewrites the rubber band in place.
 */
// the post pass outlines what has full alpha as a solid, so sketch marks keep alpha just under it, and where marks
// overlap the larger alpha wins instead of adding up
const MARK_ALPHA = 0.98
const KEEP_ALPHA = { blending: CustomBlending, blendSrc: SrcAlphaFactor, blendDst: OneMinusSrcAlphaFactor, blendEquationAlpha: MaxEquation, opacity: MARK_ALPHA } as const
// sketch curves draw this many px wide, so a curve reads on any screen
const CURVE_PX = 2
// the drawing buffer size every sketch layer's wide lines share
const curveRes = new Vector2(1024, 768)

/** The drawing buffer size, for the sketch curves' pixel widths. */
export function setSketchResolution(width: number, height: number): void {
  curveRes.set(width, height)
}

// the sketch plane's wash and border, as alpha over the scene; a light studio washes the tint out, so it gets more
export const PLANE_FILL = 0.045
export const PLANE_EDGE = 0.6
export const PLANE_FILL_LIGHT = 0.12
export const PLANE_EDGE_LIGHT = 0.95

// tones drawn thin: the faint grid and projected edges
const THIN: ReadonlySet<SketchTone> = new Set(['grid', 'soft'])

export class SketchLayer {
  readonly group = new Group()
  private readonly mats = new Map<SketchTone, LineBasicMaterial | LineMaterial>()
  private readonly guideMat = new LineBasicMaterial({ color: new Color(TONE.axis.color), transparent: true, depthTest: false, toneMapped: false, ...KEEP_ALPHA })
  private readonly dotMat = new PointsMaterial({ color: new Color('#f8f8f2'), size: 7, sizeAttenuation: false, depthTest: false, transparent: true, toneMapped: false, ...KEEP_ALPHA })
  private readonly markMat = new PointsMaterial({ color: new Color('#ff5555'), size: 10, sizeAttenuation: false, depthTest: false, transparent: true, toneMapped: false, ...KEEP_ALPHA })
  private readonly snapMat = new PointsMaterial({ color: new Color('#f1fa8c'), size: 11, sizeAttenuation: false, depthTest: false, transparent: true, toneMapped: false, ...KEEP_ALPHA })
  private readonly fixMat = new PointsMaterial({ color: new Color(TONE.fixed.color), size: 9, sizeAttenuation: false, depthTest: false, transparent: true, toneMapped: false, ...KEEP_ALPHA })
  private readonly fillMat = new MeshBasicMaterial({ color: new Color('#8be9fd'), transparent: true, depthTest: false, depthWrite: false, side: DoubleSide, toneMapped: false, ...KEEP_ALPHA, opacity: 0.12 })
  private readonly dimMat = new LineBasicMaterial({ color: new Color('#f1fa8c'), transparent: true, depthTest: false, toneMapped: false, ...KEEP_ALPHA, opacity: 0.8 })
  private readonly dimPickMat = new LineBasicMaterial({ color: new Color(TONE.selected.color), transparent: true, depthTest: false, toneMapped: false, ...KEEP_ALPHA })
  // the sketch plane: an accent wash and a firmer accent border
  private readonly planeFillMat = new MeshBasicMaterial({ color: new Color(TONE.soft.color), transparent: true, depthTest: false, depthWrite: false, side: DoubleSide, toneMapped: false, ...KEEP_ALPHA, opacity: PLANE_FILL })
  private readonly planeEdgeMat = new LineBasicMaterial({ color: new Color(TONE.soft.color), transparent: true, depthTest: false, depthWrite: false, toneMapped: false, ...KEEP_ALPHA, opacity: PLANE_EDGE })
  private drawn: (LineSegments | Points | Sprite | Mesh)[] = []
  private labels: { sprite: Sprite; aspect: number; size?: number; mark?: SketchMark; at?: V2 }[] = []
  /** The dimension following the cursor: its lines, and its value, made again only when the text changes. */
  private cursorDim: LineSegments | null = null
  private cursorLabel: { sprite: Sprite; aspect: number; text: string } | null = null
  private scaledFor = ''
  private readonly band: Line2
  // what a trim takes off: the problem red, drawn wide
  private readonly cutMat = new LineMaterial({ color: new Color(TONE.issue.color), linewidth: CURVE_PX * 2.5, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, ...KEEP_ALPHA })
  /** A closed shape being drawn, shaded like a profile so the whole outline reads at the cursor. */
  private bandFill: Mesh | null = null
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
      const o = { color: new Color(t.color), transparent: true, depthTest: false, depthWrite: false, toneMapped: false, ...KEEP_ALPHA, opacity: Math.min(t.opacity, MARK_ALPHA) }
      if (THIN.has(tone)) {
        this.mats.set(tone, new LineBasicMaterial(o))
        continue
      }
      // construction lines dash in mm on the plane, as Fusion draws them
      const m = new LineMaterial({ ...o, linewidth: CURVE_PX, ...(tone === 'construction' ? { dashed: true, dashSize: 1.2, gapSize: 0.8 } : {}) })
      m.uniforms['resolution']!.value = curveRes
      this.mats.set(tone, m)
    }
    // the shape being drawn takes the sketch's own curve color and width, so it reads as what the click will make
    this.cutMat.uniforms['resolution']!.value = curveRes
    this.band = new Line2(new LineGeometry(), this.mats.get('normal') as LineMaterial)
    this.band.visible = false
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
    this.guide = new Line(guideGeo, this.guideMat)
    this.guide.frustumCulled = false
    this.guide.renderOrder = 11
    for (const o of [this.band, this.snap, this.guide]) o.raycast = () => {}
    this.group.add(this.band, this.snap, this.guide)
  }

  set(scene: SketchScene | null): void {
    for (const d of this.drawn) {
      d.removeFromParent()
      if (d instanceof Sprite) {
        d.material.map?.dispose()
        d.material.dispose()
      } else d.geometry.dispose()
    }
    this.drawn = []
    this.labels = []
    this.scaledFor = ''
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
    const pl = scene.plane
    if (pl && pl.max[0] > pl.min[0] && pl.max[1] > pl.min[1]) {
      const [x0, y0] = pl.min
      const [x1, y1] = pl.max
      const z = lift / 4
      const fillGeo = new BufferGeometry()
      fillGeo.setAttribute('position', new Float32BufferAttribute([x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z], 3))
      const fill = new Mesh(fillGeo, this.planeFillMat)
      fill.renderOrder = 4
      const edgeGeo = new BufferGeometry()
      edgeGeo.setAttribute('position', new Float32BufferAttribute([x0, y0, z, x1, y0, z, x1, y0, z, x1, y1, z, x1, y1, z, x0, y1, z, x0, y1, z, x0, y0, z], 3))
      const edge = new LineSegments(edgeGeo, this.planeEdgeMat)
      edge.renderOrder = 4.5
      for (const o of [fill, edge]) {
        o.name = 'sketch-plane'
        o.raycast = () => {}
        this.group.add(o)
        this.drawn.push(o)
      }
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
    const order: SketchTone[] = ['grid', 'soft', 'construction', 'normal', 'defined', 'fixed', 'axis', 'selected', 'issue']
    order.forEach((tone, k) => {
      const pos = byTone.get(tone)
      if (!pos?.length) return
      const mat = this.mats.get(tone)!
      let seg: LineSegments | LineSegments2
      if (mat instanceof LineMaterial) {
        seg = new LineSegments2(new LineSegmentsGeometry().setPositions(pos), mat)
        if (tone === 'construction') seg.computeLineDistances()
      } else {
        const geo = new BufferGeometry()
        geo.setAttribute('position', new Float32BufferAttribute(pos, 3))
        seg = new LineSegments(geo, mat)
      }
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
    if (scene.profiles?.length) {
      const pos: number[] = []
      for (const ring of scene.profiles) {
        if (ring.length < 3) continue
        const pts = ring.map((p) => new Vector2(p[0], p[1]))
        for (const tri of ShapeUtils.triangulateShape(pts, [])) for (const k of tri) pos.push(ring[k]![0], ring[k]![1], lift / 2)
      }
      if (pos.length) {
        const geo = new BufferGeometry()
        geo.setAttribute('position', new Float32BufferAttribute(pos, 3))
        const fill = new Mesh(geo, this.fillMat)
        fill.renderOrder = 5
        fill.raycast = () => {}
        this.group.add(fill)
        this.drawn.push(fill)
      }
    }
    dots(scene.handles, this.dotMat, 8)
    dots(scene.marks, this.markMat, 9)
    dots(scene.fixed, this.fixMat, 9)
    if (scene.dims?.length) {
      const geo = new BufferGeometry()
      const lines = (m: NonNullable<SketchScene['dims']>[number]) => [
        m.from[0], m.from[1], lift, m.to[0], m.to[1], lift,
        ...(m.at ? [m.to[0], m.to[1], lift, m.at[0], m.at[1], lift] : []),
        ...(m.ext ?? []).flatMap(([a, b]) => [a[0], a[1], lift, b[0], b[1], lift]),
      ]
      for (const picked of [false, true]) {
        const pos = scene.dims.filter((m) => !!m.picked === picked).flatMap(lines)
        if (!pos.length) continue
        const geo = new BufferGeometry()
        geo.setAttribute('position', new Float32BufferAttribute(pos, 3))
        const seg = new LineSegments(geo, picked ? this.dimPickMat : this.dimMat)
        seg.renderOrder = 9
        seg.raycast = () => {}
        this.group.add(seg)
        this.drawn.push(seg)
      }
      scene.dims.forEach((m, i) => {
        const label = makeLabel(m.label, m.picked)
        if (!label) return
        const at: V2 = m.at ?? [(m.from[0] + m.to[0]) / 2, (m.from[1] + m.to[1]) / 2]
        label.sprite.position.set(at[0], at[1], lift)
        this.group.add(label.sprite)
        this.drawn.push(label.sprite)
        this.labels.push({ ...label, mark: { dim: i }, at })
      })
    }
    for (const [i, g] of (scene.glyphs ?? []).entries()) {
      const sprite = makeGlyph(g.kind, g.picked)
      if (!sprite) continue
      // up and to the right of the spot, side by side when several share it
      sprite.center.set(-0.25 - g.slot * 1.15, -0.25)
      sprite.position.set(g.at[0], g.at[1], lift)
      this.group.add(sprite)
      this.drawn.push(sprite)
      this.labels.push({ sprite, aspect: 1, size: 0.8, mark: { glyph: i }, at: g.at })
    }
  }

  /** The value or glyph under a screen point, topmost first; `toScreen` takes a plane point to client pixels. */
  markAt(toScreen: (at: V2) => [number, number], px: [number, number]): SketchMark | null {
    for (let k = this.labels.length - 1; k >= 0; k--) {
      const l = this.labels[k]!
      if (!l.mark || !l.at) continue
      const p = toScreen(l.at)
      const h = LABEL_PX * (l.size ?? 1)
      const w = h * l.aspect
      // the sprite's center shifts it on screen from its anchor
      const cx = p[0] + (0.5 - l.sprite.center.x) * w
      const cy = p[1] - (0.5 - l.sprite.center.y) * h
      if (Math.abs(px[0] - cx) <= w / 2 && Math.abs(px[1] - cy) <= h / 2) return l.mark
    }
    return null
  }

  /** Keeps dimension values LABEL_PX tall on screen, as the dimension layer does. */
  fit(fovDeg: number, heightPx: number): void {
    const key = `${fovDeg}:${heightPx}:${this.labels.length}:${this.cursorLabel?.text ?? ''}`
    if (key === this.scaledFor || (this.labels.length === 0 && !this.cursorLabel)) return
    this.scaledFor = key
    const h = (LABEL_PX / Math.max(1, heightPx)) * 2 * Math.tan((fovDeg * Math.PI) / 360)
    for (const l of [...this.labels, ...(this.cursorLabel ? [this.cursorLabel] : [])]) l.sprite.scale.set(h * l.aspect * ('size' in l ? (l.size ?? 1) : 1), h * ('size' in l ? (l.size ?? 1) : 1), 1)
  }

  // the dimension being placed, drawn as a picked one
  private placing(m: SketchDimMark | null): void {
    this.cursorDim?.geometry.dispose()
    this.cursorDim?.removeFromParent()
    this.cursorDim = null
    if (!m) {
      this.dropCursorLabel()
      return
    }
    const z = 0.03
    const pos = [m.from[0], m.from[1], z, m.to[0], m.to[1], z, ...(m.at ? [m.to[0], m.to[1], z, m.at[0], m.at[1], z] : []), ...(m.ext ?? []).flatMap(([a, b]) => [a[0], a[1], z, b[0], b[1], z])]
    const geo = new BufferGeometry()
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3))
    this.cursorDim = new LineSegments(geo, this.dimPickMat)
    this.cursorDim.renderOrder = 12
    this.cursorDim.frustumCulled = false
    this.cursorDim.raycast = () => {}
    this.group.add(this.cursorDim)
    if (this.cursorLabel?.text !== m.label) {
      this.dropCursorLabel()
      const l = makeLabel(m.label, true)
      if (l) {
        this.cursorLabel = { ...l, text: m.label }
        this.group.add(l.sprite)
        this.scaledFor = ''
      }
    }
    const at = m.at ?? [(m.from[0] + m.to[0]) / 2, (m.from[1] + m.to[1]) / 2]
    this.cursorLabel?.sprite.position.set(at[0], at[1], z)
  }

  private dropCursorLabel(): void {
    const l = this.cursorLabel
    if (!l) return
    l.sprite.removeFromParent()
    l.sprite.material.map?.dispose()
    l.sprite.material.dispose()
    this.cursorLabel = null
  }

  /** The rubber band and snap marker; the marker rewrites a fixed buffer. */
  cursor(c: SketchCursor | null): void {
    const path = c?.path ?? null
    const n = path ? Math.min(CURSOR_POINTS, path.length) : 0
    this.band.visible = n >= 2
    this.band.material = c?.cut ? this.cutMat : (this.mats.get('normal') as LineMaterial)
    if (n >= 2) {
      const pos = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        const p = path![i]!
        pos[3 * i] = p[0]
        pos[3 * i + 1] = p[1]
        pos[3 * i + 2] = 0.03
      }
      // a fresh geometry each move: the wide line's buffers are sized to their points
      this.band.geometry.dispose()
      this.band.geometry = new LineGeometry().setPositions(pos)
    }
    this.bandFill?.geometry.dispose()
    this.bandFill?.removeFromParent()
    this.bandFill = null
    const first = path?.[0]
    const last = path?.[n - 1]
    if (path && !c?.cut && n > 3 && first && last && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6) {
      const ring = path.slice(0, n - 1)
      const pos: number[] = []
      for (const tri of ShapeUtils.triangulateShape(ring.map((p) => new Vector2(p[0], p[1])), [])) for (const k of tri) pos.push(ring[k]![0], ring[k]![1], 0.02)
      if (pos.length) {
        const geo = new BufferGeometry()
        geo.setAttribute('position', new Float32BufferAttribute(pos, 3))
        this.bandFill = new Mesh(geo, this.fillMat)
        this.bandFill.renderOrder = 11
        this.bandFill.frustumCulled = false
        this.bandFill.raycast = () => {}
        this.group.add(this.bandFill)
      }
    }
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
    this.placing(c?.dim ?? null)
  }

  /** Whether a press at a plane point is on the drawing tool's drag point. */
  dragFromAt(at: V2, tolMm: number): boolean {
    const p = this.scene?.dragFrom
    return !!p && Math.hypot(p[0] - at[0], p[1] - at[1]) <= tolMm
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

  /** Projected (soft) lines take the theme's selection color. */
  setAccent(hex: string): void {
    this.mats.get('soft')?.color.set(hex)
    this.planeFillMat.color.set(hex)
    this.planeEdgeMat.color.set(hex)
  }

  /** Darker curves, points and snap marker on a light studio, so they read on it. */
  setLight(light: boolean): void {
    for (const [tone, t] of Object.entries(TONE) as [SketchTone, { color: string }][]) {
      if (tone === 'soft') continue
      this.mats.get(tone)?.color.set(light ? (LIGHT_TONE[tone] ?? t.color) : t.color)
    }
    this.guideMat.color.set(light ? LIGHT_TONE.axis! : TONE.axis.color)
    this.dotMat.color.set(light ? '#282a36' : '#f8f8f2')
    this.snapMat.color.set(light ? LIGHT_TONE.selected! : '#f1fa8c')
    this.fixMat.color.set(light ? LIGHT_TONE.fixed! : TONE.fixed.color)
    this.dimMat.color.set(light ? '#5c5f73' : '#f1fa8c')
    this.dimPickMat.color.set(light ? LIGHT_TONE.selected! : TONE.selected.color)
    this.cutMat.color.set(light ? LIGHT_TONE.issue! : TONE.issue.color)
    this.planeFillMat.opacity = light ? PLANE_FILL_LIGHT : PLANE_FILL
    this.planeEdgeMat.opacity = light ? PLANE_EDGE_LIGHT : PLANE_EDGE
  }

  dispose(): void {
    this.set(null)
    for (const o of [this.band, this.snap, this.guide]) o.geometry.dispose()
    for (const m of this.mats.values()) m.dispose()
    this.cutMat.dispose()
    this.guideMat.dispose()
    this.dotMat.dispose()
    this.fillMat.dispose()
    this.markMat.dispose()
    this.snapMat.dispose()
    this.fixMat.dispose()
    this.dimMat.dispose()
    this.dimPickMat.dispose()
    this.planeFillMat.dispose()
    this.planeEdgeMat.dispose()
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

// each glyph drawn on a 40 px tile, as the plan's table has them
const GLYPHS: Record<SketchGlyphKind, (c: CanvasRenderingContext2D) => void> = {
  coincident: (c) => disc(c, 20, 20, 6),
  horizontal: (c) => lines(c, [[10, 20, 30, 20]]),
  vertical: (c) => lines(c, [[20, 10, 20, 30]]),
  parallel: (c) => lines(c, [[11, 29, 19, 11], [21, 29, 29, 11]]),
  perpendicular: (c) => lines(c, [[10, 29, 30, 29], [20, 29, 20, 10]]),
  tangent: (c) => {
    lines(c, [[8, 31, 32, 31]])
    ring(c, 20, 21, 9)
  },
  equal: (c) => lines(c, [[11, 16, 29, 16], [11, 25, 29, 25]]),
  midpoint: (c) => {
    lines(c, [[8, 29, 32, 29]])
    c.beginPath()
    c.moveTo(20, 11)
    c.lineTo(28, 25)
    c.lineTo(12, 25)
    c.closePath()
    c.fill()
  },
  concentric: (c) => {
    ring(c, 20, 20, 5)
    ring(c, 20, 20, 11)
  },
  collinear: (c) => {
    c.setLineDash([5, 4])
    lines(c, [[7, 20, 33, 20]])
    c.setLineDash([])
  },
  symmetric: (c) => {
    lines(c, [[13, 10, 13, 30], [27, 10, 27, 30]])
    c.setLineDash([3, 3])
    lines(c, [[20, 8, 20, 32]])
    c.setLineDash([])
  },
}

function lines(c: CanvasRenderingContext2D, ls: readonly (readonly [number, number, number, number])[]): void {
  c.beginPath()
  for (const [a, b, x, y] of ls) {
    c.moveTo(a, b)
    c.lineTo(x, y)
  }
  c.stroke()
}

function ring(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  c.stroke()
}

function disc(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  c.fill()
}

function makeGlyph(kind: SketchGlyphKind, picked = false): Sprite | null {
  if (typeof document === 'undefined') return null
  const cv = document.createElement('canvas')
  cv.width = cv.height = 40
  const c = cv.getContext('2d')
  if (!c) return null
  c.fillStyle = picked ? '#f1fa8c' : 'rgba(30, 31, 41, 0.9)'
  c.beginPath()
  c.roundRect?.(0, 0, 40, 40, 8)
  c.fill()
  c.strokeStyle = c.fillStyle = picked ? '#1e1f29' : '#f8f8f2'
  c.lineWidth = 3
  c.lineCap = 'round'
  GLYPHS[kind](c)
  const sprite = new Sprite(new SpriteMaterial({ map: new CanvasTexture(cv), depthTest: false, sizeAttenuation: false, transparent: true, toneMapped: false, ...KEEP_ALPHA }))
  sprite.renderOrder = 15
  sprite.raycast = () => {}
  sprite.userData['glyph'] = kind
  return sprite
}

function makeLabel(text: string, picked = false): { sprite: Sprite; aspect: number } | null {
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
  ctx.fillStyle = picked ? '#f1fa8c' : 'rgba(30, 31, 41, 0.9)'
  ctx.beginPath()
  ctx.roundRect?.(0, 0, w, px, px * 0.22)
  ctx.fill()
  ctx.fillStyle = picked ? '#1e1f29' : '#f1fa8c'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, px * 0.3, px / 2 + 1)
  const tex = new CanvasTexture(c)
  const sprite = new Sprite(new SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false, transparent: true, toneMapped: false, ...KEEP_ALPHA }))
  sprite.renderOrder = 15
  sprite.raycast = () => {}
  return { sprite, aspect: w / px }
}
