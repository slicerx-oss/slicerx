// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Bounds for changes to a running print. A change outside them is refused
// before any card is shown, so the user is never asked to approve one. The
// bounds are deliberately narrow: a check-in nudges a print, it does not
// retune it.
import type { PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import type { KnowledgeBase } from '../../src/kb/kb'

export type Firmware = 'klipper' | 'bambu' | 'marlin'

export type Adjustment =
  | { kind: 'part_fan'; percent: number }
  | { kind: 'speed'; percent: number }
  | { kind: 'nozzle_temp'; celsius: number }
  | { kind: 'bed_temp'; celsius: number }
  | { kind: 'pause' }

export interface Range {
  min: number
  max: number
}

/** What the loaded material allows, when one material is loaded and the knowledge base knows it. */
export interface MaterialLimits {
  name: string
  nozzle?: Range
  bed?: Range
  /** Highest part fan in percent the material tolerates (ABS and ASA crack with strong cooling). */
  fanMaxPct?: number
}

/** Largest single step for each kind, against the current target. */
export const STEP = {
  /** Known material: within its range and at most this far from the current target. */
  nozzleC: 15,
  bedC: 10,
  /** Unknown or mixed material: a smaller step, since no range applies. */
  nozzleUnknownC: 10,
  bedUnknownC: 5,
} as const

/** Never crossed, whatever the material says. */
export const ABSOLUTE = {
  nozzleMinC: 170,
  nozzleMaxC: 300,
  bedMaxC: 120,
  speedMinPct: 50,
  speedMaxPct: 150,
} as const

export function firmwareOf(info: Pick<PrinterInfo, 'plugin'>): Firmware {
  return info.plugin === 'moonraker' ? 'klipper' : info.plugin === 'bambu-lan' ? 'bambu' : 'marlin'
}

const range = (v: unknown): Range | undefined => {
  const r = v as { min?: unknown; max?: unknown } | undefined
  return typeof r?.min === 'number' && typeof r.max === 'number' ? { min: r.min, max: r.max } : undefined
}

/**
 * The material in use. The printer reports its loaded slots but not which one
 * the job draws from, so a material counts only when every loaded slot holds it.
 */
export function materialLimits(status: Pick<PrinterStatus, 'slots'>, kb: Pick<KnowledgeBase, 'get'>): MaterialLimits | null {
  const names = [...new Set(status.slots.map((s) => s.material?.trim()).filter((m): m is string => Boolean(m)))]
  if (names.length !== 1) return null
  const name = names[0] ?? ''
  const doc = kb.get('filament', name)
  if (!doc) return { name }
  const cooling = doc.data['cooling'] as { fan_max_pct?: { max?: unknown } } | undefined
  const fanMax = cooling?.fan_max_pct?.max
  const out: MaterialLimits = { name: doc.name }
  const nozzle = range(doc.data['nozzle_temp_c'])
  const bed = range(doc.data['bed_temp_c'])
  if (nozzle) out.nozzle = nozzle
  if (bed) out.bed = bed
  if (typeof fanMax === 'number') out.fanMaxPct = fanMax
  return out
}

export interface PlannedAdjustment {
  /** The card's title and lines. */
  title: string
  lines: string[]
  /** G-code lines, empty for a pause. */
  gcode: string[]
}

export class AdjustRefused extends Error {}

const refuse = (message: string): never => {
  throw new AdjustRefused(message)
}

/**
 * Checks one change against the printer's state and the limits, and plans the
 * G-code. Throws AdjustRefused with a reason the model can pass on.
 */
export function planAdjustment(change: Adjustment, status: PrinterStatus, info: PrinterInfo, material: MaterialLimits | null): PlannedAdjustment {
  const name = info.name
  const fw = firmwareOf(info)
  if (change.kind === 'pause') {
    if (status.state !== 'printing') refuse(`${name} is ${status.state}, not printing, so there is nothing to pause.`)
    return { title: `Pause the print on ${name}?`, lines: ['The printer parks the head and holds temperatures. Resume it from SlicerX or the printer.'], gcode: [] }
  }
  if (status.state !== 'printing') refuse(`${name} is ${status.state}. Changes during a print are only made while it is printing.`)
  const mat = material ? `${material.name} loaded` : 'material unknown or mixed'

  switch (change.kind) {
    case 'part_fan': {
      const p = Math.round(change.percent)
      if (p < 0 || p > 100) refuse('The part fan runs from 0 to 100 %.')
      if (material?.fanMaxPct !== undefined && p > material.fanMaxPct) {
        refuse(`${material.name} tolerates at most ${material.fanMaxPct} % part fan; more cooling cracks layers and lifts corners.`)
      }
      const s = Math.round((p / 100) * 255)
      return {
        title: `Set the part fan on ${name} to ${p} %?`,
        lines: [`Part fan: ${p} % (${mat})`],
        gcode: [fw === 'bambu' ? `M106 P1 S${s}` : `M106 S${s}`],
      }
    }
    case 'speed': {
      const p = Math.round(change.percent)
      if (fw === 'bambu') refuse('Bambu Lab printers change speed by speed level, not by G-code. Change the level on the printer screen or in the Bambu Handy app.')
      if (p < ABSOLUTE.speedMinPct || p > ABSOLUTE.speedMaxPct) refuse(`Print speed can be set from ${ABSOLUTE.speedMinPct} to ${ABSOLUTE.speedMaxPct} % during a print.`)
      return { title: `Set the print speed on ${name} to ${p} %?`, lines: [`Speed factor: ${p} % of the sliced speeds`], gcode: [`M220 S${p}`] }
    }
    case 'nozzle_temp': {
      const now = status.nozzles[0]?.target ?? 0
      const c = Math.round(change.celsius)
      if (now <= 0) refuse(`The nozzle heater on ${name} is off; it is not turned on during a check-in.`)
      const step = material?.nozzle ? STEP.nozzleC : STEP.nozzleUnknownC
      if (Math.abs(c - now) > step) refuse(`That is a ${Math.abs(c - now)} C change; a check-in changes the nozzle by at most ${step} C at a time (now ${now} C, ${mat}).`)
      if (c < ABSOLUTE.nozzleMinC || c > ABSOLUTE.nozzleMaxC) refuse(`The nozzle stays between ${ABSOLUTE.nozzleMinC} and ${ABSOLUTE.nozzleMaxC} C.`)
      if (material?.nozzle && (c < material.nozzle.min || c > material.nozzle.max)) {
        refuse(`${material.name} prints between ${material.nozzle.min} and ${material.nozzle.max} C; ${c} C is outside that.`)
      }
      return {
        title: `Set the nozzle on ${name} to ${c} C?`,
        lines: [`Nozzle: ${now} C to ${c} C (${mat}${material?.nozzle ? `, range ${material.nozzle.min} to ${material.nozzle.max} C` : ''})`],
        gcode: [`M104 S${c}`],
      }
    }
    case 'bed_temp': {
      const now = status.bed?.target ?? 0
      const c = Math.round(change.celsius)
      if (now <= 0) refuse(`The bed heater on ${name} is off; it is not turned on during a check-in.`)
      const step = material?.bed ? STEP.bedC : STEP.bedUnknownC
      if (Math.abs(c - now) > step) refuse(`That is a ${Math.abs(c - now)} C change; a check-in changes the bed by at most ${step} C at a time (now ${now} C, ${mat}).`)
      if (c > ABSOLUTE.bedMaxC) refuse(`The bed stays at or below ${ABSOLUTE.bedMaxC} C.`)
      if (material?.bed && (c < material.bed.min || c > material.bed.max)) {
        refuse(`${material.name} wants a bed between ${material.bed.min} and ${material.bed.max} C; ${c} C is outside that.`)
      }
      return {
        title: `Set the bed on ${name} to ${c} C?`,
        lines: [`Bed: ${now} C to ${c} C (${mat}${material?.bed ? `, range ${material.bed.min} to ${material.bed.max} C` : ''})`],
        gcode: [`M140 S${c}`],
      }
    }
  }
}

/** The limits in words, for the model to plan within. */
export function describeLimits(status: PrinterStatus, info: PrinterInfo, material: MaterialLimits | null): string[] {
  const fw = firmwareOf(info)
  const nozzleNow = status.nozzles[0]?.target ?? 0
  const bedNow = status.bed?.target ?? 0
  const nStep = material?.nozzle ? STEP.nozzleC : STEP.nozzleUnknownC
  const bStep = material?.bed ? STEP.bedC : STEP.bedUnknownC
  return [
    material ? `Material: ${material.name}.` : 'Material: unknown or several loaded, so only small steps are allowed.',
    `Part fan: 0 to ${material?.fanMaxPct ?? 100} %.`,
    fw === 'bambu' ? 'Speed: not adjustable here on Bambu Lab printers.' : `Speed: ${ABSOLUTE.speedMinPct} to ${ABSOLUTE.speedMaxPct} %.`,
    nozzleNow > 0 ? `Nozzle: ${nozzleNow} C now, at most ${nStep} C per change${material?.nozzle ? `, within ${material.nozzle.min} to ${material.nozzle.max} C` : ''}.` : 'Nozzle: heater off, not adjustable.',
    bedNow > 0 ? `Bed: ${bedNow} C now, at most ${bStep} C per change${material?.bed ? `, within ${material.bed.min} to ${material.bed.max} C` : ''}.` : 'Bed: heater off, not adjustable.',
    'Pause: allowed while printing.',
  ]
}
