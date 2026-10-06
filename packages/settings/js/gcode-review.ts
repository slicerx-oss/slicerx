// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printer G-code from a project file, reviewed before it runs (docs/safety.md). G-code that is the printer's stock
// text (the template SlicerX ships for that model, or a version Bambu Studio or OrcaSlicer shipped for it) is trusted
// as it is. Anything else is compared with the printer profile's text and linted: the result is the diff, each flagged
// line with its reason, and whether a person may approve it. Only a person approves; the default is the profile's G-code.
import { lintGcode, SECTION_CODES, type LintLimits, type LintSection } from './gcode-lint'
import { machineEntry, printerConfig } from './profiles'
import { sha256Hex } from './sha256'
import { printerName } from './vendorparent'
import stockJson from '../profiles/stock-gcode.json'

/** Printer and filament keys that hold G-code text. */
export const GCODE_TEXT_KEYS: readonly string[] = [
  'machine_start_gcode',
  'machine_end_gcode',
  'before_layer_change_gcode',
  'layer_change_gcode',
  'change_filament_gcode',
  'filament_start_gcode',
  'filament_end_gcode',
  'machine_pause_gcode',
  'template_custom_gcode',
  'time_lapse_gcode',
  'toolchange_gcode',
  'wrapping_detection_gcode',
  'file_start_gcode',
  'extruder_start_gcode',
  'printing_by_object_gcode',
  'change_extrusion_role_gcode',
  'filament_change_extrusion_role_gcode',
  'process_change_extrusion_role_gcode',
]

const LABELS: Record<string, string> = {
  machine_start_gcode: 'start G-code',
  machine_end_gcode: 'end G-code',
  before_layer_change_gcode: 'before layer change G-code',
  layer_change_gcode: 'layer change G-code',
  change_filament_gcode: 'filament change G-code',
  filament_start_gcode: 'filament start G-code',
  filament_end_gcode: 'filament end G-code',
  machine_pause_gcode: 'pause G-code',
  template_custom_gcode: 'custom G-code template',
  time_lapse_gcode: 'time lapse G-code',
  toolchange_gcode: 'tool change G-code',
  wrapping_detection_gcode: 'wrapping detection G-code',
  file_start_gcode: 'file start G-code',
  extruder_start_gcode: 'tool start G-code',
  printing_by_object_gcode: 'between objects G-code',
  change_extrusion_role_gcode: 'extrusion role change G-code',
  filament_change_extrusion_role_gcode: 'filament extrusion role change G-code',
  process_change_extrusion_role_gcode: 'process extrusion role change G-code',
}

/** Where the text runs, as the engine lints it (packages/core/src/customgcode.rs). */
export function gcodeSection(key: string): LintSection {
  switch (key) {
    case 'machine_start_gcode':
    case 'filament_start_gcode':
      return 'start'
    case 'machine_end_gcode':
      return 'end'
    case 'before_layer_change_gcode':
    case 'layer_change_gcode':
      return 'layerChange'
    case 'change_filament_gcode':
    case 'toolchange_gcode':
      return 'toolChange'
    case 'machine_pause_gcode':
    case 'template_custom_gcode':
      return 'pause'
    default:
      return 'other'
  }
}

/** `start G-code`, `filament start G-code (filament 2)`. */
export function gcodeLabel(key: string, slot?: number): string {
  const base = LABELS[key] ?? key.replace(/_/g, ' ').replace(/gcode$/, 'G-code')
  return slot === undefined ? base : `${base} (filament ${slot + 1})`
}

interface Line {
  text: string
  /** 1-based line in the original text. */
  line: number
}

/** The lines that count: line breaks as `\n`, trailing spaces off, blank lines dropped. */
function lines(text: string): Line[] {
  const out: Line[] = []
  text.replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    const t = raw.replace(/[ \t]+$/, '')
    if (t.trim()) out.push({ text: t, line: i + 1 })
  })
  return out
}

/** G-code text as it is compared: line breaks as `\n`, trailing spaces and blank lines dropped. */
export function normalizeGcode(text: string): string {
  return lines(text).map((l) => l.text).join('\n')
}

/** The fingerprint of G-code text in the stock table: the first 128 bits of the SHA-256 of its normalized form. */
export function gcodeFingerprint(text: string): string {
  return sha256Hex(normalizeGcode(text)).slice(0, 32)
}

const STOCK = stockJson as unknown as { models: Record<string, Record<string, string[]>>; vendors: Record<string, Record<string, string[]>> }
const FILAMENT_KEYS = new Set(['filament_start_gcode', 'filament_end_gcode', 'filament_change_extrusion_role_gcode'])
const stockSets = new Map<string, Set<string>>()
/** The model's own printer G-code, or for filament G-code its vendor's filament presets and Orca's filament library. */
function stockSet(model: string, key: string): Set<string> {
  const id = `${model}\u0000${key}`
  let s = stockSets.get(id)
  if (!s) {
    const vendor = machineEntry(model)?.orca?.vendor
    const lists = FILAMENT_KEYS.has(key) ? [vendor ? STOCK.vendors[vendor]?.[key] : undefined, STOCK.vendors['OrcaFilamentLibrary']?.[key]] : [STOCK.models[model]?.[key]]
    stockSets.set(id, (s = new Set(lists.flatMap((l) => l ?? []))))
  }
  return s
}

/** Text of a G-code setting: a string, or one filament's entry of a list. */
function textOf(v: unknown, slot?: number): string | undefined {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    const x = v[slot ?? 0] ?? v[0]
    return typeof x === 'string' ? x : undefined
  }
  return undefined
}

/**
 * Whether `text` is the stock G-code of `model` for `key`: the text SlicerX ships for the model, or a version that
 * Bambu Studio or OrcaSlicer shipped for it (profiles/stock-gcode.json).
 */
export function isStockGcode(model: string | undefined, key: string, text: string): boolean {
  if (!model) return false
  const norm = normalizeGcode(text)
  const shipped = textOf((printerConfig(model) as Record<string, unknown> | undefined)?.[key])
  if (shipped !== undefined && normalizeGcode(shipped) === norm) return true
  return stockSet(model, key).has(sha256Hex(norm).slice(0, 32))
}

export interface GcodeFlag {
  /** 1-based line of the project's text. */
  line: number
  code: string
  /** What the line does, as a sentence part: `M500 writes settings to the printer's memory`. */
  reason: string
  /** `error`: not even a person can approve it. `warning`: runs only with a person's yes. */
  severity: 'warning' | 'error'
}

export interface GcodeDiffLine {
  kind: 'same' | 'added' | 'removed' | 'skip'
  text: string
  /** 1-based line of the project's text (same and added lines). */
  line?: number
  /** 1-based line of the profile's text (same and removed lines). */
  profileLine?: number
  /** Lines left out between two hunks (skip). */
  count?: number
  flags?: GcodeFlag[]
}

/** One G-code setting of a project that differs from the printer profile's and is not stock text. */
export interface GcodeChange {
  key: string
  /** The filament, 0-based, for per-filament G-code. */
  slot?: number
  label: string
  /** The project's text, as the file has it. */
  text: string
  /** The fingerprint a person's approval is tied to (gcodeFingerprint of `text`). */
  fingerprint: string
  /** Changed lines with three lines of context around each. */
  diff: GcodeDiffLine[]
  /** The same diff as unified diff text, the profile's text as the old side. */
  unified: string
  flags: GcodeFlag[]
  /** A person may choose the project's text. False when a flag is an error. */
  approvable: boolean
  added: number
  removed: number
}

/** One G-code setting of a project that is trusted as it is. */
export interface GcodeKept {
  key: string
  slot?: number
  label: string
  /** `stock`: the printer's stock text. `profile`: the same as the printer profile's text. */
  match: 'stock' | 'profile'
  /** `matches the stock Bambu Lab A1 start G-code`. */
  message: string
}

export interface GcodeReview {
  kept: GcodeKept[]
  changes: GcodeChange[]
}

export interface GcodeReviewInput {
  /** The project's settings (only G-code keys are read). */
  project: Record<string, unknown>
  /** What the printer profile would use for each key instead. */
  profile: Record<string, unknown>
  /** The printer model id (`bambu-a1`) for the stock match. */
  model?: string | undefined
  limits?: LintLimits | undefined
}

/** Reviews every G-code setting the project carries against the printer profile's. */
export function reviewProjectGcode(input: GcodeReviewInput): GcodeReview {
  const out: GcodeReview = { kept: [], changes: [] }
  const name = input.model ? printerName(input.model) : ''
  for (const key of GCODE_TEXT_KEYS) {
    const v = input.project[key]
    if (v === undefined || v === null) continue
    const slots: (number | undefined)[] = Array.isArray(v) ? v.map((_, i) => i) : [undefined]
    for (const slot of slots) {
      const text = textOf(v, slot)
      // Empty text runs nothing.
      if (text === undefined || !normalizeGcode(text)) continue
      const label = gcodeLabel(key, Array.isArray(v) && v.length > 1 ? slot : undefined)
      const reference = textOf(input.profile[key], slot) ?? ''
      const kept = (match: GcodeKept['match'], message: string): void => {
        out.kept.push({ key, ...(slot !== undefined ? { slot } : {}), label, match, message })
      }
      if (isStockGcode(input.model, key, text)) kept('stock', `matches the stock ${name} ${label}`)
      else if (normalizeGcode(text) === normalizeGcode(reference)) kept('profile', `matches the printer profile's ${label}`)
      else out.changes.push(reviewChange(key, slot, label, text, reference, input.limits ?? {}))
    }
  }
  return out
}

/** The diff and the flags of one changed setting. */
export function reviewChange(key: string, slot: number | undefined, label: string, text: string, reference: string, limits: LintLimits): GcodeChange {
  const section = gcodeSection(key)
  const ops = diffLines(lines(reference), lines(text))
  const kept = new Set(ops.filter((o) => o.kind === 'same').map((o) => o.line!))
  // Lines the project shares with the profile are the profile's own text; what the project adds is what a person
  // is asked about. Whole-section findings count when the profile's text does not have them too.
  const own = new Set(lintGcode(reference, section, 'untrusted', limits, { template: true }).filter((f) => SECTION_CODES.has(f.code)).map((f) => f.code))
  const asOwn = lintGcode(text, section, 'trusted', limits, { template: true })
  const flags: GcodeFlag[] = lintGcode(text, section, 'untrusted', limits, { template: true })
    .filter((f) => (SECTION_CODES.has(f.code) ? !own.has(f.code) : !kept.has(f.line)))
    .map((f) => ({
      line: f.line,
      code: f.code,
      reason: f.message,
      severity: asOwn.some((t) => t.line === f.line && t.code === f.code && t.severity === 'error') ? 'error' : 'warning',
    }))
  const byLine = new Map<number, GcodeFlag[]>()
  for (const f of flags) byLine.set(f.line, [...(byLine.get(f.line) ?? []), f])
  for (const o of ops) if (o.kind === 'added' && byLine.has(o.line!)) o.flags = byLine.get(o.line!)!
  return {
    key,
    ...(slot !== undefined ? { slot } : {}),
    label,
    text,
    fingerprint: gcodeFingerprint(text),
    diff: hunks(ops),
    unified: unified(ops),
    flags,
    approvable: flags.every((f) => f.severity !== 'error'),
    added: ops.filter((o) => o.kind === 'added').length,
    removed: ops.filter((o) => o.kind === 'removed').length,
  }
}

/** The shortest edit from `a` to `b` by longest common subsequence. Very long texts fall back to one replaced block. */
function diffLines(a: Line[], b: Line[]): GcodeDiffLine[] {
  // Common head and tail first: most edits touch a few lines of a long text.
  let head = 0
  while (head < a.length && head < b.length && a[head]!.text === b[head]!.text) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail]!.text === b[b.length - 1 - tail]!.text) tail++
  const same = (x: Line, y: Line): GcodeDiffLine => ({ kind: 'same', text: y.text, line: y.line, profileLine: x.line })
  const out: GcodeDiffLine[] = []
  for (let i = 0; i < head; i++) out.push(same(a[i]!, b[i]!))
  const am = a.slice(head, a.length - tail)
  const bm = b.slice(head, b.length - tail)
  const n = am.length
  const m = bm.length
  if (n * m <= 4_000_000) {
    const w = m + 1
    const len = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) len[i * w + j] = am[i]!.text === bm[j]!.text ? len[(i + 1) * w + j + 1]! + 1 : Math.max(len[(i + 1) * w + j]!, len[i * w + j + 1]!)
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && am[i]!.text === bm[j]!.text) out.push(same(am[i++]!, bm[j++]!))
      else if (j < m && (i === n || len[i * w + j + 1]! >= len[(i + 1) * w + j]!)) out.push({ kind: 'added', text: bm[j]!.text, line: bm[j++]!.line })
      else out.push({ kind: 'removed', text: am[i]!.text, profileLine: am[i++]!.line })
    }
  } else {
    for (const x of am) out.push({ kind: 'removed', text: x.text, profileLine: x.line })
    for (const y of bm) out.push({ kind: 'added', text: y.text, line: y.line })
  }
  for (let k = 0; k < tail; k++) out.push(same(a[a.length - tail + k]!, b[b.length - tail + k]!))
  return out
}

const CONTEXT = 3

/** Which ops a hunk shows: every change and up to three unchanged lines on each side of it. */
function shown(ops: GcodeDiffLine[]): boolean[] {
  const show = ops.map(() => false)
  ops.forEach((o, i) => {
    if (o.kind === 'same') return
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) show[k] = true
  })
  return show
}

function hunks(ops: GcodeDiffLine[]): GcodeDiffLine[] {
  const show = shown(ops)
  const out: GcodeDiffLine[] = []
  let gap = 0
  ops.forEach((o, i) => {
    if (!show[i]) {
      gap++
      return
    }
    if (gap) out.push({ kind: 'skip', text: '', count: gap })
    gap = 0
    out.push(o)
  })
  if (gap && out.length) out.push({ kind: 'skip', text: '', count: gap })
  return out
}

function unified(ops: GcodeDiffLine[]): string {
  const show = shown(ops)
  const out = ['--- printer profile', '+++ project']
  let i = 0
  while (i < ops.length) {
    if (!show[i]) {
      i++
      continue
    }
    let j = i
    while (j < ops.length && show[j]) j++
    const part = ops.slice(i, j)
    const oldLines = part.filter((o) => o.kind !== 'added')
    const newLines = part.filter((o) => o.kind !== 'removed')
    // A side with no lines in the hunk counts from the line before it, as diff -u does.
    const before = (pick: (o: GcodeDiffLine) => number | undefined): number => {
      for (let k = i - 1; k >= 0; k--) {
        const n = pick(ops[k]!)
        if (n !== undefined) return n
      }
      return 0
    }
    const oldStart = oldLines[0]?.profileLine ?? before((o) => o.profileLine)
    const newStart = newLines[0]?.line ?? before((o) => o.line)
    out.push(`@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`)
    for (const o of part) out.push(`${o.kind === 'added' ? '+' : o.kind === 'removed' ? '-' : ' '}${o.text}`)
    i = j
  }
  return out.join('\n')
}
