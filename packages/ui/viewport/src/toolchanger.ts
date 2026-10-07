// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How a printer changes tools, as a sequence Preview can play: where the toolhead goes, what it parks
// and picks, and how long each step takes. Three mechanisms are modeled, each from the machine's own
// profile, firmware configuration or documentation (docs/toolchanger-sim.md lists what is measured and
// what is estimated):
//
// - dual-nozzle (Bambu Lab H2D): two hotends on one toolhead; the switch happens at the purge chute at
//   the back, where the idle nozzle lifts and the other comes down.
// - hotend-rack (Bambu Lab H2C): the right hotend is swapped from a rack on the right side of the
//   chamber, two rows of three positions; the filament is cut and flushed at the chute before and after.
// - tool-rack (Snapmaker U1): four toolheads park in a dock across the back; the carriage pushes the one
//   it carries into its slot, releases it, and pulls the next one out.
// - lift-switch (UltiMaker S series): two print cores in one head; the left one is fixed, the right one
//   rides on the lift switch. The head stops at the switching position the slicer writes, the firmware
//   runs the switch's lever into the switch bay on the right wall and along it, which lowers or lifts the
//   right core, and the head comes back out.
// - filament-swap (Bambu Lab A1, A1 mini, X1, P1, H2S): one nozzle; the AMS swaps the filament. The head goes to
//   the cutter, then to the purge chute, flushes, and leaves over the wiper.
//
// Moves are timed with trapezoidal velocity profiles from the printer's speed and acceleration limits,
// so the head never jumps. The firmware's own work (cutting, loading, flushing, latching) is a dwell of
// the seconds the slicer counts for the change (`fixedSeconds`, from `ChangeClock`), spent where the
// machine spends it. Positions are bed coordinates in mm, origin at the front left corner, z up.
import type { Bed, PreviewBuffers } from '@slicerx/contracts'

export type V3 = [number, number, number]

export type ToolChangerKind = 'dual-nozzle' | 'hotend-rack' | 'tool-rack' | 'xl-dock' | 'lift-switch' | 'filament-swap'

export interface MotionLimits {
  /** mm/s */
  speed: number
  /** mm/s2 */
  accel: number
}

export interface ToolChangerSpec {
  kind: ToolChangerKind
  bed: Bed
  /** Filament slots the print uses (tool bytes 0 to tools - 1). */
  tools: number
  /** 0-based extruder of each tool (`filament_map`); a tool-rack has one extruder per tool. */
  extruderOf: number[]
  travel: MotionLimits
  z: MotionLimits
  /** Slow moves at a dock or rack. */
  dock: MotionLimits
  /** Height the head lifts above the top layer for the change, mm. */
  liftMm: number
  /**
   * The change G-code lifts over the highest layer printed so far (`max_layer_z`), as the makers' own do, so a change
   * printed by object clears the finished objects (the engine's collision check reads the same).
   */
  liftOverPrint?: boolean
  /** Fixed seconds the profile gives the firmware's work: the switch, a load and an unload. */
  seconds: { switch: number; load: number; unload: number }
  /** Bambu: the purge chute and nozzle wiper, where the nozzle flushes over it, and the Y stops of the exit moves written after the change. */
  chute?: {
    x: number
    y: number
    exitY: number[]
    /** Which way the head leaves over the wiper: toward the front (the H2 family) or to the right (X1, P1, A1). */
    exit?: 'front' | 'right'
    /** The wipe and exit stops after the flush where they are not straight to the front; the first one takes the purge past the wiper. */
    exits?: [number, number][]
    /** The cutter, the head's first stop (null y keeps the head's y); none where the firmware cuts at the chute. */
    cut?: [number, number | null]
    /**
     * A1, A1 mini: the chute stands on the frame, which neither the bed (moving in y) nor the gantry (moving in z)
     * carries. Preview holds the bed still, so the chute stays at its flush spot at bed level: the change moves the
     * bed to that y before it flushes, so the head meets it there.
     */
    frame?: boolean
    /** The mouth around the nozzle's spot, x across and y back from the wiper side, where it differs from the H2 family's (`CHUTE`). */
    mouth?: { x: [number, number]; y: [number, number] }
  }
  /** H2D: distance between the two nozzles and how far the idle one lifts. */
  nozzles?: { spacing: number; liftMm: number }
  /** H2C: the rack on the right wall. Slot k sits at row floor(k / 3), ys[k % 3]. */
  rack?: { x: number; ys: number[]; rowRise: number; approachX: number; latchY: number; slots: number }
  /** U1: dock slots along the back, from the printer's Klipper configuration. */
  docks?: { x: number[]; y: number; idleY: number; strokeX: number; retractX: number; bufferMm: number; grab: MotionLimits; slow: MotionLimits }
  /**
   * Prusa XL: the dock along the back frame and the firmware's park and pick moves (Prusa-Firmware-Buddy,
   * toolchanger_utils.h and toolchanger_xl.cpp). Offsets are from a dock's x and y.
   */
  xl?: {
    x: number[]
    y: number
    /** Y in front of the docks with a tool on the head, and without one. */
    safeWith: number
    safeWithout: number
    park: { approachX: number; unlockX: number; seatX: number }
    pick: { preY: number; lockX: number; lockedX: number; clearX: number }
    /** Moves into and out of a dock (SLOW_MOVE_MM_S, SLOW_ACCELERATION_MM_S2); the approach (PARKING_FINAL_MAX_SPEED). */
    slow: MotionLimits
    approach: MotionLimits
    /** The firmware's wait for the parked or picked sensor (WAIT_TIME_TOOL_PARKED_PICKED), s. */
    sense: number
  }
  /**
   * UltiMaker S series. Positions are the head's, which the G-code writes as the left nozzle's (the firmware
   * applies no offset): the right core prints `offsets[1]` to the right of it.
   */
  lift?: {
    /** Each core's nozzle offset from the left one (`extruder_offset`), mm. */
    offsets: [number, number][]
    /** Where the head waits before and after each core's switch (`toolchange_park_position`, Cura's `machine_extruder_start_pos` and `_end_pos`). */
    park: [number, number][]
    /** The lowered right nozzle's tip under the left one, and its stroke on the lift switch, mm. */
    lowered: number
    stroke: number
    /** How far the firmware runs the lever into the switch bay past the switching position, mm. */
    bayIn: number
    /** Lever moves in the bay. */
    lever: MotionLimits
    /** Seconds of retraction before the head leaves for the switch (the usual one, then the switch length). */
    retract: number
    /** Where the firmware runs each core's switch from, at the bay: the switching positions, or on the S3 an estimate (see `toolChangerSpec`). */
    bayAt: [number, number][]
  }
}

/** A plain settings record (Orca keys) as the app resolves it. */
type Settings = Record<string, unknown>

const num = (v: unknown, fallback: number): number => {
  if (Array.isArray(v)) return num(v[0], fallback)
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback
  if (typeof v === 'string') {
    const n = Number.parseFloat(v)
    return Number.isFinite(n) ? n : fallback
  }
  return fallback
}

/** Points as the settings hold them: `[[x, y], ...]` or Orca's `["22x0", ...]`. */
const points = (v: unknown): [number, number][] => {
  if (!Array.isArray(v)) return []
  return v.map((p): [number, number] => {
    if (Array.isArray(p)) return [num(p[0], 0), num(p[1], 0)]
    const [x, y] = String(p).split(/x/i)
    return [num(x, 0), num(y, 0)]
  })
}

const list = (v: unknown): number[] => {
  if (Array.isArray(v)) return v.map((x) => num(x, 0))
  if (typeof v === 'string' && v.includes(',')) return v.split(',').map((x) => num(x, 0))
  return v === undefined ? [] : [num(v, 0)]
}

function kindOf(printerId: string | undefined, cfg: Settings): ToolChangerKind | null {
  const id = printerId ?? ''
  if (id.startsWith('bambu-h2d')) return 'dual-nozzle'
  if (id.startsWith('bambu-h2c')) return 'hotend-rack'
  if (id === 'snapmaker-u1') return 'tool-rack'
  if (id.startsWith('prusa-xl') && list(cfg['nozzle_diameter']).length > 1) return 'xl-dock'
  if (id.startsWith('ultimaker-s')) return 'lift-switch'
  const nozzles = list(cfg['nozzle_diameter']).length
  if (nozzles < 2) return swapChute(id, { widthMm: 0, depthMm: 0, heightMm: 0 }) ? 'filament-swap' : null
  if (list(cfg['extruder_max_nozzle_count']).some((n) => n > 1)) return 'hotend-rack'
  return nozzles === 2 ? 'dual-nozzle' : 'tool-rack'
}

/**
 * The purge chute of a Bambu Lab printer with one nozzle, from its machine G-code (Bambu Studio 2.8.4 templates):
 * - A1, A1 mini: the change cuts at the right end of X (`G1 X267`, `X180`), flushes at the left end
 *   (`G1 X-48.2`, `X-13.5` in the start G-code, with `G1 Y128`, `Y90` in the change), and wipes by running right
 *   over the wiper and back (`G1 X-38.2`, `X-3.5`). The chute is on the frame and the bed moves in y.
 * - X1, X1E, P1P, P1S: the cutter is at the back (`G1 X70`, `Y265`), the flush at X 54, Y 265 (the start G-code's
 *   `G1 X54`, `G1 Y265` before its flush), the wipe runs right along the back (`G1 X70` to `X165`).
 * - H2S: the H2 family's chute (`M620.14 X95.5 Y336` in the H2C template) and the same exit moves as the H2D.
 * The P2S's change hands everything to the firmware (`G150` macros) and writes no position, so it has none here.
 */
function swapChute(id: string, bed: Bed): NonNullable<ToolChangerSpec['chute']> | null {
  if (id.startsWith('bambu-a1-mini')) return { x: -13.5, y: 90, exitY: [], exit: 'right', frame: true, cut: [180, null], exits: [[-3.5, 90], [-13.5, 90], [-3.5, 90]], mouth: { x: [-17, 17], y: [-8, 18] } }
  if (id.startsWith('bambu-a1')) return { x: -48.2, y: 128, exitY: [], exit: 'right', frame: true, cut: [267, null], exits: [[-38.2, 128], [-48.2, 128], [-38.2, 128]] }
  if (/^bambu-(x1|p1p|p1s)/.test(id)) return { x: 54, y: 265, exitY: [], exit: 'right', cut: [70, 265], exits: [[70, 265], [100, 265], [165, 265], [165, 256]], mouth: { x: [-5.7, 26], y: [-12, 18] } }
  if (id.startsWith('bambu-h2s')) return { x: 95.5, y: bed.depthMm + 16, exitY: [bed.depthMm, bed.depthMm - 25, bed.depthMm - 55] }
  return null
}

/** The stops after a flush: the first takes the purge past the wiper. */
export function chuteExits(ch: NonNullable<ToolChangerSpec['chute']>): [number, number][] {
  return ch.exits ?? ch.exitY.map((y): [number, number] => [ch.x, y])
}

/**
 * The tool changer of a printer, or null when it has one nozzle (an AMS swap stays where the head is).
 * `printerId` is the profile id (for example `bambu-h2c`); the settings carry the speeds and times.
 */
export function toolChangerSpec(printerId: string | undefined, cfg: Settings, bed: Bed, tools: number): ToolChangerSpec | null {
  const kind = kindOf(printerId, cfg)
  if (!kind) return null
  const travelSpeed = num(cfg['travel_speed'], 500)
  const travelAccel = num(cfg['machine_max_acceleration_travel'], 0) || num(cfg['travel_acceleration'], 0) || num(cfg['machine_max_acceleration_x'], 5000)
  const map = list(cfg['filament_map']).map((v) => Math.max(0, Math.round(v) - 1))
  const nozzles = Math.max(1, list(cfg['nozzle_diameter']).length)
  // A hotend rack whose settings map nothing to the rack's extruder (the profile default puts every
  // filament on the first) is taken to print everything from the rack: that is what the machine is for.
  const rackDefault = kind === 'hotend-rack' && !map.some((e) => e > 0) ? nozzles - 1 : 0
  const extruderOf = Array.from({ length: Math.max(1, tools) }, (_, t) => Math.min(nozzles - 1, map[t] ?? (kind === 'tool-rack' || kind === 'xl-dock' || kind === 'lift-switch' ? t : rackDefault)))
  const sw = cfg['machine_tool_change_time'] !== undefined ? num(cfg['machine_tool_change_time'], 0) : num(cfg['machine_switch_extruder_time'], 0)
  const base: ToolChangerSpec = {
    kind,
    bed,
    tools: Math.max(1, tools),
    extruderOf,
    travel: { speed: Math.max(50, travelSpeed), accel: Math.max(500, travelAccel) },
    z: { speed: Math.max(5, num(cfg['machine_max_speed_z'], 20)), accel: Math.max(50, num(cfg['machine_max_acceleration_z'], 500)) },
    dock: { speed: 60, accel: 2000 },
    liftMm: 3,
    ...(String(Array.isArray(cfg['change_filament_gcode']) ? cfg['change_filament_gcode'][0] : (cfg['change_filament_gcode'] ?? '')).includes('max_layer_z') ? { liftOverPrint: true } : {}),
    seconds: { switch: Math.max(0, sw), load: Math.max(0, num(cfg['machine_load_filament_time'], 0)), unload: Math.max(0, num(cfg['machine_unload_filament_time'], 0)) },
  }
  if (kind === 'dual-nozzle' || kind === 'hotend-rack') {
    // The chute's position is the profile's fallback purge position (`M620.14 X95.5 Y336`); the exit
    // stops are the `G1 Y320`, `Y295`, `Y265` moves of the change G-code (measured).
    base.chute = { x: 95.5, y: bed.depthMm + 16, exitY: [bed.depthMm, bed.depthMm - 25, bed.depthMm - 55] }
    base.nozzles = { spacing: 24, liftMm: 2.5 }
  }
  if (kind === 'filament-swap') base.chute = swapChute(printerId ?? '', bed)!
  if (kind === 'hotend-rack') {
    // Rack geometry is estimated: the strip right of the right nozzle's reach (X 330 of 350), three
    // positions in the rear half, the upper row 96 mm up. The rack stands 22 mm past the bed so a hotend
    // printing at the right edge clears the parked ones, the upper row clears the toolhead's cover, and the
    // head waits 28 mm from a position (approachX) so the rows can move past it while it waits.
    base.rack = { x: bed.widthMm + 22, ys: [150, 210, 270].map((y) => Math.min(y, bed.depthMm - 20)), rowRise: 96, approachX: 28, latchY: 6, slots: 6 }
  }
  if (kind === 'xl-dock') {
    // Prusa-Firmware-Buddy (toolchanger_utils.h): DOCK_DEFAULT_FIRST_X_MM 25, DOCK_OFFSET_X_MM 82,
    // DOCK_DEFAULT_Y_MM 455, SAFE_Y_WITH_TOOL 360, SAFE_Y_WITHOUT_TOOL 425, PARK_X_OFFSET_1..3 -10, -9, +0.5,
    // PICK_Y_OFFSET -5, PICK_X_OFFSET_1..3 -11.8, -12.8, -9.9, SLOW_MOVE_MM_S 50, SLOW_ACCELERATION_MM_S2 400,
    // PARKING_FINAL_MAX_SPEED 300, TRAVEL_MOVE_MM_S 400, WAIT_TIME_TOOL_PARKED_PICKED 200 ms. The change
    // G-code lifts Z by 2 mm (`position[2] + 2.0`, `M217 Z2`) and moves at 350 mm/s at most.
    const n = Math.max(2, nozzles)
    base.xl = {
      x: Array.from({ length: n }, (_, i) => 25 + 82 * i),
      y: 455,
      safeWith: 360,
      safeWithout: 425,
      park: { approachX: -10, unlockX: -9, seatX: 0.5 },
      pick: { preY: -5, lockX: -11.8, lockedX: -12.8, clearX: -9.9 },
      slow: { speed: 50, accel: 400 },
      approach: { speed: 300, accel: base.travel.accel },
      sense: 0.2,
    }
    base.travel = { speed: Math.min(base.travel.speed, 350), accel: base.travel.accel }
    base.liftMm = 2
  }
  if (kind === 'lift-switch') {
    // UltiMaker S series, from the profile (Cura's definitions): the nozzle offsets, the switching positions,
    // the switch retraction and the lift after it. The lowered right nozzle sits 1.5 mm under the left one
    // (`machine_nozzle_head_distance` 4.2 and 2.7). Estimated: the 3 mm stroke of the lift switch, the 10 mm
    // the firmware runs into the bay and its lever speed.
    const pts = points(cfg['extruder_offset'])
    const park = points(cfg['toolchange_park_position'])
    const n = Math.max(2, nozzles)
    const offsets = Array.from({ length: n }, (_, i): [number, number] => pts[i] ?? (i === 1 ? [22, 0] : [0, 0]))
    const parks = Array.from({ length: n }, (_, i): [number, number] => park[i] ?? park[0] ?? [bed.widthMm, bed.depthMm - 3])
    // Where the two cores' positions differ (S5, S7, S6, S8) they are the ends of the lever's run along the bay. The
    // S3 gets one position for both (X 180, Y 180), so its bay is put where the S5's is on its frame: on the right
    // wall at the bed's right edge, 3 and 21 mm in from the back (estimated; the UltiMaker 3, the S3's
    // predecessor, has its two positions at the right edge as well, X 213, Y 207 and 189).
    const apart = parks.some((p) => Math.abs(p[1] - (parks[0]?.[1] ?? 0)) > 1)
    const bayAt = apart ? parks : parks.map((_, i): [number, number] => [bed.widthMm, bed.depthMm - (i > 0 ? 21 : 3)])
    const at = (k: string, i: number, fallback: number) => list(cfg[k])[i] ?? list(cfg[k])[0] ?? fallback
    const length = at('retraction_length', 0, 6.5)
    const speed = at('retraction_speed', 0, 45)
    const extra = Math.max(0, at('retract_length_toolchange', 0, length) - length)
    const extraSpeed = at('retract_speed_toolchange', 0, 20) || 20
    base.lift = {
      offsets,
      park: parks,
      lowered: 1.5,
      stroke: 3,
      bayIn: 10,
      lever: { speed: 50, accel: 1000 },
      retract: length / Math.max(1, speed) + extra / Math.max(1, extraSpeed),
      bayAt,
    }
    base.liftMm = at('retract_lift_toolchange', 0, at('z_hop', 0, 2))
    const zSpeed = num(cfg['travel_speed_z'], 0)
    if (zSpeed > 0) base.z = { speed: zSpeed, accel: base.z.accel }
  }
  if (kind === 'tool-rack') {
    // Snapmaker U1 printer.cfg: xy_park_position per extruder, y_idle_position, horizontal_move_x,
    // retract_x_dist, insertion_buffer_dist, fast_move_speed, slow_move_speed, grab_speed, switch_accel.
    const n = Math.max(2, nozzles)
    const xs = n === 4 ? [35.0, 102.7, 170.2, 237.7] : Array.from({ length: n }, (_, i) => ((i + 0.5) * bed.widthMm) / n)
    base.docks = { x: xs, y: bed.depthMm + 61.2, idleY: Math.min(250, bed.depthMm - 20), strokeX: 10, retractX: 1.5, bufferMm: 5, grab: { speed: 10, accel: 2000 }, slow: { speed: 60, accel: 5000 } }
    base.travel = { speed: Math.min(base.travel.speed, 400), accel: Math.min(base.travel.accel, 5000) }
    base.liftMm = 3.5
    base.z = { speed: 10, accel: base.z.accel }
  }
  return base
}

/**
 * The seconds a printer spends on each change beyond its moves, kept across the print as the engine
 * keeps them (`packages/core/src/gcode.rs`, `ChangeClock`): a change to another filament on the same
 * extruder costs an unload and a load; a change to another extruder costs the switch plus a load when
 * that extruder is empty, or an unload and a load when it last held a different filament. The first
 * unload of the print is free.
 */
export class ChangeClock {
  private extruder: number | null = null
  private readonly held: (number | null)[]
  private unloaded = true

  constructor(private readonly spec: Pick<ToolChangerSpec, 'extruderOf' | 'seconds'>, extruders: number) {
    this.held = Array.from({ length: Math.max(1, extruders) }, () => null)
  }

  private extruderOf(tool: number): number {
    return Math.min(this.held.length - 1, this.spec.extruderOf[tool] ?? 0)
  }

  change(next: number): number {
    const e = this.extruderOf(next)
    const prev = this.extruder
    if (prev !== null && this.held[prev] === next) return 0
    let t = 0
    const load = (unloadFirst: boolean) => {
      if (unloadFirst && !this.unloaded) t += this.spec.seconds.unload
      this.unloaded = false
      t += this.spec.seconds.load
      this.held[e] = next
    }
    if (prev === e) load(true)
    else if (prev === null) {
      this.extruder = e
      load(false)
    } else {
      this.extruder = e
      const f = this.held[e]
      if (f === null) load(false)
      else if (f !== next) load(true)
      t += this.spec.seconds.switch
    }
    return t
  }
}

// ---------- motion ----------

export interface Phase {
  name: string
  from: V3
  to: V3
  /** Seconds the move takes (0 for a dwell). */
  move: number
  /** Seconds the head stays at `to` after the move. */
  dwell: number
  limits: MotionLimits
  /** Start time within the change. */
  t0: number
  /** The tool in the head during this phase, or null when the bay is empty. */
  carried: number | null
  /** Where the head holds the carried tool: 0 the left nozzle down, 1 the right (dual-nozzle, hotend-rack); the slot it is at (tool-rack). */
  state: number
  /** H2C: the rack row at the head's height once this phase ends. */
  row: number
}

export interface ChangeSequence {
  from: number
  to: number
  duration: number
  phases: Phase[]
  /** For racks: which tool each slot holds before the change (-1 empty, `SPARE` a hotend the print does not use). */
  slotsBefore: number[]
  slotsAfter: number[]
  /** The rack row at the head's height before and after (H2C). */
  rowBefore: number
  rowAfter: number
}

export interface Pose {
  x: number
  y: number
  z: number
  carried: number | null
  /** 0 to 1: the left nozzle down to the right nozzle down (dual-nozzle); unused elsewhere. */
  lift: number
  /** 0 to 1: the latch or lock engaged (shown while a rack holds or releases a tool). */
  latch: number
  /** Rack row at head height, interpolated (H2C). */
  row: number
  /** Which tool each rack slot holds right now (-1 empty, `SPARE` a hotend the print does not use). */
  slots: number[]
  phase: string
}

/** Seconds a move of `d` mm takes with a trapezoidal profile from rest to rest. */
export function moveTime(d: number, l: MotionLimits): number {
  if (d <= 1e-9) return 0
  const dAccel = (l.speed * l.speed) / l.accel
  return d >= dAccel ? d / l.speed + l.speed / l.accel : 2 * Math.sqrt(d / l.accel)
}

/** Distance covered after `t` seconds of a trapezoidal move of `d` mm. */
export function moveDistance(d: number, l: MotionLimits, t: number): number {
  if (d <= 1e-9 || t <= 0) return 0
  const dAccel = (l.speed * l.speed) / l.accel
  if (d >= dAccel) {
    const ta = l.speed / l.accel
    const tc = d / l.speed - ta
    if (t < ta) return 0.5 * l.accel * t * t
    if (t < ta + tc) return 0.5 * l.speed * ta + l.speed * (t - ta)
    const te = Math.min(ta, t - ta - tc)
    return d - 0.5 * l.accel * (ta - te) * (ta - te)
  }
  const half = Math.sqrt(d / l.accel)
  if (t < half) return 0.5 * l.accel * t * t
  const te = Math.min(half, t - half)
  return d - 0.5 * l.accel * (half - te) * (half - te)
}

const dist = (a: V3, b: V3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])

class Builder {
  phases: Phase[] = []
  t = 0
  private rowNow = 0
  constructor(public pos: V3, private carried: number | null, private state: number) {}

  moveTo(name: string, to: V3, limits: MotionLimits, dwell = 0): this {
    const d = dist(this.pos, to)
    const move = moveTime(d, limits)
    this.phases.push({ name, from: this.pos, to, move, dwell, limits, t0: this.t, carried: this.carried, state: this.state, row: this.rowNow })
    this.t += move + dwell
    this.pos = to
    return this
  }

  dwell(name: string, seconds: number): this {
    if (seconds <= 0) return this
    this.phases.push({ name, from: this.pos, to: this.pos, move: 0, dwell: seconds, limits: { speed: 1, accel: 1 }, t0: this.t, carried: this.carried, state: this.state, row: this.rowNow })
    this.t += seconds
    return this
  }

  carry(tool: number | null): this {
    this.carried = tool
    return this
  }

  at(state: number): this {
    this.state = state
    return this
  }

  /** The rack row at the head's height from the next phase on (H2C). */
  row(r: number): this {
    this.rowNow = r
    return this
  }
}

/** A rack position holding a hotend the print does not use. */
export const SPARE = -2

/**
 * The rack at the start of the print (hotend-rack): tools on the rack extruder take positions in tool order and
 * the first of them starts in the head. The machine has a hotend for every position but one (wiki: six hotends,
 * five on the rack while one is on the toolhead), so the position after the print's own is the empty one and
 * the rest hold spare hotends.
 */
function rackSlots(spec: ToolChangerSpec): { slots: number[]; inHead: number | null } {
  const n = spec.rack?.slots ?? 6
  const slots = Array.from({ length: n }, () => SPARE)
  const rackExtruder = Math.max(...spec.extruderOf, 0)
  const onRack = Array.from({ length: spec.tools }, (_, t) => t).filter((t) => spec.extruderOf[t] === rackExtruder)
  const [inHead, ...rest] = onRack
  rest.forEach((t, i) => {
    if (i < n) slots[i] = t
  })
  if (rest.length < n) slots[rest.length] = -1
  return { slots, inHead: inHead ?? null }
}

/** The rack slot a tool sits in before a change. Preceding changes moved tools around; `history` replays them. */
export function rackStateBefore(spec: ToolChangerSpec, history: readonly [number, number][]): { slots: number[]; inHead: number | null; row: number } {
  const s = rackSlots(spec)
  let row = 0
  let inHead = s.inHead
  for (const [from, to] of history) {
    const seq = hotendPlan(spec, from, to, s.slots, inHead, row)
    if (!seq) continue
    s.slots.splice(0, s.slots.length, ...seq.slotsAfter)
    inHead = seq.inHeadAfter
    row = seq.rowAfter
  }
  return { slots: s.slots, inHead, row }
}

interface HotendPlan {
  parkSlot: number
  pickSlot: number
  slotsAfter: number[]
  inHeadAfter: number | null
  rowAfter: number
}

function hotendPlan(spec: ToolChangerSpec, from: number, to: number, slots: number[], inHead: number | null, row: number): HotendPlan | null {
  const rackExtruder = Math.max(...spec.extruderOf, 0)
  if (spec.extruderOf[to] !== rackExtruder || inHead === to) return null
  const pickSlot = slots.indexOf(to)
  if (pickSlot < 0) return null
  // The firmware parks in the lowest numbered empty position (wiki: the one closest to the toolhead).
  const parkSlot = inHead === null ? -1 : slots.indexOf(-1)
  const after = slots.slice()
  if (parkSlot >= 0 && inHead !== null) after[parkSlot] = inHead
  after[pickSlot] = -1
  void from
  return { parkSlot, pickSlot, slotsAfter: after, inHeadAfter: to, rowAfter: Math.floor(pickSlot / 3) }
}

const printedTops = new WeakMap<PreviewBuffers, Float32Array>()

/** The highest layer top printed up to the layer of `segment` (the G-code's `max_layer_z` there), mm. */
export function printedTop(b: PreviewBuffers, segment: number): number {
  let tops = printedTops.get(b)
  if (!tops) {
    tops = new Float32Array(b.layerCount)
    let m = 0
    for (let l = 0; l < b.layerCount; l++) tops[l] = m = Math.max(m, b.layerZ[l] ?? 0)
    printedTops.set(b, tops)
  }
  let lo = 0
  let hi = b.layerCount - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((b.layerStart[mid] ?? 0) <= segment) lo = mid
    else hi = mid - 1
  }
  return tops[lo] ?? 0
}

/**
 * The sequence of one change from tool `from` to tool `to`, starting with the nozzle at `at` (the end
 * of the last move before the change) and ending at `resume` (the start of the first move after it).
 * `fixed` is the firmware's seconds for this change (`ChangeClock.change`). `history` lists the
 * changes before this one (racks keep state across changes). `printed` is the highest layer printed so far, which a
 * change G-code that lifts over `max_layer_z` clears.
 */
export function changeSequence(spec: ToolChangerSpec, from: number, to: number, at: V3, resume: V3, fixed: number, history: readonly [number, number][] = [], printed = 0): ChangeSequence {
  const top = Math.max(at[2], resume[2], spec.liftOverPrint ? printed : 0)
  const up = top + spec.liftMm
  const lifted: V3 = [at[0], at[1], up]
  const back: V3 = [resume[0], resume[1], up]
  const empty: number[] = []
  const firm = Math.max(fixed, 0.8)
  if (spec.kind === 'dual-nozzle') {
    const ch = spec.chute!
    const side = (t: number) => (spec.extruderOf[t] ?? 0) > 0 ? 1 : 0
    const b = new Builder(at, from, side(from))
    b.moveTo('lift', lifted, spec.z)
    b.moveTo('to chute', [ch.x, ch.y, up], spec.travel)
    // Cut and retract, then the nozzles trade places, then load and flush, in the profile's time.
    b.dwell('cut', firm * 0.25)
    b.at(side(to)).carry(to).dwell('switch', firm * 0.2)
    b.dwell('load', firm * 0.55)
    const speeds = [spec.travel, spec.travel, { speed: Math.min(300, spec.travel.speed), accel: spec.travel.accel }]
    ch.exitY.forEach((y, i) => b.moveTo(i === 0 ? 'wipe' : 'exit', [ch.x, y, up], speeds[i] ?? spec.travel))
    b.moveTo('return', back, spec.travel)
    b.moveTo('lower', resume, { speed: Math.min(50, spec.z.speed * 2.5), accel: spec.z.accel })
    return { from, to, duration: b.t, phases: b.phases, slotsBefore: empty, slotsAfter: empty, rowBefore: 0, rowAfter: 0 }
  }
  if (spec.kind === 'hotend-rack') {
    const ch = spec.chute!
    const rack = spec.rack!
    const st = rackStateBefore(spec, history)
    const plan = hotendPlan(spec, from, to, st.slots, st.inHead, st.row)
    const side = (t: number) => (spec.extruderOf[t] ?? 0) > 0 ? 1 : 0
    const b = new Builder(at, st.inHead, side(from)).row(st.row)
    b.moveTo('lift', lifted, spec.z)
    b.moveTo('to chute', [ch.x, ch.y, up], spec.travel)
    const swapShare = plan ? 0.3 : 0.45
    b.dwell('cut', firm * swapShare)
    if (plan) {
      const slotPos = (k: number): V3 => [rack.x, rack.ys[k % 3] ?? rack.ys[0]!, up]
      // Park the hotend in the bay: slide into the rack from the left, unlatch, leave forward.
      if (plan.parkSlot >= 0 && st.inHead !== null) {
        const p = slotPos(plan.parkSlot)
        const row = Math.floor(plan.parkSlot / 3)
        b.moveTo('to rack', [p[0] - rack.approachX, p[1], up], spec.travel)
        if (row !== st.row) b.row(row).dwell('rack lifts', 0.9)
        b.moveTo('dock', p, spec.dock, 0.25)
        b.carry(null).moveTo('unlatch', [p[0], p[1] - rack.latchY, up], spec.dock, 0.15)
        b.moveTo('leave', [p[0] - rack.approachX, p[1] - rack.latchY, up], spec.dock)
      }
      // Pick the next one: back off along the front of the rack, in front of its slot, push in from the
      // front, latch, pull out to the left. The detour keeps the head off the hotend it just parked.
      const q = slotPos(plan.pickSlot)
      const row = Math.floor(plan.pickSlot / 3)
      b.moveTo('along', [q[0] - rack.approachX, q[1] - rack.approachX, up], spec.travel)
      b.moveTo('to slot', [q[0], q[1] - rack.approachX, up], spec.dock)
      const current = plan.parkSlot >= 0 && st.inHead !== null ? Math.floor(plan.parkSlot / 3) : st.row
      if (row !== current) b.row(row).dwell('rack lifts', 0.9)
      b.moveTo('engage', q, spec.dock, 0.15)
      b.carry(to).dwell('latch', 0.25)
      b.moveTo('pull out', [q[0] - rack.approachX, q[1], up], spec.dock)
      b.moveTo('to chute', [ch.x, ch.y, up], spec.travel)
    } else {
      b.at(side(to)).carry(st.inHead).dwell('switch', firm * 0.1)
    }
    b.dwell('load', firm * (plan ? 0.7 : 0.45))
    const speeds = [spec.travel, spec.travel, { speed: Math.min(300, spec.travel.speed), accel: spec.travel.accel }]
    ch.exitY.forEach((y, i) => b.moveTo(i === 0 ? 'wipe' : 'exit', [ch.x, y, up], speeds[i] ?? spec.travel))
    b.moveTo('return', back, spec.travel)
    b.moveTo('lower', resume, { speed: Math.min(50, spec.z.speed * 2.5), accel: spec.z.accel })
    return {
      from,
      to,
      duration: b.t,
      phases: b.phases,
      slotsBefore: st.slots,
      slotsAfter: plan ? plan.slotsAfter : st.slots,
      rowBefore: st.row,
      rowAfter: plan ? plan.rowAfter : st.row,
    }
  }
  if (spec.kind === 'xl-dock') {
    // Prusa-Firmware-Buddy toolchanger_xl.cpp, park() then pickup(): to the front of the dock, in, sideways into
    // the dock's pins, back out without the tool; to the next dock, in, sideways out of its pins with the tool,
    // back out, return. The firmware waits for the dock's sensor after each seat.
    const k = spec.xl!
    const xOf = (t: number) => k.x[t] ?? k.x[k.x.length - 1] ?? 0
    const slots = Array.from({ length: k.x.length }, (_, i) => (i === from ? -1 : i))
    const a = xOf(from)
    const c = xOf(to)
    const b = new Builder(at, from, from)
    b.moveTo('lift', lifted, spec.z)
    b.moveTo('to dock', [a + k.park.approachX, k.safeWith, up], spec.travel)
    b.moveTo('approach', [a + k.park.approachX, k.y, up], k.approach)
    b.moveTo('unlock', [a + k.park.unlockX, k.y, up], k.slow)
    b.moveTo('seat', [a + k.park.seatX, k.y, up], k.slow)
    b.moveTo('park', [a, k.y, up], k.slow, k.sense)
    b.carry(null).at(-1).moveTo('pull back', [a, k.safeWithout, up], spec.travel)
    b.moveTo('to next', [c, k.safeWithout, up], spec.travel)
    b.moveTo('insert', [c, k.y + k.pick.preY, up], spec.travel)
    b.moveTo('seat', [c, k.y, up], k.slow, k.sense)
    b.carry(to).at(to).moveTo('lock', [c + k.pick.lockX, k.y, up], k.slow)
    b.moveTo('lock', [c + k.pick.lockedX, k.y, up], k.slow)
    b.moveTo('clear', [c + k.pick.clearX, k.y, up], k.slow)
    b.moveTo('extract', [c + k.pick.clearX, k.safeWith, up], spec.travel)
    b.dwell('heat', firm)
    b.moveTo('return', back, spec.travel)
    b.moveTo('lower', resume, spec.z)
    const after = slots.slice()
    after[from] = from
    after[to] = -1
    return { from, to, duration: b.t, phases: b.phases, slotsBefore: slots, slotsAfter: after, rowBefore: 0, rowAfter: 0 }
  }
  if (spec.kind === 'lift-switch') return liftSwitch(spec, from, to, at, resume, firm)
  if (spec.kind === 'filament-swap') {
    // To the cutter (or cut at the chute), then the chute: the firmware unloads, the AMS feeds the next filament,
    // the nozzle flushes; then over the wiper and out.
    const ch = spec.chute!
    const b = new Builder(at, from, 0)
    b.moveTo('lift', lifted, spec.z)
    if (ch.cut) b.moveTo('to cutter', [ch.cut[0], ch.cut[1] ?? at[1], up], spec.travel)
    else b.moveTo('to chute', [ch.x, ch.y, up], spec.travel)
    b.dwell('cut', firm * 0.15)
    if (ch.cut) b.moveTo('to chute', [ch.x, ch.y, up], spec.travel)
    b.carry(to).dwell('load', firm * 0.85)
    const speeds = [spec.travel, spec.travel, { speed: Math.min(300, spec.travel.speed), accel: spec.travel.accel }]
    chuteExits(ch).forEach(([x, y], i) => b.moveTo(i === 0 ? 'wipe' : 'exit', [x, y, up], speeds[i] ?? spec.travel))
    b.moveTo('return', back, spec.travel)
    b.moveTo('lower', resume, { speed: Math.min(50, spec.z.speed * 2.5), accel: spec.z.accel })
    return { from, to, duration: b.t, phases: b.phases, slotsBefore: empty, slotsAfter: empty, rowBefore: 0, rowAfter: 0 }
  }
  // tool-rack
  const d = spec.docks!
  const xOf = (t: number) => d.x[t] ?? d.x[d.x.length - 1] ?? 0
  const slots = Array.from({ length: d.x.length }, (_, i) => (i === from ? -1 : i))
  const b = new Builder(at, from, from)
  b.moveTo('lift', lifted, spec.z)
  // Park: in front of the slot, push in fast then slow for the last millimeters, release sideways, back out.
  b.moveTo('to dock', [xOf(from), d.idleY, up], spec.travel)
  b.moveTo('push in', [xOf(from), d.y - d.bufferMm, up], d.slow.speed > spec.travel.speed ? spec.travel : { speed: spec.travel.speed, accel: d.slow.accel })
  b.moveTo('seat', [xOf(from), d.y, up], d.slow, 0.1)
  b.moveTo('release', [xOf(from) + d.strokeX, d.y, up], d.grab)
  b.carry(null).at(-1).dwell('released', Math.min(1, firm * 0.2))
  b.moveTo('back out', [xOf(from) + d.strokeX, d.y - d.bufferMm, up], d.slow)
  // Pick: beside the next slot, in, grab sideways, settle, out.
  b.moveTo('to next', [xOf(to) + d.strokeX, d.idleY, up], spec.travel)
  b.moveTo('push in', [xOf(to) + d.strokeX, d.y - d.bufferMm, up], { speed: spec.travel.speed, accel: d.slow.accel })
  b.moveTo('seat', [xOf(to) + d.strokeX, d.y, up], d.slow)
  b.moveTo('grab', [xOf(to), d.y, up], d.grab)
  b.carry(to).at(to).moveTo('settle', [xOf(to) + d.retractX, d.y, up], d.slow, Math.max(0.2, firm * 0.8))
  b.moveTo('pull out', [xOf(to) + d.retractX, d.idleY, up], d.slow.speed < spec.travel.speed ? { speed: spec.travel.speed, accel: d.slow.accel } : spec.travel)
  b.moveTo('return', back, spec.travel)
  b.moveTo('lower', resume, spec.z)
  const after = slots.slice()
  after[from] = from
  after[to] = -1
  return { from, to, duration: b.t, phases: b.phases, slotsBefore: slots, slotsAfter: after, rowBefore: 0, rowAfter: 0 }
}

/**
 * UltiMaker S: the head (the left nozzle's position, as the G-code writes it) retracts, goes to the leaving core's
 * switching position and lifts (the moves the slicer writes), the firmware runs the lever into the switch bay,
 * along it to the other core's switching position, which lowers or lifts the right core, and back out, waits
 * for the new core's temperature, and the head returns to the next move and comes down. Pose state 1 is the
 * right core lowered.
 */
function liftSwitch(spec: ToolChangerSpec, from: number, to: number, at: V3, resume: V3, firm: number): ChangeSequence {
  const k = spec.lift!
  const side = (t: number) => ((spec.extruderOf[t] ?? 0) > 0 ? 1 : 0)
  const off = (t: number) => k.offsets[spec.extruderOf[t] ?? 0] ?? [0, 0]
  const park = (t: number) => k.park[spec.extruderOf[t] ?? 0] ?? k.park[0] ?? [0, 0]
  // The left nozzle stands the lowered right one's depth higher while the right core prints.
  const head = (p: V3, t: number): V3 => [p[0] - off(t)[0], p[1] - off(t)[1], p[2] + side(t) * k.lowered]
  const start = head(at, from)
  const end = head(resume, to)
  // The lift is written in G-code Z (the layer plus the hop); the firmware applies each core's Z offset, so the
  // head stands the lowered core's depth higher once the right core prints.
  const gz = Math.max(at[2], resume[2]) + spec.liftMm
  const upFrom = gz + side(from) * k.lowered
  const upTo = gz + side(to) * k.lowered
  const [ax, ay] = park(from)
  const bayAt = (t: number) => k.bayAt[spec.extruderOf[t] ?? 0] ?? k.bayAt[0] ?? park(t)
  const [cx, cy] = bayAt(from)
  const [bx, by] = bayAt(to)
  const b = new Builder(start, from, side(from))
  b.dwell('retract', k.retract)
  b.moveTo('to switch', [ax, ay, start[2]], spec.travel)
  b.moveTo('lift', [ax, ay, upFrom], spec.z)
  if (side(from) !== side(to)) {
    // The S3's switching position is not at its bay: the firmware takes the head there first.
    if (Math.hypot(cx - ax, cy - ay) > 1e-6) b.moveTo('to bay', [cx, cy, upFrom], spec.travel)
    b.moveTo('into bay', [cx + k.bayIn, cy, upFrom], k.lever)
    b.at(side(to)).carry(to).moveTo('switch', [bx + k.bayIn, by, upTo], k.lever)
    b.moveTo('out of bay', [bx, by, upTo], k.lever)
  } else {
    b.at(side(to)).carry(to).dwell('switch', moveTime(k.stroke, k.lever) + 0.3)
    if (upTo !== upFrom) b.moveTo('offset', [ax, ay, upTo], spec.z)
  }
  b.dwell('heat', firm)
  b.moveTo('return', [end[0], end[1], upTo], spec.travel)
  b.moveTo('lower', end, spec.z)
  return { from, to, duration: b.t, phases: b.phases, slotsBefore: [], slotsAfter: [], rowBefore: 0, rowAfter: 0 }
}

const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u))

/** The head's pose `t` seconds into a change. Before 0 it is the start pose, past the end the final one. */
export function poseAt(seq: ChangeSequence, t: number): Pose {
  const phases = seq.phases
  const first = phases[0]
  const last = phases[phases.length - 1]
  const slots = (phase: Phase | undefined): number[] => {
    if (!seq.slotsBefore.length) return seq.slotsBefore
    const idx = phase ? phases.indexOf(phase) : phases.length
    const released = phases.findIndex((p) => p.carried === null)
    const picked = phases.findIndex((p, i) => i > released && p.carried !== null)
    if (released < 0) return seq.slotsAfter
    if (idx < released) return seq.slotsBefore
    if (picked >= 0 && idx >= picked) return seq.slotsAfter
    // Between release and pick: the parked tool is in its slot and the next one still in its own.
    const mid = seq.slotsAfter.slice()
    const next = seq.to
    const was = seq.slotsBefore.indexOf(next)
    if (was >= 0) mid[was] = next
    return mid
  }
  if (!first || !last) return { x: 0, y: 0, z: 0, carried: null, lift: 0, latch: 1, row: 0, slots: seq.slotsBefore, phase: '' }
  if (t <= 0) return { x: first.from[0], y: first.from[1], z: first.from[2], carried: first.carried, lift: first.state, latch: 1, row: seq.rowBefore, slots: seq.slotsBefore, phase: first.name }
  if (t >= seq.duration) return { x: last.to[0], y: last.to[1], z: last.to[2], carried: last.carried, lift: last.state, latch: 1, row: seq.rowAfter, slots: seq.slotsAfter, phase: last.name }
  let lo = 0
  let hi = phases.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((phases[mid]?.t0 ?? 0) <= t) lo = mid
    else hi = mid - 1
  }
  const p = phases[lo]!
  const local = t - p.t0
  const d = dist(p.from, p.to)
  const s = p.move > 0 ? Math.min(1, moveDistance(d, p.limits, Math.min(local, p.move)) / Math.max(d, 1e-9)) : 1
  const x = p.from[0] + (p.to[0] - p.from[0]) * s
  const y = p.from[1] + (p.to[1] - p.from[1]) * s
  const z = p.from[2] + (p.to[2] - p.from[2]) * s
  // The lift (dual nozzle) and the rack row glide to the new state over the dwell that changes them.
  const prev = phases[lo - 1]
  // A state change on a move (the lift switch run along the bay) follows the move itself.
  const u = p.dwell > 0 ? smooth((local - p.move) / p.dwell) : p.move > 0 ? s : 1
  // The rack row is its own state, so a row change never moves the nozzle the head prints with.
  const lift = prev && prev.state !== p.state ? prev.state + (p.state - prev.state) * u : p.state
  const row = prev && prev.row !== p.row ? prev.row + (p.row - prev.row) * u : p.row
  const latch = p.name === 'unlatch' ? 1 - u : p.name === 'latch' ? u : p.name === 'release' ? 1 - s : p.name === 'grab' ? s : p.carried === null ? 0 : 1
  return { x, y, z, carried: p.carried, lift, latch, row, slots: slots(p), phase: p.name }
}
