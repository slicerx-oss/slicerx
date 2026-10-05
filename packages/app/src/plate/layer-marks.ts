// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pause, color change and custom G-code at a layer, set on the Preview layer slider as in Orca and Bambu Studio
// (slic3r/GUI/IMSlider.cpp: "Add Pause", "Add Custom G-code", "Change Filament"; the code goes in at the start
// of the layer). A mark is kept by the layer's height, not its number, so it stays put when the layer plan changes.
import { get, markStale, set } from '../state/store'

export type MarkKind = 'pause' | 'color_change' | 'custom'

export interface LayerMark {
  id: string
  /** Top of the layer, in mm. */
  z: number
  kind: MarkKind
  /** The text of a custom mark. */
  gcode?: string
}

export const MARK_LABEL: Record<MarkKind, string> = { pause: 'Pause', color_change: 'Color change', custom: 'Custom G-code' }

let seq = 0
export const markId = (): string => `mk_${Date.now().toString(36)}${(++seq).toString(36)}`

const DENY: [RegExp, string][] = [
  [/^\s*(M500|M501|M502|M503|M505)\b/im, 'saves or resets the printer memory (EEPROM)'],
  [/\b(SAVE_CONFIG|FIRMWARE_RESTART|RESTART|RUN_SHELL_COMMAND|SAVE_VARIABLE)\b/i, 'changes the printer configuration or runs a shell command'],
  [/^\s*(M997|M112|M999)\b/im, 'updates firmware or stops the printer'],
  [/^\s*(M84|M18)\b/im, 'turns the motors off mid-print'],
]

/** Why a custom G-code text is refused, or null. A sentence the person can read. The engine checks it again when it writes the file. */
export function customGcodeProblem(text: string): string | null {
  const t = text.trim()
  if (!t) return 'Enter the G-code to insert.'
  if (t.length > 2000) return 'Keep it under 2000 characters.'
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t)) return 'The text has control characters.'
  for (const [re, why] of DENY) if (re.test(t)) return `That G-code ${why}. Change it on the printer instead.`
  for (const line of t.split('\n')) {
    const m = /^\s*(M104|M109|M140|M190)\b.*?\bS(-?\d+(\.\d+)?)/i.exec(line)
    if (!m) continue
    const limit = /M104|M109/i.test(m[1]!) ? 350 : 130
    if (Number(m[2]) > limit) return `${m[1]!.toUpperCase()} S${m[2]} is hotter than the ${limit} degrees this allows.`
  }
  return null
}

export function marksFor(plateId: string = get().activePlate): LayerMark[] {
  return get().layerMarks[plateId] ?? []
}

function write(plateId: string, marks: LayerMark[]): void {
  set((s) => ({ layerMarks: { ...s.layerMarks, [plateId]: marks.slice().sort((a, b) => a.z - b.z) } }))
  markStale()
}

/** Adds a mark at a layer top, replacing one already there (a layer holds one pause or color change, as in Orca). */
export function addMark(z: number, kind: MarkKind, gcode?: string, plateId: string = get().activePlate): LayerMark | null {
  if (kind === 'custom') {
    const why = customGcodeProblem(gcode ?? '')
    if (why) throw new Error(why)
  }
  const mark: LayerMark = { id: markId(), z: Math.round(z * 1e4) / 1e4, kind, ...(kind === 'custom' ? { gcode: gcode!.trim() } : {}) }
  write(plateId, [...marksFor(plateId).filter((m) => Math.abs(m.z - mark.z) > 1e-6), mark])
  return mark
}

export function removeMark(id: string, plateId: string = get().activePlate): void {
  write(plateId, marksFor(plateId).filter((m) => m.id !== id))
}

/** The marks as engine layer G-code by height: the engine puts each on the first of its own layers that reaches it. */
export function layerGcodeByHeight(marks: readonly LayerMark[]): { zMm: number; kind: MarkKind; gcode?: string }[] {
  return marks
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((m) => ({ zMm: m.z, kind: m.kind, ...(m.kind === 'custom' ? { gcode: m.gcode ?? '' } : {}) }))
}
