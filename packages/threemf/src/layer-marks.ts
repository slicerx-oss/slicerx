// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pause, color change, tool change and custom G-code at a layer, as a project keeps them in
// Metadata/custom_gcode_per_layer.xml: the reader and writer the app and the MCP server share, the check on custom
// text, and the one-mark-per-height rule of the layer slider.

/** `tool_change` comes only from a project file: a filament change set on the layer slider of a plate of one filament. */
export type MarkKind = 'pause' | 'color_change' | 'custom' | 'tool_change'

/** A mark as a project file holds it. */
export interface FileMark {
  /** Top of the layer, in mm. */
  z: number
  kind: MarkKind
  /** The text of a custom mark. */
  gcode?: string
  /** The filament slot (1-based) a color change goes to, or the one a tool change prints in. */
  slot?: number
  /** Why a tool change does not apply (it was saved for a plate of several filaments); it is kept for the file. */
  skip?: string
}

/** A mark as the writer takes it: `skipped` keeps a tool change that does not apply, so its plate is written under that mode again. */
export interface WriteMark {
  z: number
  kind: MarkKind
  gcode?: string
  slot?: number
  skipped?: boolean
}

/** The mark type numbers in custom_gcode_per_layer.xml: color change 0, pause 1, tool change 2, custom 4. */
export const MARK_TYPE = { color_change: 0, pause: 1, tool_change: 2, custom: 4 } as const

/** Where the marks live in a project. */
export const MARKS_PART = 'Metadata/custom_gcode_per_layer.xml'

/** Why a tool change read under another mode than the one-filament mode is kept but not applied. */
export const TOOL_CHANGE_MODE_SKIP = 'the project saved it for a plate that prints several filaments'

/** The most marks one plate takes from a file. */
export const MAX_MARKS = 200

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

/** A mark's height as it is kept: to 0.1 micron, so a layer top read back as f32 still names its layer. */
export const markZ = (z: number): number => Math.round(z * 1e4) / 1e4

/** Whether two kept heights are the same layer top. */
export const sameZ = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6

/** The marks with `mark` added, replacing one already at its height (a layer holds one mark, as on the layer slider), by height. */
export function placeMark<M extends { z: number }>(marks: readonly M[], mark: M): M[] {
  return [...marks.filter((m) => !sameZ(m.z, mark.z)), mark].sort((a, b) => a.z - b.z)
}

/** An attribute value: line breaks as character references, so a custom mark of several lines reads back with them. */
const attr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;')

/** Metadata/custom_gcode_per_layer.xml for the marks per plate index (0-based), as 3MF projects carry it, or '' without marks. */
export function layerMarksXml(marks: Readonly<Record<number, readonly WriteMark[]>> | undefined): string {
  const plates = Object.entries(marks ?? {}).filter(([, list]) => list.length > 0)
  if (plates.length === 0) return ''
  const body = plates
    .map(([i, list]) => {
      const layers = list
        .map((m) => {
          const extra = m.kind === 'custom' ? (m.gcode ?? '') : ''
          const gcode = m.kind === 'tool_change' ? 'tool_change' : extra
          return `<layer top_z="${m.z}" type="${MARK_TYPE[m.kind]}" extruder="${(m.kind === 'color_change' || m.kind === 'tool_change') && m.slot ? m.slot : 1}" color="" extra="${attr(extra)}" gcode="${attr(gcode)}"/>`
        })
        .join('\n')
      // A tool change applies under the one-filament mode only, so the mode keeps whether the plate's tool changes apply.
      const tools = list.filter((m) => m.kind === 'tool_change')
      const mode = tools.some((m) => m.skipped) ? 'MultiExtruder' : tools.length ? 'MultiAsSingle' : 'SingleExtruder'
      return `<plate>\n<plate_info id="${Number(i) + 1}"/>\n${layers}\n<mode value="${mode}"/>\n</plate>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>\n<custom_gcodes_per_layer>\n${body}\n</custom_gcodes_per_layer>`
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** An attribute value as written: the five named entities and character references. */
function unescape(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? m
    const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10)
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
  })
}

const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/**
 * The marks of Metadata/custom_gcode_per_layer.xml per plate index (0-based): color change 0, pause 1, tool change 2
 * and custom 4; other types are not carried over, nor a height of 0 or less. A tool change applies only under the
 * one-filament mode; under another it is kept with the reason. Damaged text gives the marks it can read.
 */
export function readLayerMarks(text: string): Record<number, FileMark[]> {
  const out: Record<number, FileMark[]> = {}
  const body = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '')
  let depth = 0
  let plate: { id: number; layers: Record<string, string>[]; mode: string | undefined } | null = null
  for (const m of body.matchAll(TAG)) {
    const [, close, name, attrText, selfClose] = m
    if (close) {
      depth--
      if (name === 'plate' && plate && depth === 1) {
        if (Number.isInteger(plate.id) && plate.id >= 1) {
          const marks = plateMarks(plate.layers, plate.mode)
          if (marks.length) out[plate.id - 1] = marks.slice(0, MAX_MARKS)
        }
        plate = null
      }
      continue
    }
    const attrs: Record<string, string> = {}
    for (const a of (attrText ?? '').matchAll(ATTR)) attrs[a[1]!] = unescape(a[2] ?? a[3] ?? '')
    if (depth === 1 && name === 'plate') plate = { id: Number.NaN, layers: [], mode: undefined }
    else if (plate && depth === 2) {
      if (name === 'plate_info') plate.id = Number(attrs['id'])
      else if (name === 'mode') plate.mode = attrs['value']?.trim()
      else if (name === 'layer') plate.layers.push(attrs)
    }
    if (!selfClose) depth++
  }
  return out
}

function plateMarks(layers: readonly Record<string, string>[], mode: string | undefined): FileMark[] {
  const marks: FileMark[] = []
  for (const l of layers) {
    const z = Number(l['top_z'])
    const type = Number(l['type'])
    if (!Number.isFinite(z) || z <= 0) continue
    const slot = Number(l['extruder'])
    const isSlot = Number.isInteger(slot) && slot >= 1 && slot <= 64
    if (type === 0) marks.push({ z, kind: 'color_change', ...(isSlot ? { slot } : {}) })
    else if (type === 1) marks.push({ z, kind: 'pause' })
    else if (type === 2 && isSlot) marks.push({ z, kind: 'tool_change', slot, ...(mode === 'MultiAsSingle' ? {} : { skip: TOOL_CHANGE_MODE_SKIP }) })
    else if (type === 4) marks.push({ z, kind: 'custom', gcode: l['extra'] ?? l['gcode'] ?? '' })
  }
  return marks
}

/** Marks read from a file, as the writer takes them back: a skipped tool change keeps its plate's mode. */
export function writeMarks(marks: readonly FileMark[]): WriteMark[] {
  return marks.map(({ z, kind, gcode, slot, skip }) => ({ z, kind, ...(gcode !== undefined && kind === 'custom' ? { gcode } : {}), ...(slot ? { slot } : {}), ...(skip ? { skipped: true } : {}) }))
}
