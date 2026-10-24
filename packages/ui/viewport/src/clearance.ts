// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Print by object: each object's clearance zone on the bed (its footprint grown by half the clearance radius, so two
// zones that overlap are two objects closer than the radius) as a soft fill with a hairline edge, red where zones
// overlap, and the gantry's lane over the objects taller than its rod as a dashed band, red where a later object's lane
// meets it. A selected object's zone has a ring in the selection color outside its edge. The app measures them on the plate as it sits (@slicerx/settings/by-object); while an object moves its zone
// rides with it and the overlap is checked again every frame, so the red follows a drag before the drop.
import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Group, LineBasicMaterial, LineLoop, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3 } from 'three'

type Pt = readonly [number, number]

export interface ClearanceZone {
  id: string
  /** The object's transform when measured. */
  transform: readonly number[]
  /** The clearance zone in bed coordinates at that transform, convex. */
  zone: readonly Pt[]
  /** The footprint (convex hull) at that transform. */
  hull: readonly Pt[]
  /** The object's top, mm. */
  topMm: number
}

export interface ClearanceSpec {
  /** In print order. */
  zones: readonly ClearanceZone[]
  /** The gantry: the rod's height over the bed and how far it reaches either side of the nozzle in y, and the bed width. */
  gantry: { rodMm: number; reachMm: number; widthMm: number }
  selected: readonly string[]
  /** Pairs of ids inside the radius that heimdall slices as a close call: their zones stay neutral where they overlap. */
  soft?: readonly (readonly [string, string])[]
}

/** The conflict red on a light studio's bed: the overhang red is about 2:1 there, this one over 3:1. */
export const CLEARANCE_RED_LIGHT = '#c0182c'

/** Height of the drawing over the bed, mm. */
const Z = 0.12
/** Width of a conflict's edge on the bed, mm. */
const HOT_EDGE = 0.8
/** Width of the ring round a selected object's zone, mm, and the gap between it and the zone's edge. */
const PICK_EDGE = 3
const PICK_GAP = 0.5

/** A closed band of width `w` along a convex ring, as triangles at height `z`, its middle `shift` mm outside the ring. */
function ribbon(ring: readonly Pt[], w: number, z: number, shift = 0): BufferGeometry {
  const n = ring.length
  const pos: number[] = []
  // Each corner moves along the bisector of its two edge normals, so the band keeps its width.
  const off = ring.map((p, i) => {
    const a = ring[(i + n - 1) % n]!
    const b = ring[(i + 1) % n]!
    const n1 = norm(p[1] - a[1], a[0] - p[0])
    const n2 = norm(b[1] - p[1], p[0] - b[0])
    const m = norm(n1[0] + n2[0], n1[1] + n2[1])
    const k = Math.max(0.3, m[0] * n1[0] + m[1] * n1[1])
    return [m[0] / k, m[1] / k] as const
  })
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const [p, q] = [ring[i]!, ring[j]!]
    const [o, u] = [off[i]!, off[j]!]
    const [lo, hi] = [shift - w / 2, shift + w / 2]
    const [pi, po, qi, qo] = [[p[0] + o[0] * lo, p[1] + o[1] * lo], [p[0] + o[0] * hi, p[1] + o[1] * hi], [q[0] + u[0] * lo, q[1] + u[1] * lo], [q[0] + u[0] * hi, q[1] + u[1] * hi]] as const
    pos.push(pi[0], pi[1], z, po[0], po[1], z, qo[0], qo[1], z, pi[0], pi[1], z, qo[0], qo[1], z, qi[0], qi[1], z)
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  return g
}

/** The inside of a convex ring as a fan. */
function fill(ring: readonly Pt[], z: number): BufferGeometry {
  const pos: number[] = []
  const c = ring[0]!
  for (let i = 1; i + 1 < ring.length; i++) pos.push(c[0], c[1], z, ring[i]![0], ring[i]![1], z, ring[i + 1]![0], ring[i + 1]![1], z)
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  return g
}

/** A strip from x 0 to 1, y -0.5 to 0.5, in `n` dashes; scaled to the bed's width it is a lane's edge. */
function dashes(n: number): BufferGeometry {
  const pos: number[] = []
  for (let i = 0; i < n; i++) {
    const [a, b] = [i / n, (i + 0.55) / n]
    pos.push(a, -0.5, 0, b, -0.5, 0, b, 0.5, 0, a, -0.5, 0, b, 0.5, 0, a, 0.5, 0)
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  return g
}

function norm(x: number, y: number): [number, number] {
  const l = Math.hypot(x, y) || 1
  return [x / l, y / l]
}

/** Whether two convex polygons overlap (separating axis); touching counts as apart. */
export function convexOverlap(a: readonly Pt[], b: readonly Pt[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!
      const q = poly[(i + 1) % poly.length]!
      const [nx, ny] = [q[1] - p[1], p[0] - q[0]]
      let [amin, amax, bmin, bmax] = [Infinity, -Infinity, Infinity, -Infinity]
      for (const v of a) {
        const d = v[0] * nx + v[1] * ny
        amin = Math.min(amin, d)
        amax = Math.max(amax, d)
      }
      for (const v of b) {
        const d = v[0] * nx + v[1] * ny
        bmin = Math.min(bmin, d)
        bmax = Math.max(bmax, d)
      }
      if (amax <= bmin || bmax <= amin) return false
    }
  }
  return true
}

/**
 * The objects in a conflict and the tall objects whose gantry lane a later object meets, for zones where they are now.
 * Pure, so it is tested without a scene.
 */
export function clearanceConflicts(zones: readonly { id: string; zone: readonly Pt[]; hull: readonly Pt[]; topMm: number }[], gantry: { rodMm: number; reachMm: number }, soft: readonly (readonly [string, string])[] = []): { hot: Set<string>; lanes: Map<string, { lo: number; hi: number; hit: boolean }> } {
  const hot = new Set<string>()
  const close = new Set(soft.flatMap(([a, b]) => [`${a} ${b}`, `${b} ${a}`]))
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      if (close.has(`${zones[i]!.id} ${zones[j]!.id}`)) continue
      if (convexOverlap(zones[i]!.zone, zones[j]!.zone)) {
        hot.add(zones[i]!.id)
        hot.add(zones[j]!.id)
      }
    }
  }
  const band = (h: readonly Pt[]): [number, number] => [Math.min(...h.map((p) => p[1])) - gantry.reachMm, Math.max(...h.map((p) => p[1])) + gantry.reachMm]
  const lanes = new Map<string, { lo: number; hi: number; hit: boolean }>()
  zones.forEach((z, i) => {
    if (z.topMm <= gantry.rodMm || z.hull.length === 0) return
    const [lo, hi] = band(z.hull)
    const hit = zones.slice(i + 1).some((later) => {
      const [l, u] = band(later.hull)
      return Math.min(hi, u) - Math.max(lo, l) > 0
    })
    lanes.set(z.id, { lo, hi, hit })
  })
  return { hot, lanes }
}

interface Drawn {
  z: ClearanceZone
  group: Group
  inv: Matrix4
  area: Mesh
  hot: Mesh
  /** The ring in the selection color, shown while the object is selected. */
  pick: Mesh
  /** The hairline edge: a band seen nearly edge on thins out, a line never does. */
  hair: LineLoop
  zoneNow: Pt[]
  hullNow: Pt[]
}

export class ClearanceZones {
  /** Child of the objects root (bed frame, Z up, mm). */
  readonly group = new Group()
  private readonly face = { transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false } as const
  private readonly mats = {
    zone: new MeshBasicMaterial({ ...this.face, opacity: 0.1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    hotZone: new MeshBasicMaterial({ ...this.face, opacity: 0.16, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    hot: new MeshBasicMaterial({ ...this.face, opacity: 1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    pick: new MeshBasicMaterial({ ...this.face, opacity: 1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    lane: new MeshBasicMaterial({ ...this.face, opacity: 0.07 }),
    hotLane: new MeshBasicMaterial({ ...this.face, opacity: 0.1 }),
    laneEdge: new MeshBasicMaterial({ ...this.face, opacity: 0.75 }),
    hotLaneEdge: new MeshBasicMaterial({ ...this.face, opacity: 1 }),
  }
  private readonly hairs = { line: new LineBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }), picked: new LineBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false }), hot: new LineBasicMaterial({ depthWrite: false, toneMapped: false }) }
  private readonly unit = new PlaneGeometry(1, 1)
  private readonly dash = dashes(48)
  private drawn: Drawn[] = []
  private spec: ClearanceSpec | null = null
  private readonly lanes = new Group()
  private readonly laneParts = new Map<string, { area: Mesh; edges: [Mesh, Mesh] }>()
  /** The ids in a conflict as of the last frame. */
  conflicts = new Set<string>()

  constructor() {
    this.group.name = 'clearance-zones'
    this.group.renderOrder = 3
    this.lanes.name = 'gantry-lanes'
    this.group.add(this.lanes)
    this.group.visible = false
    this.setColors('#ff4b5c', '#c9cfe2', '#bd93f9')
  }

  setColors(red: string, neutral: string, selection: string): void {
    const r = new Color(red)
    const n = new Color(neutral)
    for (const m of [this.mats.zone, this.mats.lane, this.mats.laneEdge]) m.color.copy(n)
    for (const m of [this.mats.hot, this.mats.hotZone, this.mats.hotLane, this.mats.hotLaneEdge]) m.color.copy(r)
    this.hairs.line.color.copy(n)
    this.hairs.hot.color.copy(r)
    this.hairs.picked.color.set(selection)
    this.mats.pick.color.set(selection)
  }

  set(spec: ClearanceSpec | null): void {
    for (const d of this.drawn) {
      this.group.remove(d.group)
      for (const m of [d.area, d.hot, d.pick, d.hair]) m.geometry.dispose()
    }
    this.drawn = []
    this.spec = spec
    for (const z of spec?.zones ?? []) {
      const group = new Group()
      group.matrixAutoUpdate = false
      const area = new Mesh(fill(z.zone, Z - 0.04), this.mats.zone)
      const hot = new Mesh(ribbon(z.zone, HOT_EDGE, Z + 0.02), this.mats.hot)
      const pick = new Mesh(ribbon(z.zone, PICK_EDGE, Z + 0.02, HOT_EDGE / 2 + PICK_GAP + PICK_EDGE / 2), this.mats.pick)
      pick.name = 'clearance-pick'
      pick.visible = false
      const hairGeo = new BufferGeometry()
      hairGeo.setAttribute('position', new Float32BufferAttribute(z.zone.flatMap((p) => [p[0], p[1], Z + 0.03]), 3))
      const hair = new LineLoop(hairGeo, this.hairs.line)
      for (const m of [area, hot, pick, hair]) m.renderOrder = 3
      group.add(area, hot, pick, hair)
      this.group.add(group)
      const at = new Matrix4().fromArray(z.transform as number[])
      this.drawn.push({ z, group, inv: at.clone().invert(), area, hot, pick, hair, zoneNow: [...z.zone], hullNow: [...z.hull] })
    }
    this.group.visible = this.drawn.length > 0
    if (!this.group.visible) this.clearLanes(new Set())
  }

  /** Moves each zone with its object and colors the ones that overlap now. */
  follow(matrixOf: (id: string) => Matrix4 | undefined): void {
    const spec = this.spec
    if (!spec || this.drawn.length === 0) return
    const m = new Matrix4()
    const v = new Vector3()
    for (const d of this.drawn) {
      const now = matrixOf(d.z.id)
      d.group.visible = now !== undefined
      if (!now) continue
      m.multiplyMatrices(now, d.inv)
      d.group.matrix.copy(m)
      d.group.matrixWorldNeedsUpdate = true
      const moved = (p: Pt): Pt => {
        v.set(p[0], p[1], 0).applyMatrix4(m)
        return [v.x, v.y]
      }
      d.zoneNow = d.z.zone.map(moved)
      d.hullNow = d.z.hull.map(moved)
    }
    const shown = this.drawn.filter((d) => d.group.visible)
    const { hot, lanes } = clearanceConflicts(shown.map((d) => ({ id: d.z.id, zone: d.zoneNow, hull: d.hullNow, topMm: d.z.topMm })), spec.gantry, spec.soft)
    this.conflicts = hot
    const picked = new Set(spec.selected)
    for (const d of this.drawn) {
      const isHot = hot.has(d.z.id)
      d.hot.visible = isHot
      // Selected, its zone gets the ring in the selection color, red edge or not, so a pair picked from the warning
      // reads on a phone's small view as well as its outline does on a desktop.
      d.pick.visible = picked.has(d.z.id)
      d.area.material = isHot ? this.mats.hotZone : this.mats.zone
      d.hair.material = isHot ? this.hairs.hot : picked.has(d.z.id) ? this.hairs.picked : this.hairs.line
    }
    for (const [id, lane] of lanes) {
      let parts = this.laneParts.get(id)
      if (!parts) {
        parts = { area: new Mesh(this.unit, this.mats.lane), edges: [new Mesh(this.dash, this.mats.laneEdge), new Mesh(this.dash, this.mats.laneEdge)] }
        this.lanes.add(parts.area, ...parts.edges)
        this.laneParts.set(id, parts)
      }
      const w = spec.gantry.widthMm
      parts.area.material = lane.hit ? this.mats.hotLane : this.mats.lane
      parts.area.position.set(w / 2, (lane.lo + lane.hi) / 2, Z - 0.06)
      parts.area.scale.set(w, lane.hi - lane.lo, 1)
      parts.edges.forEach((e, k) => {
        e.material = lane.hit ? this.mats.hotLaneEdge : this.mats.laneEdge
        e.position.set(0, k === 0 ? lane.lo : lane.hi, Z)
        e.scale.set(w, lane.hit ? 1.4 : 1, 1)
      })
    }
    this.clearLanes(new Set(lanes.keys()))
  }

  private clearLanes(keep: Set<string>): void {
    for (const [id, parts] of this.laneParts) {
      if (keep.has(id)) continue
      this.lanes.remove(parts.area, ...parts.edges)
      this.laneParts.delete(id)
    }
  }

  dispose(): void {
    this.set(null)
    this.unit.dispose()
    this.dash.dispose()
    for (const m of Object.values(this.mats)) m.dispose()
    for (const m of Object.values(this.hairs)) m.dispose()
  }
}
