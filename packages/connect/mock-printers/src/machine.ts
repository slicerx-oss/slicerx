// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One fake printer: the state machine every protocol adapter sits on. The camera frame, the faults and
// the job tick here are shared by the brands; what a fault looks like on the wire is each adapter's.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { DemoFleet, FleetPrinterFixture, PrinterState } from '@slicerx/contracts'
import { HAND_FRAME } from './frames.ts'

/** `modified` is seconds since the epoch, as Moonraker reports it. */
export interface StoredFile { name: string; size: number; sha256: string; modified: number }

/** What the camera shows: the tiny placeholder, the hand reaching in (`HAND_FRAME`), or a JPEG file read for each frame. */
export type CameraFrame = 'placeholder' | 'hand' | { file: string }

/** A fault a test injects (`POST /fault`): filament runs out, the door opens, the printer drops off the network. */
export type Fault = 'runout' | 'door' | 'offline'

/**
 * What the faults do on one brand, set by its adapter. `runoutMessage` is the message a runout leaves on the
 * machine (none: the brand reports it some other way, as a flag). `door: false` means the brand reports no door,
 * so a door fault is only logged.
 */
export interface FaultProfile { runoutMessage?: string; door: boolean }

export class MockError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export class MockMachine {
  readonly fx: FleetPrinterFixture
  state: PrinterState
  job: { name: string; progress: number; layer: number; layerCount: number; timeLeftS: number } | undefined
  message: string | undefined
  readonly files = new Map<string, StoredFile>()
  /** The objects the running G-code labels, as Klipper's EXCLUDE_OBJECT sees them. */
  readonly objects = ['lid.stl_id_0_copy_0', 'base.stl_id_1_copy_0']
  readonly excluded = new Set<string>()
  /** Head position (X, Y, Z), homed axes and the axis range, as Klipper's toolhead reports them. */
  position: [number, number, number] = [100, 100, 10]
  homed = 'xyz'
  readonly axisMin: [number, number, number] = [0, 0, 0]
  readonly axisMax: [number, number, number] = [220, 220, 250]
  relative = false
  /** How many `G90` lines to refuse next, to show a jog that cannot restore absolute mode. */
  failG90 = 0
  /** How long an upload takes before the file lands, in milliseconds (`/slow`), to race uploads and starts. */
  uploadDelayMs = 0
  /** When the running job started, seconds since the epoch. */
  startedAt = 0
  /** Finished and stopped prints, newest first, in Moonraker's history shape. */
  readonly history: { filename: string; status: string; start_time: number; total_duration: number; filament_used: number }[] = [
    { filename: 'earlier.gcode', status: 'completed', start_time: 1_700_000_000, total_duration: 5400, filament_used: 4200 },
  ]
  /** Every state changing request, as "kind detail". Tests read this through the control server. */
  readonly log: string[] = []
  /** What the camera sends (`POST /camera`). */
  camera: CameraFrame = 'placeholder'
  /** The faults in force (`POST /fault`). */
  readonly faults = new Set<Fault>()
  /** Set by adapters that take faults; without one, `POST /fault` is refused. */
  faultProfile: FaultProfile | undefined
  /** Seconds the running job has printed, advanced by the job tick. */
  printedS = 0
  private beforeOffline: PrinterState | undefined
  private ticker: ReturnType<typeof setInterval> | undefined
  private readonly listeners = new Set<() => void>()

  constructor(fixture: DemoFleet, printerId: string, override?: PrinterState) {
    const fx = fixture.printers.find((p) => p.id === printerId)
    if (!fx) throw new Error(`fixture has no ${printerId}`)
    this.fx = fx
    this.state = override ?? fx.state
    this.job = override && override !== fx.state ? undefined : fx.job ? { ...fx.job } : undefined
    this.message = override ? undefined : fx.message
  }

  upload(name: string, data: Uint8Array): StoredFile {
    if (this.state === 'offline') throw new MockError(503, 'offline')
    const f = { name, size: data.byteLength, sha256: createHash('sha256').update(data).digest('hex'), modified: Date.now() / 1000 }
    this.files.set(name, f)
    this.log.push(`upload ${name} ${f.size} ${f.sha256}`)
    return f
  }

  start(name: string): void {
    const f = this.files.get(name) ?? this.files.get(name.replace(/^(usb\/|0:\/gcodes\/|gcodes\/)/, ''))
    if (!f) throw new MockError(404, `no file ${name}`)
    if (this.state !== 'idle' && this.state !== 'finished' && this.state !== 'error') throw new MockError(409, `state ${this.state}`)
    this.state = 'printing'
    this.job = { name: f.name, progress: 0, layer: 0, layerCount: 100, timeLeftS: 3600 }
    this.excluded.clear()
    this.message = undefined
    this.startedAt = Math.floor(Date.now() / 1000)
    this.printedS = 0
    this.log.push(`start ${f.name}`)
    this.changed()
  }

  pause(): void {
    if (this.state !== 'printing') throw new MockError(409, `state ${this.state}`)
    this.state = 'paused'
    this.log.push('pause')
    this.changed()
  }

  resume(): void {
    if (this.state !== 'paused') throw new MockError(409, `state ${this.state}`)
    this.state = 'printing'
    this.message = undefined
    this.log.push('resume')
    this.changed()
  }

  cancel(): void {
    if (!['printing', 'paused', 'preparing'].includes(this.state)) throw new MockError(409, `state ${this.state}`)
    if (this.job) this.history.unshift({ filename: this.job.name, status: 'cancelled', start_time: Math.floor(Date.now() / 1000), total_duration: 60, filament_used: 100 })
    this.state = 'idle'
    this.job = undefined
    this.log.push('cancel')
    this.changed()
  }

  gcode(line: string): void {
    if (line === 'G90' && this.failG90 > 0) {
      this.failG90--
      throw new MockError(500, 'G90 refused')
    }
    if (line === 'G91') this.relative = true
    if (line === 'G90') this.relative = false
    const move = /^G[01] (.*)$/.exec(line)
    if (move) {
      for (const [, axis, v] of (move[1] ?? '').matchAll(/([XYZ])(-?[\d.]+)/g)) {
        const i = 'XYZ'.indexOf(axis!)
        this.position[i] = (this.relative ? this.position[i]! : 0) + Number(v)
      }
    }
    const skip = /^EXCLUDE_OBJECT NAME=(\S+)$/.exec(line)
    if (skip) {
      if (this.state !== 'printing' && this.state !== 'paused') throw new MockError(400, 'no print to exclude from')
      if (!this.objects.includes(skip[1]!)) throw new MockError(400, `unknown object ${skip[1]}`)
      this.excluded.add(skip[1]!)
    }
    this.log.push(`gcode ${line}`)
  }

  /** Calls `fn` after anything a status report shows has changed. Returns the unsubscribe. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Tells the adapters that what a status report shows has changed. */
  changed(): void {
    for (const fn of this.listeners) fn()
  }

  /** The JPEG the camera sends now. A file that cannot be read sends the placeholder. */
  frame(): Buffer {
    if (this.camera === 'hand') return HAND_FRAME
    if (typeof this.camera === 'object') {
      try {
        return readFileSync(this.camera.file)
      } catch {
        return JPEG
      }
    }
    return JPEG
  }

  setCamera(frame: CameraFrame): void {
    this.camera = frame
    this.log.push(`camera ${typeof frame === 'object' ? `file ${frame.file}` : frame}`)
    this.changed()
  }

  /**
   * Injects a fault, or clears them all. A runout pauses a running print, as a runout sensor does, and leaves
   * the brand's message; clearing it leaves the print paused for a resume, as on a printer. Offline remembers
   * the state, and clearing it brings that state back.
   */
  fault(kind: Fault | 'clear'): void {
    if (!this.faultProfile) throw new MockError(400, 'this mock takes no faults')
    this.log.push(`fault ${kind}`)
    if (kind === 'clear') {
      if (this.faults.has('offline')) this.state = this.beforeOffline ?? 'idle'
      if (this.faults.has('runout') && this.message === this.faultProfile.runoutMessage) this.message = undefined
      this.beforeOffline = undefined
      this.faults.clear()
    } else if (kind === 'runout') {
      this.faults.add('runout')
      if (this.state === 'printing') this.state = 'paused'
      if (this.faultProfile.runoutMessage !== undefined) this.message = this.faultProfile.runoutMessage
    } else if (kind === 'door') {
      // A brand without a door report only logs it.
      if (this.faultProfile.door) this.faults.add('door')
    } else if (!this.faults.has('offline')) {
      this.faults.add('offline')
      this.beforeOffline = this.state
      this.state = 'offline'
    }
    this.changed()
  }

  /**
   * Moves a printing job on by `seconds`: progress, layer and time left. The job finishes when no time is left.
   * Paused, idle and offline machines do not move.
   */
  tick(seconds: number): void {
    const j = this.job
    if (this.state !== 'printing' || !j || seconds <= 0) return
    const left = Math.max(0, j.timeLeftS - seconds)
    // Progress moves in step with the time: the share of the time left that has passed now.
    j.progress = j.timeLeftS > 0 ? j.progress + (1 - j.progress) * (Math.min(seconds, j.timeLeftS) / j.timeLeftS) : 1
    j.timeLeftS = left
    j.layer = Math.min(j.layerCount, Math.floor(j.progress * j.layerCount))
    this.printedS += seconds
    if (left === 0) {
      j.progress = 1
      j.layer = j.layerCount
      this.state = 'finished'
      this.log.push('finished')
    }
    this.changed()
  }

  /** Ticks the job every `everyMs` by `seconds` (0 stops it). Off unless a test or `--tick` asks for it. */
  autoTick(everyMs: number, seconds: number): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = undefined
    if (everyMs > 0) {
      this.ticker = setInterval(() => this.tick(seconds), everyMs)
      this.ticker.unref()
    }
  }
}

/** A tiny well formed JPEG: SOI, one APP0 segment, EOI. Enough for a size and magic byte check. */
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9])
