// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The pause, color change and custom G-code marks of a 3MF project's plates, read and changed in the file itself
// (Metadata/custom_gcode_per_layer.xml), with the reader and writer the app uses (@slicerx/threemf/layer-marks). A
// project changed here opens in the app with the same marks, and slicerx_slice_file slices them.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, extname, join } from 'node:path'
import { z } from 'zod'
import { customGcodeProblem, layerMarksXml, markZ, MARKS_PART, placeMark, readLayerMarks, sameZ, writeMarks, type FileMark } from '@slicerx/threemf/layer-marks'
import { checkReadable, ToolInputError, type PathPolicy } from './models'
import { readProjectFile } from './projectfile'
import { openZip, readZip, writeZip } from './zip'

export const projectInput = z.string().min(1).describe('Absolute path of a local .3mf project')
export const plateInput = z.number().int().min(1).default(1).describe('Plate number, 1-based, as slicerx_inspect_project lists them. Default 1.')

/** The kinds a client can add; a tool change comes only from a project, as in the app. */
export const ADDABLE_KINDS = ['pause', 'color_change', 'custom'] as const
export type AddableKind = (typeof ADDABLE_KINDS)[number]

export const KIND_LABEL: Record<FileMark['kind'], string> = { pause: 'pause', color_change: 'color change', custom: 'custom G-code', tool_change: 'tool change' }

/** A mark as the tools answer with it. */
export interface MarkOut {
  z_mm: number
  kind: FileMark['kind']
  gcode?: string
  slot?: number
  /** Why a tool change is kept but not applied. */
  skipped?: string
  /** Why a custom text is refused: the app leaves that mark out when it opens the project. */
  refused?: string
}

export function markOut(m: FileMark): MarkOut {
  const refused = m.kind === 'custom' ? customGcodeProblem(m.gcode ?? '') : null
  return { z_mm: m.z, kind: m.kind, ...(m.gcode !== undefined && m.kind === 'custom' ? { gcode: m.gcode } : {}), ...(m.slot ? { slot: m.slot } : {}), ...(m.skip ? { skipped: m.skip } : {}), ...(refused ? { refused } : {}) }
}

/** A local .3mf project this server may read; marks are written back into the same file. */
export function projectPath(policy: PathPolicy, file: string): string {
  if (/^https?:\/\//i.test(file)) throw new ToolInputError('Give the path of a local .3mf project: its marks are written into the file.', 'invalid_input')
  const path = checkReadable(policy, file, ['.3mf'])
  if (extname(path).toLowerCase() !== '.3mf') throw new ToolInputError(`${basename(path)} is not a 3MF project (.3mf)`, 'unsupported_format')
  return path
}

export interface PlateMarks {
  /** The project's plate numbers, 1-based. */
  plates: number[]
  /** The plate's marks, by height. */
  marks: FileMark[]
  /** Every plate's marks, by plate index (0-based), as the file holds them. */
  all: Record<number, FileMark[]>
}

/** The marks of `plate` (1-based) of the project at `path`; a plate the project does not have is refused. */
export function readPlateMarks(path: string, plate: number): PlateMarks {
  const plates = readProjectFile(path).summary.plates.map((p) => p.index)
  if (!plates.includes(plate)) throw new ToolInputError(`${basename(path)} has no plate ${plate}; its plates are ${plates.join(', ')}.`, 'no_such_plate')
  const zip = openZip(path, basename(path))
  let text: string | undefined
  try {
    text = zip.text(MARKS_PART)
  } finally {
    zip.close()
  }
  const all = text ? readLayerMarks(text) : {}
  return { plates, marks: (all[plate - 1] ?? []).slice().sort((a, b) => a.z - b.z), all }
}

/** A sliced plate's G-code in the file: marks changed now would not be in it. */
const SLICED = /^Metadata\/plate_\d+\.gcode$/

/** Writes `marks` as plate `plate`'s (1-based) into the project at `path`, every other part as it was. */
function writePlateMarks(path: string, plate: number, all: Record<number, FileMark[]>, marks: readonly FileMark[]): void {
  const buf = readFileSync(path)
  const zip = readZip(buf, basename(path))
  const names = zip.names()
  if (names.some((n) => SLICED.test(n))) throw new ToolInputError(`${basename(path)} holds sliced G-code, which would not have the marks. Change the marks in the project the print file was sliced from.`, 'not_supported')
  const next: Record<number, FileMark[]> = { ...all, [plate - 1]: marks.slice() }
  const xml = layerMarksXml(Object.fromEntries(Object.entries(next).map(([i, list]) => [i, writeMarks(list)])))
  const entries = names.filter((n) => n !== MARKS_PART && !n.endsWith('/')).map((name) => ({ name, data: zip.read(name) ?? new Uint8Array() }))
  if (xml) entries.push({ name: MARKS_PART, data: Buffer.from(xml, 'utf8') })
  // Written beside the project and moved over it, so a failed write leaves the project as it was.
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, writeZip(entries))
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

export interface AddMark {
  z: number
  kind: AddableKind
  gcode?: string
  slot?: number
}

/** The mark an add makes, checked as the app checks it: a custom text the app refuses is refused here too. */
export function newMark(i: AddMark): FileMark {
  if (i.kind !== 'color_change' && i.slot !== undefined) throw new ToolInputError('slot is for a color change only.', 'invalid_input')
  if (i.kind !== 'custom' && i.gcode !== undefined) throw new ToolInputError('gcode is for a custom G-code mark only.', 'invalid_input')
  if (i.kind === 'custom') {
    const why = customGcodeProblem(i.gcode ?? '')
    if (why) throw new ToolInputError(why, 'invalid_input')
  }
  return { z: markZ(i.z), kind: i.kind, ...(i.kind === 'custom' ? { gcode: i.gcode!.trim() } : {}), ...(i.kind === 'color_change' && i.slot ? { slot: i.slot } : {}) }
}

/** Adds a mark to a plate, replacing one at the same height as the layer slider does; answers with the marks read back from the saved file. */
export function addPlateMark(path: string, plate: number, i: AddMark): { mark: FileMark; replaced?: FileMark; marks: FileMark[] } {
  const mark = newMark(i)
  const read = readPlateMarks(path, plate)
  const replaced = read.marks.find((m) => sameZ(m.z, mark.z))
  writePlateMarks(path, plate, read.all, placeMark(read.marks, mark))
  return { mark, ...(replaced ? { replaced } : {}), marks: readPlateMarks(path, plate).marks }
}

/** Removes the mark at a height from a plate; answers with the marks read back from the saved file. */
export function removePlateMark(path: string, plate: number, z: number): { removed: FileMark; marks: FileMark[] } {
  const read = readPlateMarks(path, plate)
  const at = markZ(z)
  const removed = read.marks.find((m) => sameZ(m.z, at))
  if (!removed) {
    const heights = read.marks.map((m) => `${m.z} mm`).join(', ')
    throw new ToolInputError(`Plate ${plate} has no mark at ${at} mm${heights ? `; its marks are at ${heights}` : '; it has no marks'}.`, 'not_found')
  }
  writePlateMarks(path, plate, read.all, read.marks.filter((m) => m !== removed))
  return { removed, marks: readPlateMarks(path, plate).marks }
}
