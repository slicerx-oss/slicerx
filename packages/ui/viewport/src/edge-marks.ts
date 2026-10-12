// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Picks in Model, drawn in the pick color: a picked edge as a bar with a dot at each end, the outline of a picked
// face as a thinner line, and the edge under the pointer as a dashed line whose dashes march along it (still dashes
// under reduced motion). Every line keeps about the same width on screen: the viewport sizes it from the camera
// distance and redraws it when the camera moves far enough to change it.
// All of them are an overlay the pipeline draws after the frame is composed, above the selection outline, so they stay
// readable on it. The hover is tested against the scene's depth there, so only an edge the camera can see lights up;
// the picks show through, so a pick on the far side is not lost.
import { Color, CylinderGeometry, Group, Mesh, MeshBasicMaterial, Quaternion, SphereGeometry, Vector2, Vector3, type PerspectiveCamera, type Texture } from 'three'
import { SCENE } from './palette'

export type MarkLine = { from: [number, number, number]; to: [number, number, number] }

/** Half widths on screen, in pixels: a picked edge, a picked face's outline, the hover dashes; and the end dots' radius. */
const PICKED_PX = 1.2
const OUTLINE_PX = 1.1
const HOVER_PX = 1
const DOT_PX = 3.2
/** The hover's dash and gap along the edge, in pixels, and how fast the dashes march, pixels a second. */
const DASH_PX = 5
const GAP_PX = 3
const MARCH_PX_S = 16
/** Redraws a second while the dashes march. */
const MARCH_HZ = 30
const UNIT = new CylinderGeometry(1, 1, 1, 8, 1, false)
const DOT = new SphereGeometry(1, 12, 8)
const UP = new Vector3(0, 1, 0)

type Px = (p: [number, number, number]) => number

export class EdgeMarks {
  /** Child of the objects root (bed frame, Z up, mm). */
  readonly group = new Group()
  /** Every mark: hidden in the scene pass, drawn over the composed frame. */
  readonly overlay = new Group()
  /** The scene's depth for the hover's test: its texture, the drawing buffer's size, the camera's near and far. */
  readonly depth = { sxDepth: { value: null as Texture | null }, sxSize: { value: new Vector2(1, 1) }, sxNear: { value: 0.1 }, sxFar: { value: 1000 }, sxOn: { value: 0 } }
  private readonly picked = new MeshBasicMaterial({ color: new Color(SCENE.liveLayer), depthTest: false, transparent: true, opacity: 0.98, toneMapped: false })
  private readonly outline = new MeshBasicMaterial({ color: new Color(SCENE.liveLayer), depthTest: false, transparent: true, opacity: 0.9, toneMapped: false })
  private readonly hover = depthTested(new MeshBasicMaterial({ color: new Color(SCENE.liveLayer), depthTest: false, transparent: true, opacity: 0.85, toneMapped: false }), this.depth)
  private lines: { picked: readonly MarkLine[]; hover: readonly MarkLine[]; outline: readonly MarkLine[] } = { picked: [], hover: [], outline: [] }
  private scale = 0
  /** The marching dashes' shift, pixels, and when it last moved. */
  private shift = 0
  private marchedAt = 0

  constructor() {
    this.group.name = 'edge-marks'
    this.group.renderOrder = 6
    this.overlay.name = 'edge-marks-overlay'
    this.group.add(this.overlay)
  }

  /** The picked and hovered edges to draw, keeping the face outlines. True when anything was or is now drawn. */
  set(picked: readonly MarkLine[], hover: readonly MarkLine[], mmPerPx: Px): boolean {
    return this.redraw({ ...this.lines, picked, hover }, mmPerPx)
  }

  /** The picked faces' outlines, keeping the edges. True when anything was or is now drawn. */
  setOutline(outline: readonly MarkLine[], mmPerPx: Px): boolean {
    return this.redraw({ ...this.lines, outline }, mmPerPx)
  }

  /** Redraws when the camera has moved enough that the lines would look thicker or thinner. True when it did. */
  refresh(mmPerPx: Px): boolean {
    const first = this.first()
    if (!first) return false
    const s = mmPerPx(first.from)
    if (this.scale > 0 && Math.abs(s - this.scale) / this.scale < 0.15) return false
    this.draw(mmPerPx)
    return true
  }

  /** Moves the hover's dashes along at `now` (ms). True while they march, so the view draws another frame. */
  march(now: number, moving: boolean, mmPerPx: Px): boolean {
    if (!moving || !this.lines.hover.length) {
      this.marchedAt = 0
      return false
    }
    if (this.marchedAt && now - this.marchedAt < 1000 / MARCH_HZ) return true
    const dt = this.marchedAt ? Math.min(0.1, (now - this.marchedAt) / 1000) : 0
    this.marchedAt = now
    this.shift = (this.shift + dt * MARCH_PX_S) % (DASH_PX + GAP_PX)
    this.draw(mmPerPx)
    return true
  }

  private redraw(lines: EdgeMarks['lines'], mmPerPx: Px): boolean {
    const had = this.count() > 0
    this.lines = lines
    this.draw(mmPerPx)
    return had || this.count() > 0
  }

  /** The scene's depth as the last frame drew it, for the hover's test; null turns the test off. */
  setSceneDepth(depth: Texture | null, size: Vector2, camera: PerspectiveCamera): void {
    const d = this.depth
    d.sxDepth.value = depth
    d.sxOn.value = depth ? 1 : 0
    d.sxSize.value.copy(size)
    d.sxNear.value = camera.near
    d.sxFar.value = camera.far
  }

  private count(): number {
    return this.overlay.children.length
  }

  private first(): MarkLine | undefined {
    return this.lines.picked[0] ?? this.lines.outline[0] ?? this.lines.hover[0]
  }

  private draw(mmPerPx: Px): void {
    this.clear()
    const first = this.first()
    this.scale = first ? mmPerPx(first.from) : 0
    const mid = (l: MarkLine): [number, number, number] => [(l.from[0] + l.to[0]) / 2, (l.from[1] + l.to[1]) / 2, (l.from[2] + l.to[2]) / 2]
    const add = (mesh: Mesh) => {
      mesh.renderOrder = 6
      mesh.raycast = () => {}
      this.overlay.add(mesh)
    }
    const bar = (a: Vector3, b: Vector3, r: number, m: MeshBasicMaterial) => {
      const len = a.distanceTo(b)
      if (len < 1e-6) return
      const mesh = new Mesh(UNIT, m)
      mesh.scale.set(r, len, r)
      mesh.position.copy(a.clone().add(b).multiplyScalar(0.5))
      mesh.quaternion.copy(new Quaternion().setFromUnitVectors(UP, b.clone().sub(a).normalize()))
      add(mesh)
    }
    for (const l of this.lines.hover) {
      const a = new Vector3(...l.from)
      const b = new Vector3(...l.to)
      const len = a.distanceTo(b)
      if (len < 1e-6) continue
      const px = mmPerPx(mid(l))
      const dir = b.clone().sub(a).divideScalar(len)
      const period = (DASH_PX + GAP_PX) * px
      for (let s = this.shift * px - period; s < len; s += period) {
        const s0 = Math.max(0, s)
        const s1 = Math.min(len, s + DASH_PX * px)
        if (s1 > s0) bar(a.clone().addScaledVector(dir, s0), a.clone().addScaledVector(dir, s1), HOVER_PX * px, this.hover)
      }
    }
    for (const l of this.lines.outline) bar(new Vector3(...l.from), new Vector3(...l.to), OUTLINE_PX * mmPerPx(mid(l)), this.outline)
    // a face outline hides the selection outline along it, so its edges read in the pick color and not the accent
    for (const c of this.overlay.children) if ((c as Mesh).material === this.outline) c.userData.cutsOutline = true
    for (const l of this.lines.picked) bar(new Vector3(...l.from), new Vector3(...l.to), PICKED_PX * mmPerPx(mid(l)), this.picked)
    // A dot at each end of a picked edge; a chain of lines gets them at its two loose ends only.
    const key = (p: readonly number[]) => p.map((v) => v.toFixed(4)).join(',')
    const ends = new Map<string, { p: [number, number, number]; n: number }>()
    for (const l of this.lines.picked)
      for (const p of [l.from, l.to]) {
        const e = ends.get(key(p))
        if (e) e.n++
        else ends.set(key(p), { p, n: 1 })
      }
    for (const e of ends.values()) {
      if (e.n !== 1) continue
      const mesh = new Mesh(DOT, this.picked)
      mesh.scale.setScalar(DOT_PX * mmPerPx(e.p))
      mesh.position.set(...e.p)
      add(mesh)
    }
  }

  setColor(color: string): void {
    this.picked.color.set(color)
    this.outline.color.set(color)
    this.hover.color.set(color)
  }

  private clear(): void {
    for (const c of [...this.overlay.children]) this.overlay.remove(c)
  }

  dispose(): void {
    this.clear()
    this.picked.dispose()
    this.outline.dispose()
    this.hover.dispose()
  }
}

/**
 * A material that draws only where it is not behind the scene: each fragment's distance from the camera against the
 * scene's depth there, with a margin that grows with the distance, so a mark lying on a face still passes.
 */
function depthTested(m: MeshBasicMaterial, u: EdgeMarks['depth']): MeshBasicMaterial {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u)
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `uniform sampler2D sxDepth;
uniform vec2 sxSize;
uniform float sxNear;
uniform float sxFar;
uniform float sxOn;
float sxDist(float d) { return (sxNear * sxFar) / (sxFar - d * (sxFar - sxNear)); }
void main() {
  if (sxOn > 0.5) {
    float scene = sxDist(texture2D(sxDepth, gl_FragCoord.xy / sxSize).x);
    if (sxDist(gl_FragCoord.z) > scene + max(0.2, 0.015 * scene)) discard;
  }`,
      )
  }
  m.customProgramCacheKey = () => 'sx-depth-tested'
  m.userData.depthTested = true
  return m
}

/** The outline of a face patch: the edges of its triangles that no other triangle of the patch shares. */
export function patchOutline(positions: ArrayLike<number>, indices: ArrayLike<number>, triangles: readonly number[]): MarkLine[] {
  const at = (i: number): [number, number, number] => [positions[3 * i] ?? 0, positions[3 * i + 1] ?? 0, positions[3 * i + 2] ?? 0]
  const vkey = (i: number) => at(i).map((v) => v.toFixed(5)).join(',')
  const count = new Map<string, { a: number; b: number; n: number }>()
  for (const t of triangles) {
    for (let k = 0; k < 3; k++) {
      const a = indices[3 * t + k] ?? 0
      const b = indices[3 * t + ((k + 1) % 3)] ?? 0
      const ka = vkey(a)
      const kb = vkey(b)
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
      const e = count.get(key)
      if (e) e.n++
      else count.set(key, { a, b, n: 1 })
    }
  }
  return [...count.values()].filter((e) => e.n === 1).map((e) => ({ from: at(e.a), to: at(e.b) }))
}
