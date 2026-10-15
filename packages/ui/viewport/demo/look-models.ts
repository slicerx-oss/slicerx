// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Procedural parts for the look lab (look.html): figure-like organic shapes, a machined bracket with holes and
// fillets, and the same set for a dark filament. Z up, millimeters, built in code (no model files).
import { ExtrudeGeometry, LatheGeometry, Path, Shape, Vector2, type BufferGeometry } from 'three'

export interface LabPart {
  name: string
  color: string
  positions: Float32Array
  indices: Uint32Array
  /** Where the part sits on the bed, mm from the front left corner. */
  at: [number, number]
}

/** A closed tube surface from a function of (angle u, height v) to a point, with fan caps at both ends. */
function sweep(f: (u: number, v: number) => [number, number, number], nu: number, nv: number): { positions: Float32Array; indices: Uint32Array } {
  const pos: number[] = []
  const idx: number[] = []
  for (let j = 0; j <= nv; j++) for (let i = 0; i < nu; i++) pos.push(...f((i / nu) * Math.PI * 2, j / nv))
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * nu + i
      const b = j * nu + ((i + 1) % nu)
      idx.push(a, b, b + nu, a, b + nu, a + nu)
    }
  }
  // caps: a center point at each end
  const ring = (j: number): [number, number, number] => {
    let x = 0, y = 0, z = 0
    for (let i = 0; i < nu; i++) {
      x += pos[(j * nu + i) * 3]!
      y += pos[(j * nu + i) * 3 + 1]!
      z += pos[(j * nu + i) * 3 + 2]!
    }
    return [x / nu, y / nu, z / nu]
  }
  const bot = pos.length / 3
  pos.push(...ring(0))
  const top = pos.length / 3
  pos.push(...ring(nv))
  const end = nv * nu
  for (let i = 0; i < nu; i++) {
    const n = (i + 1) % nu
    idx.push(bot, n, i, top, end + i, end + n)
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) }
}

/** A closed surface from spherical angles to a radius (polar from +Z). */
function blob(r: (theta: number, phi: number) => number, center: [number, number, number], squashZ: number, floorZ: number, nu = 192, nv = 128) {
  return sweep(
    (u, v) => {
      const th = Math.PI * (1 - v) // v 0 bottom pole, 1 top pole
      const rr = r(th, u)
      const z = center[2] + rr * Math.cos(th) * squashZ
      return [center[0] + rr * Math.sin(th) * Math.cos(u), center[1] + rr * Math.sin(th) * Math.sin(u), Math.max(floorZ, z)]
    },
    nu,
    nv,
  )
}

function fromGeometry(g: BufferGeometry): { positions: Float32Array; indices: Uint32Array } {
  const ng = g.index ? g.toNonIndexed() : g
  const p = ng.getAttribute('position').array as Float32Array
  const n = p.length / 3
  const idx = new Uint32Array(n)
  for (let i = 0; i < n; i++) idx[i] = i
  return { positions: new Float32Array(p), indices: idx }
}

function merge(list: { positions: Float32Array; indices: Uint32Array }[]): { positions: Float32Array; indices: Uint32Array } {
  const np = list.reduce((s, m) => s + m.positions.length, 0)
  const ni = list.reduce((s, m) => s + m.indices.length, 0)
  const positions = new Float32Array(np)
  const indices = new Uint32Array(ni)
  let po = 0, io = 0
  for (const m of list) {
    positions.set(m.positions, po)
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i]! + po / 3
    po += m.positions.length
    io += m.indices.length
  }
  return { positions, indices }
}

function shift(m: { positions: Float32Array; indices: Uint32Array }, dx: number, dy: number, dz: number) {
  for (let i = 0; i < m.positions.length; i += 3) {
    m.positions[i]! += dx
    m.positions[i + 1]! += dy
    m.positions[i + 2]! += dz
  }
  return m
}

/** Lathe around Z from [r, z] profile points (three's lathe turns around Y, so swap axes). */
function latheZ(profile: [number, number][], seg = 128) {
  const g = new LatheGeometry(profile.map(([r, z]) => new Vector2(r, z)), seg)
  g.rotateX(Math.PI / 2)
  return fromGeometry(g)
}

/** A tulip vase: a swelling stem that opens into a wavy five lobed rim, solid. */
function tulip() {
  return sweep(
    (u, v) => {
      const h = 110
      const stem = 9 + 4 * Math.sin(Math.PI * Math.min(1, v * 1.6))
      const open = Math.pow(Math.max(0, v - 0.35) / 0.65, 1.6) * 34
      const lobes = 1 + 0.16 * Math.cos(5 * u + v * 2.2) * Math.min(1, v * 1.4)
      const r = (stem + open) * lobes
      const rim = v > 0.85 ? Math.cos(5 * u + 2.2) * 9 * ((v - 0.85) / 0.15) : 0
      return [r * Math.cos(u), r * Math.sin(u), h * v + rim]
    },
    220,
    140,
  )
}

/** A figure head: a dome with a horn and a brow ridge, flat on the bed. */
function domeHead() {
  const horn: [number, number, number] = [0.35, 0.1, 0.93]
  const hl = Math.hypot(...horn)
  const hd = horn.map((x) => x / hl)
  return blob(
    (th, ph) => {
      const d: [number, number, number] = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)]
      const c = d[0] * hd[0]! + d[1] * hd[1]! + d[2] * hd[2]!
      const spike = 28 * Math.exp(-(1 - c) * 70)
      const brow = 3.2 * Math.exp(-Math.pow((th - 1.15) / 0.12, 2)) * Math.max(0, Math.cos(ph - 0.3))
      const cheeks = 2.5 * Math.cos(2 * ph) * Math.sin(th)
      return 38 + spike + brow + cheeks
    },
    [0, 0, 0],
    0.9,
    0,
  )
}

/** A twisted ribbon column on a round foot, like a figure's flowing cloak. */
function twist() {
  const body = sweep(
    (u, v) => {
      const h = 92
      const lobes = 1 + 0.42 * Math.pow(Math.cos(3 * (u + v * 2.4)), 3)
      const r = (16 - 6 * v + 4 * Math.sin(v * 7)) * lobes
      return [r * Math.cos(u) + 6 * Math.sin(v * 3), r * Math.sin(u), 4 + h * v]
    },
    240,
    160,
  )
  const foot = latheZ([[0.01, 0], [22, 0], [23, 1], [23, 3.2], [22, 4.2], [0.01, 4.2]], 128)
  return merge([body, foot])
}

/** A shell with an arched opening, like the owner's dome piece: a hemisphere ring with lumps. */
function shellHalf() {
  return blob((th, ph) => 34 + 2 * Math.sin(3 * ph) * Math.sin(th) + 1.5 * Math.cos(5 * th), [0, 0, 0], 0.72, 0, 160, 96)
}

/** A machined bracket: a filleted base plate with four holes and a slot, an upright wall with a hole, and a bored boss. */
function bracket() {
  const plate = new Shape()
  const W = 96, D = 60, R = 8
  plate.moveTo(R, 0)
  plate.lineTo(W - R, 0)
  plate.absarc(W - R, R, R, -Math.PI / 2, 0, false)
  plate.lineTo(W, D - R)
  plate.absarc(W - R, D - R, R, 0, Math.PI / 2, false)
  plate.lineTo(R, D)
  plate.absarc(R, D - R, R, Math.PI / 2, Math.PI, false)
  plate.lineTo(0, R)
  plate.absarc(R, R, R, Math.PI, Math.PI * 1.5, false)
  for (const [x, y] of [[10, 10], [W - 10, 10], [10, D - 10], [W - 10, D - 10]] as const) {
    const h = new Path()
    h.absarc(x, y, 3.4, 0, Math.PI * 2, true)
    plate.holes.push(h)
  }
  const slot = new Path()
  slot.moveTo(30, 12)
  slot.lineTo(56, 12)
  slot.absarc(56, 16, 4, -Math.PI / 2, Math.PI / 2, false)
  slot.lineTo(30, 20)
  slot.absarc(30, 16, 4, Math.PI / 2, Math.PI * 1.5, false)
  plate.holes.push(slot)
  const base = new ExtrudeGeometry(plate, { depth: 6, bevelEnabled: true, bevelThickness: 1.6, bevelSize: 1.6, bevelSegments: 6, curveSegments: 40 })
  base.translate(0, 0, 1.6)
  // upright wall at the back
  const wallS = new Shape()
  wallS.moveTo(14, 0)
  wallS.lineTo(W - 14, 0)
  wallS.lineTo(W - 14, 30)
  wallS.absarc(W / 2, 30, W / 2 - 14, 0, Math.PI, false)
  wallS.lineTo(14, 0)
  const wh = new Path()
  wh.absarc(W / 2, 34, 11, 0, Math.PI * 2, true)
  wallS.holes.push(wh)
  const wall = new ExtrudeGeometry(wallS, { depth: 7, bevelEnabled: true, bevelThickness: 1.4, bevelSize: 1.4, bevelSegments: 5, curveSegments: 48 })
  wall.rotateX(Math.PI / 2)
  wall.translate(0, D - 5, 9)
  // a bored boss with a filleted top edge and a chamfered bore
  const boss = latheZ([[7, 0], [14, 0], [14, 14], [13.6, 15.6], [12.4, 16.8], [10.6, 17.4], [8.2, 17.4], [7, 16.2], [7, 0]], 96)
  shift(boss, 78, 32, 9)
  return merge([fromGeometry(base), fromGeometry(wall), boss])
}

/** A gear-like knob: a lathe with knurled ribs. */
function knob() {
  return sweep(
    (u, v) => {
      const r = 18 + (v < 0.8 ? 1.4 * Math.max(0, Math.cos(18 * u)) ** 4 : 0) - (v > 0.8 ? (v - 0.8) * 22 : 0)
      return [r * Math.cos(u), r * Math.sin(u), 26 * v]
    },
    288,
    40,
  )
}

export type LabScene = 'organic' | 'mech' | 'dark'

const WHITE = '#ebebe6'
const CHARCOAL = '#2c2d31'

export function labParts(scene: LabScene): LabPart[] {
  if (scene === 'organic') {
    return [
      { name: 'Head', color: WHITE, ...domeHead(), at: [48, 80] },
      { name: 'Shell', color: WHITE, ...shellHalf(), at: [118, 66] },
      { name: 'Cloak', color: WHITE, ...twist(), at: [150, 160] },
      { name: 'Tulip', color: WHITE, ...tulip(), at: [205, 110] },
    ]
  }
  if (scene === 'mech') {
    return [
      { name: 'Bracket', color: '#c8ccd2', ...shift(bracket(), -48, -30, 0), at: [110, 120] },
      { name: 'Knob', color: '#c8ccd2', ...knob(), at: [195, 70] },
    ]
  }
  return [
    { name: 'Bracket', color: CHARCOAL, ...shift(bracket(), -48, -30, 0), at: [95, 120] },
    { name: 'Cloak', color: CHARCOAL, ...twist(), at: [190, 150] },
    { name: 'Knob', color: '#1f4fa8', ...knob(), at: [190, 70] },
  ]
}
