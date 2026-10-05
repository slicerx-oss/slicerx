// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One fake printer: the state machine every protocol adapter sits on.
import { createHash } from 'node:crypto'
import type { DemoFleet, FleetPrinterFixture, PrinterState } from '@slicerx/contracts'

/** `modified` is seconds since the epoch, as Moonraker reports it. */
export interface StoredFile { name: string; size: number; sha256: string; modified: number }

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
    this.log.push(`start ${f.name}`)
  }

  pause(): void {
    if (this.state !== 'printing') throw new MockError(409, `state ${this.state}`)
    this.state = 'paused'
    this.log.push('pause')
  }

  resume(): void {
    if (this.state !== 'paused') throw new MockError(409, `state ${this.state}`)
    this.state = 'printing'
    this.message = undefined
    this.log.push('resume')
  }

  cancel(): void {
    if (!['printing', 'paused', 'preparing'].includes(this.state)) throw new MockError(409, `state ${this.state}`)
    if (this.job) this.history.unshift({ filename: this.job.name, status: 'cancelled', start_time: Math.floor(Date.now() / 1000), total_duration: 60, filament_used: 100 })
    this.state = 'idle'
    this.job = undefined
    this.log.push('cancel')
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
}

/** A tiny well formed JPEG: SOI, one APP0 segment, EOI. Enough for a size and magic byte check. */
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9])
