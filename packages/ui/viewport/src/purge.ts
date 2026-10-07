// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The purge at the chute, for Bambu Lab printers that flush there (docs/toolchanger-sim.md, "Purge"):
// - the flush of each change, read from the G-code the engine wrote: the extrusion between `; FLUSH_START`
//   and `; FLUSH_END` (X1, P1, A1 extrude it themselves), or the virtual `;VG1` moves between
//   `; VFLUSH_START` and `; VFLUSH_END` that stand for the firmware's own flush on the H2D and H2C, or
//   failing both the length the change hands the firmware (`M620.10 A1 ... L<mm>`);
// - when it plays: at the end of the change's load, at the feed rates of those moves, until the head
//   leaves over the wiper;
// - the blob: a soft coiled shape hanging from the nozzle whose volume is the plastic pushed out so far,
//   its color running from the filament the nozzle held to the new one the way the purge mixes; the wiper
//   catches it as the head leaves and it drops down the chute.
// Everything here is a pure function of the change's clock, so a scrub lands on the same frame both ways.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Material,
} from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { displayHex } from './palette'
import { poseAt, type ChangeSequence, type ToolChangerSpec } from './toolchanger'

// ---------- the flush in the G-code ----------

export interface FlushStep {
  /** Filament pushed, mm. */
  e: number
  /** Seconds at the move's feed rate. */
  seconds: number
}

export interface Flush {
  /** Filament pushed through at the chute, mm. */
  e: number
  seconds: number
  steps: FlushStep[]
  /** Real extrusion moves, the virtual moves Bambu writes for a firmware flush, or the length handed to the firmware. */
  source: 'moves' | 'virtual' | 'firmware'
}

const param = (words: string, letter: string): number | null => {
  const m = new RegExp(`(?:^|\\s)${letter}(-?\\d*\\.?\\d+(?:e-?\\d+)?)`, 'i').exec(words)
  return m ? Number(m[1]) : null
}

/**
 * The flush in the lines of one change, or null when it has none. `relative` is the extrusion mode in force
 * where the lines start (Bambu prints in M83); M82, M83 and G92 inside are followed.
 */
export function flushOf(lines: Iterable<string>, relative = true): Flush | null {
  const real: FlushStep[] = []
  const virtual: FlushStep[] = []
  let firmware: FlushStep | null = null
  let rel = relative
  let lastE = 0
  let feed = 0
  let block: 'real' | 'virtual' | null = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith(';')) {
      const c = line.slice(1).trim()
      if (/^FLUSH_START\b/.test(c)) block = 'real'
      else if (/^VFLUSH_START\b/.test(c)) block = 'virtual'
      else if (/^V?FLUSH_END\b/.test(c)) block = null
      else if (block === 'virtual' && /^VG[01]\s/i.test(c)) {
        const words = c.slice(3)
        const e = param(words, 'E')
        const f = param(words, 'F')
        if (e !== null && e > 0) virtual.push({ e, seconds: f && f > 0 ? (e / f) * 60 : 0 })
      }
      continue
    }
    const words = line.split(';')[0]!.trim()
    const head = words.split(/\s+/)[0]!.toUpperCase()
    if (head === 'M82') rel = false
    else if (head === 'M83') rel = true
    else if (head === 'G92') {
      const e = param(words.slice(3), 'E')
      if (e !== null) lastE = e
    } else if (head === 'G0' || head === 'G1') {
      const rest = words.slice(head.length)
      const f = param(rest, 'F')
      if (f !== null && f > 0) feed = f
      const e = param(rest, 'E')
      if (e === null) continue
      const de = rel ? e : e - lastE
      if (!rel) lastE = e
      if (block === 'real' && de !== 0) real.push({ e: de, seconds: feed > 0 ? (Math.abs(de) / feed) * 60 : 0 })
    } else if (head === 'M620.10' && param(words.slice(7), 'A') === 1) {
      const l = param(words.slice(7), 'L')
      const f = param(words.slice(7), 'F')
      if (l !== null && l > 0) firmware = { e: l, seconds: f && f > 0 ? (l / f) * 60 : 0 }
    }
  }
  const pick = (steps: FlushStep[], source: Flush['source']): Flush | null => {
    const e = steps.reduce((s, x) => s + x.e, 0)
    return e > 0.01 ? { e, seconds: steps.reduce((s, x) => s + x.seconds, 0), steps, source } : null
  }
  return pick(real, 'moves') ?? pick(virtual, 'virtual') ?? (firmware ? pick([firmware], 'firmware') : null)
}

/** Plastic volume of `e` mm of filament `diameter` mm across, mm3. */
export function purgeVolume(e: number, diameter: number): number {
  return Math.max(0, e) * Math.PI * (diameter / 2) ** 2
}

/** Grams of `volume` mm3 at `density` g/cm3. */
export function purgeGrams(volume: number, density: number): number {
  return (Math.max(0, volume) * Math.max(0, density)) / 1000
}

/** One change's purge as the playback shows it. */
export interface PurgePlan {
  /** The change's first segment (the change plays before it). */
  segment: number
  /** Filament pushed, mm. */
  e: number
  /** mm3. */
  volume: number
  grams: number
  /** The flush moves at their own feed rates. */
  steps: FlushStep[]
  /** The filament the nozzle held (the purge starts in its color) and the new one; the same when the nozzle keeps its filament. */
  from: number
  to: number
}

/**
 * The filament each purge starts with: what the purging nozzle last held. On the H2C a rack hotend keeps its
 * filament, so a swap to it purges in its own color; a nozzle that changes filament purges from the old one
 * to the new one. `first` is the tool the print starts with.
 */
export function purgeFromTools(spec: Pick<ToolChangerSpec, 'kind' | 'extruderOf'>, first: number, changes: readonly { from: number; to: number }[]): number[] {
  const held = new Map<number, number>()
  const ex = (t: number) => spec.extruderOf[t] ?? 0
  const rack = spec.kind === 'hotend-rack' ? Math.max(...spec.extruderOf, 0) : -1
  held.set(ex(first), first)
  return changes.map((c) => {
    const e = ex(c.to)
    const before = e === rack ? c.to : (held.get(e) ?? c.to)
    held.set(e, c.to)
    return before
  })
}

// ---------- when it plays ----------

export interface PurgeWindow {
  /** Seconds into the change: the flush starts, ends, and the head starts over the wiper. */
  start: number
  end: number
  kick: number
}

/**
 * The flush inside a change: at the end of the last load before the head leaves over the wiper, at the
 * flush moves' own pace (squeezed into the load when they would take longer). Null for a change with no
 * chute stop.
 */
export function purgeWindow(seq: ChangeSequence, seconds: number): PurgeWindow | null {
  const wipe = seq.phases.findIndex((p) => p.name === 'wipe')
  if (wipe < 0) return null
  let load = -1
  for (let i = wipe - 1; i >= 0; i--)
    if (seq.phases[i]!.name === 'load') {
      load = i
      break
    }
  if (load < 0) return null
  const p = seq.phases[load]!
  const end = p.t0 + p.move + p.dwell
  return { start: Math.max(p.t0 + p.move, end - Math.max(0, seconds)), end, kick: seq.phases[wipe]!.t0 }
}

/** Share of the flush out of the nozzle at `t` seconds into the change (0 to 1), following the moves' feed rates. */
export function flushedShare(plan: Pick<PurgePlan, 'steps' | 'e'>, w: PurgeWindow, t: number): number {
  if (t <= w.start || plan.e <= 0) return 0
  if (t >= w.end) return 1
  const total = plan.steps.reduce((s, x) => s + x.seconds, 0)
  const span = w.end - w.start
  // Steps without a feed rate share the window by length.
  if (total <= 0) return (t - w.start) / span
  let clock = (t - w.start) * (total / span)
  let e = 0
  for (const s of plan.steps) {
    if (clock <= s.seconds) return Math.min(1, (e + (s.seconds > 0 ? (s.e * clock) / s.seconds : s.e)) / plan.e)
    clock -= s.seconds
    e += s.e
  }
  return 1
}

// ---------- the blob ----------

/** mm/s2. */
const GRAVITY = 9810
/** The wiper flicks the caught blob back into the chute (mm/s) and sets it turning (rad/s2), so its top clears the nozzle as it goes. */
const KICK = { vy: 70, spin: 58 }
/** Fallen this far the blob is deep in the chute, out of view. */
const FALL_OUT = 72

/**
 * The chute and wiper, in mm from the nozzle tip over the chute (x right, y back, z up). The purge hangs in the
 * air between the nozzle and the chute's mouth, which sits below the largest blob; the wiper is a short blade
 * at the nozzle's height in front of it, on an arm from a post at the front rim's right, so the head leaving
 * forward drags the blob into it. The blade's back face is flush with the inside of the front wall.
 */
export const CHUTE = {
  x: [-17, 17] as const,
  y: [-12, 18] as const,
  wall: 2,
  rim: -26,
  depth: 80,
  wiper: { x: [-6, 6] as const, y: [-13.4, -12] as const, z: [-3.4, -0.4] as const, holder: -4.6, arm: 12.6, post: [11.2, 12.6] as const },
} as const

export interface BlobState {
  /** Nothing to draw, plastic on the nozzle, or plastic dropping down the chute. */
  phase: 'none' | 'growing' | 'falling'
  /** mm3 in the blob. */
  volume: number
  /** The whole flush, mm3. */
  total: number
  /** World position of the blob's top (the nozzle tip while it hangs), mm. */
  at: [number, number, number]
  /** Tumble about x since it left the nozzle, rad. */
  spin: number
}

/** The blob's shape, from its volume alone; `seed` varies the lean and lumps from change to change. */
export interface BlobShape {
  positions: Float32Array
  /** 0 to 1 per vertex: where the plastic at the vertex sits in the flush, first out to last out. */
  order: Float32Array
  /** Per vertex 0 to 1: groove to crest of the coil. */
  rope: Float32Array
  /** Per vertex 0 to 1: how far into the mix the new color shows there (low shows it early). */
  streak: Float32Array
  index: Uint32Array
  /** Furthest the shape reaches toward -y and its height below the tip, mm. */
  front: number
  height: number
}

const RINGS = 64
const AROUND = 80
const smoothstep = (a: number, b: number, x: number) => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return u * u * (3 - 2 * u)
}

/** Strand radius as it leaves a 0.4 mm nozzle at flush speed, and the coil's pitch, mm. */
const STRAND = { r: 0.55, pitch: 1.2 }

/**
 * A soft pendant of coiled strand: a neck at the nozzle, a body that sags as it grows, helical coils with
 * rounded crests and narrow grooves, a slight lean and lumps. Scaled across so the closed mesh holds exactly
 * `volume` mm3. Deterministic in its arguments.
 */
export function blobShape(volume: number, total: number, seed = 0): BlobShape {
  const V = Math.max(1e-3, volume)
  // Small blobs sit as a bead on the tip; heavy ones sag.
  const k = 0.8 + 0.7 * smoothstep(0, 450, V)
  // A first guess of the body radius from a profile integral of about 0.53; the exact volume comes after.
  const rb = Math.cbrt(V / (2 * Math.PI * k * 0.53))
  const H = Math.max(0.6, 2 * k * rb)
  const neck = STRAND.r
  const turns = H / STRAND.pitch
  // Plastic winds out of the nozzle: the coils turn as the blob grows.
  const twist = V / 55
  const lean = 0.16 * Math.sin(seed * 1.7 + 0.4)
  const leanY = 0.06 * Math.cos(seed * 2.3)
  const n = RINGS * AROUND + 2
  const pos = new Float32Array(n * 3)
  const order = new Float32Array(n)
  const rope = new Float32Array(n)
  const streak = new Float32Array(n).fill(0.5)
  const ringR = new Float64Array(RINGS)
  const amp = Math.min(STRAND.r * 0.85, rb * 0.22)
  for (let i = 0; i < RINGS; i++) {
    const s = (i + 0.5) / RINGS
    // A round-bottomed pendant, fullest a little below its middle where the coils pile up.
    const u = Math.pow(s, 1.25)
    const body = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(2 * u - 1), 2.3)), 1 / 2.3) * (0.88 + 0.24 * s)
    const R = rb * body + neck * Math.pow(1 - s, 6)
    ringR[i] = R
    const fade = smoothstep(0.02, 0.14, s) * smoothstep(1, 0.86, s)
    const cx = lean * rb * Math.sin(Math.PI * s)
    const cy = leanY * rb * Math.sin(Math.PI * s)
    for (let j = 0; j < AROUND; j++) {
      const th = (j / AROUND) * Math.PI * 2
      const wob = 0.16 * Math.sin(2 * th + seed + 3.1 * s) + 0.09 * Math.sin(3 * th - 1.3 * seed + 5 * s)
      const phi = turns * s + th / (Math.PI * 2) + twist + wob + 0.3 * Math.sin(Math.PI * 1.3 * s + seed)
      const crest = Math.pow(Math.abs(Math.sin(Math.PI * phi)), 0.55) * (0.78 + 0.22 * Math.sin(3 * th + 11 * s + seed))
      const lump = 1 + 0.07 * Math.sin(th + 0.7 * seed + 2.5 * s) + 0.055 * Math.sin(2 * th + 2.1 + seed + 4 * s) + 0.035 * Math.sin(3 * th - 1.3 + 7 * s - seed)
      const r = Math.max(0.05, R * lump + amp * fade * (crest - 0.62))
      const v = i * AROUND + j
      pos[3 * v] = cx + r * Math.cos(th)
      pos[3 * v + 1] = cy + r * Math.sin(th)
      pos[3 * v + 2] = -s * H
      rope[v] = crest
      // Where the new color shows through first: threads that run along the coil and drift around it.
      streak[v] = 0.5 + 0.42 * Math.sin(Math.PI * 2 * phi + 2.2 * Math.sin(2 * th + 9 * s + seed)) * fade
    }
  }
  const top = RINGS * AROUND
  const bottom = top + 1
  pos[3 * top + 2] = 0
  pos[3 * bottom + 2] = -H
  rope[top] = 1
  rope[bottom] = 1
  const tris: number[] = []
  for (let i = 0; i + 1 < RINGS; i++)
    for (let j = 0; j < AROUND; j++) {
      const a = i * AROUND + j
      const b = i * AROUND + ((j + 1) % AROUND)
      const c = (i + 1) * AROUND + j
      const d = (i + 1) * AROUND + ((j + 1) % AROUND)
      tris.push(a, c, b, b, c, d)
    }
  for (let j = 0; j < AROUND; j++) {
    tris.push(top, j, (j + 1) % AROUND)
    const l = (RINGS - 1) * AROUND
    tris.push(bottom, l + ((j + 1) % AROUND), l + j)
  }
  const index = new Uint32Array(tris)
  // Exactly `volume`: scale across the axis (x and y), which scales the enclosed volume by the square.
  const f = Math.sqrt(V / Math.max(1e-9, meshVolume(pos, index)))
  for (let v = 0; v < n; v++) {
    pos[3 * v] = (pos[3 * v] ?? 0) * f
    pos[3 * v + 1] = (pos[3 * v + 1] ?? 0) * f
  }
  // Order of the plastic: the first out is pushed to the bottom, the last is at the nozzle.
  let above = 0
  const T = Math.max(V, total)
  for (let i = 0; i < RINGS; i++) {
    const R = (ringR[i] ?? 0) * f
    const slab = Math.PI * R * R * (H / RINGS)
    const q = (V - above - slab / 2) / T
    above += slab
    for (let j = 0; j < AROUND; j++) {
      const v = i * AROUND + j
      order[v] = Math.min(1, Math.max(0, q))
    }
  }
  order[top] = Math.min(1, V / T)
  order[bottom] = 0
  let front = 0
  for (let v = 0; v < n; v++) front = Math.max(front, -(pos[3 * v + 1] ?? 0))
  return { positions: pos, order, rope, streak, index, front, height: H }
}

/** Volume enclosed by a closed, outward wound triangle mesh, mm3. */
export function meshVolume(pos: ArrayLike<number>, index: ArrayLike<number>): number {
  let v = 0
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = 3 * (index[t] ?? 0)
    const b = 3 * (index[t + 1] ?? 0)
    const c = 3 * (index[t + 2] ?? 0)
    const ax = pos[a] ?? 0, ay = pos[a + 1] ?? 0, az = pos[a + 2] ?? 0
    const bx = pos[b] ?? 0, by = pos[b + 1] ?? 0, bz = pos[b + 2] ?? 0
    const cx = pos[c] ?? 0, cy = pos[c + 1] ?? 0, cz = pos[c + 2] ?? 0
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
  }
  return v
}

/**
 * The blob at `t` seconds into the change: nothing before the flush, growing on the nozzle tip while it runs,
 * dragged along by the head as it leaves until the wiper catches it (`front` is how far the blob reaches
 * forward of the tip), then falling down the chute with the wiper's flick and out of view. A pure function
 * of its arguments.
 */
export function blobAt(seq: ChangeSequence, plan: Pick<PurgePlan, 'steps' | 'e' | 'volume'>, w: PurgeWindow, t: number, front: number, wiperY: number, exit: ChuteExit = 'front'): BlobState {
  const none: BlobState = { phase: 'none', volume: 0, total: plan.volume, at: [0, 0, 0], spin: 0 }
  if (t <= w.start || plan.volume <= 0) return none
  const share = flushedShare(plan, w, t)
  const volume = plan.volume * share
  if (t < w.kick) {
    const p = poseAt(seq, t)
    return { phase: 'growing', volume, total: plan.volume, at: [p.x, p.y, p.z], spin: 0 }
  }
  // The head pulls the blob forward over the wiper; it lets go where the blob's front meets the wiper.
  const caught = catchTime(seq, w.kick, front, wiperY, exit)
  if (t < caught) {
    const p = poseAt(seq, t)
    return { phase: 'growing', volume, total: plan.volume, at: [p.x, p.y, p.z], spin: 0 }
  }
  const p = poseAt(seq, caught)
  const dt = t - caught
  const fall = 0.5 * GRAVITY * dt * dt
  if (fall > FALL_OUT) return none
  const [dx, dy] = EXIT[exit]
  return { phase: 'falling', volume, total: plan.volume, at: [p.x - dx * KICK.vy * dt, p.y - dy * KICK.vy * dt, p.z - fall], spin: 0.5 * KICK.spin * dt * dt }
}

/** Which way the head leaves the chute over the wiper. */
export type ChuteExit = 'front' | 'right'
/** The leaving direction in bed coordinates, and the chute's turn about z from the H2 family's (which leaves to the front). */
const EXIT: Record<ChuteExit, [number, number]> = { front: [0, -1], right: [1, 0] }
const TURN: Record<ChuteExit, number> = { front: 0, right: Math.PI / 2 }

/** A point's position along the chute's back axis (opposite the leaving direction), mm. */
const along = (x: number, y: number, exit: ChuteExit) => -(x * EXIT[exit][0] + y * EXIT[exit][1])

/** When the blob, carried by the head from `kick` on, first reaches the wiper. */
function catchTime(seq: ChangeSequence, kick: number, front: number, wiperY: number, exit: ChuteExit): number {
  const wipe = seq.phases.find((p) => p.name === 'wipe' && p.t0 >= kick - 1e-9)
  if (!wipe) return kick
  const end = wipe.t0 + wipe.move
  const reach = (t: number) => {
    const p = poseAt(seq, t)
    return along(p.x, p.y, exit) - front
  }
  if (reach(kick) <= wiperY) return kick
  if (reach(end) > wiperY) return end
  let lo = kick
  let hi = end
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (reach(mid) > wiperY) lo = mid
    else hi = mid
  }
  return hi
}

// ---------- drawing ----------

const chuteBlack = new MeshStandardMaterial({ color: new Color('#26272e'), metalness: 0.3, roughness: 0.55 })
const chuteInside = new MeshStandardMaterial({ color: new Color('#0d0d10'), metalness: 0.1, roughness: 0.9 })
const chuteSteel = new MeshStandardMaterial({ color: new Color('#a9aeb9'), metalness: 0.85, roughness: 0.32 })
const wiperMat = new MeshStandardMaterial({ color: new Color('#3b3d47'), metalness: 0.02, roughness: 0.7 })
const framePlastic = new MeshStandardMaterial({ color: new Color('#c9ccd3'), metalness: 0.05, roughness: 0.55 })

const slab = (mat: Material, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, name: string, r = 0): Mesh => {
  const geo = r > 0 ? new RoundedBoxGeometry(x1 - x0, y1 - y0, z1 - z0, 2, r) : new BoxGeometry(x1 - x0, y1 - y0, z1 - z0)
  const m = new Mesh(geo, mat)
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
  m.name = name
  return m
}

/**
 * The chute behind the bed and the purge blob. It stands still at the bed's level; on printers whose bed moves in z
 * it comes up to the head's height while a change flushes into it, where it meets the head in bed coordinates. On the
 * A1 and A1 mini it stays at the bed's level throughout (`chute.frame`).
 */
export class PurgeRig {
  readonly root = new Group()
  private readonly chute = new Group()
  private exit: ChuteExit = 'front'
  private mouth: { x: readonly [number, number]; y: readonly [number, number] } = CHUTE
  private readonly blob: Mesh
  private readonly geo = new BufferGeometry()
  private readonly mat = new MeshPhysicalMaterial({ vertexColors: true, roughness: 0.24, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.07 })
  private spec: ToolChangerSpec | null = null
  private colors: readonly string[] = []
  private lastKey = ''
  private shapeKey = ''
  private shape: BlobShape | null = null

  constructor() {
    this.root.name = 'purge'
    this.chute.name = 'chute'
    this.blob = new Mesh(this.geo, this.mat)
    this.blob.name = 'blob'
    this.blob.castShadow = true
    this.blob.frustumCulled = false
    this.blob.visible = false
    this.root.add(this.chute, this.blob)
    this.root.visible = false
  }

  set visible(on: boolean) {
    this.root.visible = on
  }

  get visible(): boolean {
    return this.root.visible
  }

  setSpec(spec: ToolChangerSpec | null): void {
    const ch = spec?.chute
    const key = ch ? `${ch.x}:${ch.y}:${ch.exit ?? 'front'}:${JSON.stringify(ch.mouth ?? null)}` : ''
    this.spec = spec
    if (key === this.lastKey) return
    this.lastKey = key
    for (const c of this.chute.children) (c as Mesh).geometry.dispose()
    this.chute.clear()
    this.exit = ch?.exit ?? 'front'
    this.mouth = ch?.mouth ?? CHUTE
    this.chute.rotation.z = TURN[this.exit]
    if (ch?.frame) this.buildFrameChute()
    else if (ch) this.buildChute()
  }

  setColors(colors: readonly string[]): void {
    this.colors = colors
    this.shapeKey = ''
  }

  /**
   * The chute: an open shaft with a steel rim, its mouth `CHUTE.x` by `CHUTE.y` around the nozzle's spot and
   * below the blob, dark inside so a falling blob fades into it; the wiper blade on its holder and posts at the
   * front. Everything stays under the nozzle tip, so the head passes over it. Built facing the front and turned
   * to the side the head leaves by; the mouth is the machine's where it has its own.
   */
  private buildChute(): void {
    const [x0, x1] = this.mouth.x
    const [y0, y1] = this.mouth.y
    const w = CHUTE.wall
    const top = CHUTE.rim
    const bot = top - CHUTE.depth
    const wp = { ...CHUTE.wiper, y: [y0 - 1.4, y0] as const }
    this.chute.add(
      slab(chuteInside, x0 - w, x1 + w, y0 - w, y0, bot, top - 1.2, 'front wall'),
      slab(chuteInside, x0 - w, x1 + w, y1, y1 + w, bot, top - 1.2, 'back wall'),
      slab(chuteInside, x0 - w, x0, y0, y1, bot, top - 1.2, 'side wall'),
      slab(chuteInside, x1, x1 + w, y0, y1, bot, top - 1.2, 'side wall'),
      // Black anodized skin outside the walls, a hair apart so no face is shared.
      slab(chuteBlack, x0 - w - 1.2, x1 + w + 1.2, y0 - w - 1.2, y0 - w - 0.01, bot, top - 1.2, 'skin'),
      slab(chuteBlack, x0 - w - 1.2, x0 - w - 0.01, y0 - w - 0.01, y1 + w + 1.2, bot, top - 1.2, 'skin'),
      slab(chuteBlack, x1 + w + 0.01, x1 + w + 1.2, y0 - w - 0.01, y1 + w + 1.2, bot, top - 1.2, 'skin'),
      slab(chuteBlack, x0 - w - 0.01, x1 + w + 0.01, y1 + w + 0.01, y1 + w + 1.2, bot, top - 1.2, 'skin'),
      // A brushed steel rim around the mouth.
      slab(chuteSteel, x0 - w - 1.2, x1 + w + 1.2, y0 - w - 1.2, y0, top - 1.2, top, 'rim', 0.5),
      slab(chuteSteel, x0 - w - 1.2, x1 + w + 1.2, y1, y1 + w + 1.2, top - 1.2, top, 'rim', 0.5),
      slab(chuteSteel, x0 - w - 1.2, x0, y0 + 0.01, y1 - 0.01, top - 1.2, top, 'rim', 0.5),
      slab(chuteSteel, x1, x1 + w + 1.2, y0 + 0.01, y1 - 0.01, top - 1.2, top, 'rim', 0.5),
      // The wiper: a silicone blade at the nozzle's height on a steel arm, its post down to the front rim.
      slab(wiperMat, wp.x[0], wp.x[1], wp.y[0], wp.y[1], wp.z[0], wp.z[1], 'wiper', 0.35),
      slab(chuteSteel, wp.x[0], wp.arm, wp.y[0], wp.y[1], wp.holder, wp.z[0], 'arm', 0.3),
      slab(chuteBlack, wp.post[0], wp.post[1], wp.y[0], wp.y[1], top, wp.holder, 'post'),
    )
    this.chute.traverse((o) => void ((o as Mesh).isMesh && ((o as Mesh).receiveShadow = true)))
  }

  /**
   * The A1 and A1 mini chute, estimated from Bambu's product photos (docs/toolchanger-sim.md): a small, low shaft in
   * the frame's light gray plastic at the bed's left, open below so the purge drops through, its mouth just under the
   * bed's surface, with the wiper blade on a block at the side the head leaves by, toward the bed.
   */
  private buildFrameChute(): void {
    const [x0, x1] = this.mouth.x
    const [y0, y1] = this.mouth.y
    const w = CHUTE.wall
    const top = -2
    const bot = top - 22
    const wp = { ...CHUTE.wiper, y: [y0 - w - 1.4, y0 - w] as const }
    this.chute.add(
      slab(framePlastic, x0 - w, x1 + w, y0 - w, y0, bot, top, 'front wall', 0.6),
      slab(framePlastic, x0 - w, x1 + w, y1, y1 + w, bot, top, 'back wall', 0.6),
      slab(framePlastic, x0 - w, x0, y0 + 0.01, y1 - 0.01, bot, top, 'side wall', 0.6),
      slab(framePlastic, x1, x1 + w, y0 + 0.01, y1 - 0.01, bot, top, 'side wall', 0.6),
      // The wiper: a silicone blade at the nozzle's height on a gray block against the front wall.
      slab(wiperMat, wp.x[0], wp.x[1], wp.y[0], wp.y[1], wp.z[0], wp.z[1], 'wiper', 0.35),
      slab(framePlastic, wp.x[0] - 1, wp.x[1] + 1, wp.y[0], wp.y[1], bot, wp.z[0] - 0.01, 'wiper block'),
    )
    this.chute.traverse((o) => void ((o as Mesh).isMesh && ((o as Mesh).receiveShadow = true)))
  }

  /** The blob's shape for a plan at `volume`, reused while the volume stands still. */
  shapeFor(plan: PurgePlan, volume: number): BlobShape {
    const key = `${plan.segment}:${volume.toFixed(4)}:${plan.from}:${plan.to}`
    if (this.shape && this.shapeKey === key) return this.shape
    this.shape = blobShape(volume, plan.volume, plan.segment % 97)
    this.shapeKey = key
    this.upload(this.shape, plan)
    return this.shape
  }

  private colorOf(tool: number): Color {
    return new Color(displayHex(this.colors[tool] ?? this.colors[this.colors.length - 1] ?? '#9aa4c1'))
  }

  private upload(s: BlobShape, plan: PurgePlan): void {
    const n = s.order.length
    const col = new Float32Array(n * 3)
    const a = this.colorOf(plan.from)
    const b = this.colorOf(plan.to)
    const c = new Color()
    for (let v = 0; v < n; v++) {
      // The purge runs old at first, mixes through the middle and comes out clean at the end. Two melts do not
      // blend into one color: the new one shows as threads along the coil that thicken until they take over.
      const m = smoothstep(0.08, 0.8, s.order[v] ?? 0)
      const u = s.streak[v] ?? 0.5
      c.copy(a).lerp(b, smoothstep(u - 0.1, u + 0.1, m))
      // Grooves between the coils catch less light.
      const shade = 0.7 + 0.3 * (s.rope[v] ?? 1)
      col[3 * v] = c.r * shade
      col[3 * v + 1] = c.g * shade
      col[3 * v + 2] = c.b * shade
    }
    this.geo.setAttribute('position', new BufferAttribute(s.positions, 3))
    this.geo.setAttribute('color', new BufferAttribute(col, 3))
    this.geo.setIndex(new BufferAttribute(s.index, 1))
    this.geo.computeVertexNormals()
    this.geo.computeBoundingBox()
    this.geo.computeBoundingSphere()
  }

  /**
   * Places the chute at the head's height `z` and the blob for `seconds` into the change `seq` with its
   * purge `plan`; without a change in progress only the chute shows.
   */
  place(z: number, at: { seq: ChangeSequence; plan: PurgePlan; seconds: number } | null): BlobState | null {
    const ch = this.spec?.chute
    this.chute.visible = !!ch
    this.blob.visible = false
    if (!ch) return null
    // The chute stands still on the frame. Where the bed drops in z (X1, P1, H2) it meets the head at the head's height
    // in bed coordinates, so it comes up to it for a change and is back at the bed's level the rest of the print.
    this.chute.position.set(ch.x, ch.y, ch.frame || !at ? 0 : z)
    if (!at) return null
    const w = purgeWindow(at.seq, totalSeconds(at.plan))
    if (!w) return null
    const share = flushedShare(at.plan, w, at.seconds)
    if (share <= 0) return null
    const shape = this.shapeFor(at.plan, at.plan.volume * share)
    const st = blobAt(at.seq, at.plan, w, at.seconds, shape.front, along(ch.x, ch.y, this.exit) + this.mouth.y[0], this.exit)
    if (st.phase === 'none') return st
    this.blob.visible = true
    // The blob's top sits on the nozzle tip; falling, it turns about its middle, tipping back into the chute.
    const mid = shape.height / 2
    const turn = TURN[this.exit]
    const back = -Math.sin(st.spin) * mid
    this.blob.rotation.set(st.spin, 0, turn, 'ZYX')
    this.blob.position.set(st.at[0] - back * Math.sin(turn), st.at[1] + back * Math.cos(turn), st.at[2] + 0.05 - mid + Math.cos(st.spin) * mid)
    this.blob.updateMatrix()
    return st
  }

  dispose(): void {
    for (const c of this.chute.children) (c as Mesh).geometry.dispose()
    this.geo.dispose()
    this.mat.dispose()
  }
}

/** Seconds of a plan's flush moves at their feed rates. */
export function totalSeconds(plan: Pick<PurgePlan, 'steps'>): number {
  return plan.steps.reduce((s, x) => s + x.seconds, 0)
}
