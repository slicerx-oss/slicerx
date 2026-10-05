import { appName } from '../edition'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// STEP to mesh, without the worker plumbing (so tests run it directly). OpenCASCADE (occt-import-js,
// packages/vendor/occt-import-js) reads the file, converts its length unit to millimeters and meshes
// every solid. This module picks what to keep, names it and writes one OBJ for the geometry engine's
// automatic import, which repairs, checks and adds it like any other mesh file.
//
// - Solids are kept. Open shells and loose faces are construction or reference geometry in most CAD
//   exports and are left out when the file has solids; a file with shells only keeps them (the engine
//   closes them), a file with loose faces only is refused.
// - Bodies whose boxes touch or overlap stay together as one object with a part per body, in place
//   (a bolt in its bracket). Bodies apart from the rest become objects of their own.
// - Chord tolerance 0.01 mm and 0.5 rad, measured on the NIST test models and our own parts: under a
//   second for most parts, 5 s for the largest. Orca uses 0.003 mm, which triples the triangles for
//   no difference a printer can show. Past the triangle limit the file is meshed again at 0.05 mm.

export interface OcctMesh {
  name?: string
  /** solid, shell or faces (added by our patch, patches/0001-mesh-kind.patch). */
  kind?: string
  attributes: { position: { array: ArrayLike<number> } }
  index: { array: ArrayLike<number> }
}

export interface OcctResult {
  success: boolean
  meshes: OcctMesh[]
}

export interface OcctParams {
  linearUnit: 'millimeter'
  linearDeflectionType: 'absolute_value'
  linearDeflection: number
  angularDeflection: number
}

export interface Occt {
  ReadStepFile(data: Uint8Array, params: OcctParams | null): OcctResult
}

export type StepQuality = 'normal' | 'coarser' | 'finer'

/** Chord tolerance in mm for each quality. */
export const STEP_TOLERANCE: Record<StepQuality, number> = { finer: 0.003, normal: 0.01, coarser: 0.05 }
export const STEP_ANGLE_RAD = 0.5
export const STEP_MAX_MB = 100
export const STEP_MAX_TRIANGLES = 2_000_000

/** A STEP file that cannot be added, with the reason in plain words (the file name goes in front). */
export class StepError extends Error {}

export type StepUnit = 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot'

export interface StepBody {
  name: string
  positions: Float64Array
  indices: Uint32Array
}

export interface StepRead {
  /** Objects to add, each with its parts (one per body). */
  objects: { name: string; bodies: StepBody[] }[]
  /** The length unit the file declares; positions are already millimeters. */
  unit: StepUnit | null
  triangles: number
  toleranceMm: number
  /** Short sentences for the import toast. */
  notes: string[]
}

const latin1 = new TextDecoder('latin1')

/** The file's length unit, from its header entities. */
export function stepUnit(bytes: Uint8Array): StepUnit | null {
  const text = latin1.decode(bytes)
  const conv = /CONVERSION_BASED_UNIT\s*\(\s*'\s*(INCH|IN|FOOT|FT)\s*'/i.exec(text)
  if (conv) return /^(INCH|IN)$/i.test(conv[1]!) ? 'inch' : 'foot'
  const si = /SI_UNIT\s*\(\s*(\$|\.\w+\.)\s*,\s*\.METRE\.\s*\)/i.exec(text)
  if (!si) return null
  const p = si[1]!.toUpperCase()
  return p === '.MILLI.' ? 'millimeter' : p === '.CENTI.' ? 'centimeter' : p === '$' ? 'meter' : null
}

/** Why the bytes are not a STEP file we read, or null when they are one. */
function notStep(bytes: Uint8Array): string | null {
  const head = latin1.decode(bytes.subarray(0, 4096)).replace(/^﻿/, '').trimStart()
  if (head.startsWith('ISO-10303-21')) return null
  if (/ISO-10303-28|<\?xml/i.test(head)) return 'is a STEP XML file. Save it from your CAD program as a regular STEP file (AP203, AP214 or AP242) and open that.'
  return 'is not a STEP file. A STEP file starts with ISO-10303-21.'
}

const GENERIC = /^(solid|shell|body|part|open\s?cascade.*|compound|unnamed)?[\s_-]*\d*$/i

function cleanName(s: string | undefined): string {
  return (s ?? '').replace(/[\r\n\t]+/g, ' ').trim()
}

/** Groups bodies whose boxes touch or overlap (within `gap` mm), keeping the file order. */
function groupByBox(boxes: number[][], gap: number): number[][] {
  const parent = boxes.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!
      const b = boxes[j]!
      if (a[0]! <= b[3]! + gap && b[0]! <= a[3]! + gap && a[1]! <= b[4]! + gap && b[1]! <= a[4]! + gap && a[2]! <= b[5]! + gap && b[2]! <= a[5]! + gap) {
        parent[find(j)] = find(i)
      }
    }
  }
  const groups = new Map<number, number[]>()
  boxes.forEach((_, i) => {
    const r = find(i)
    groups.set(r, [...(groups.get(r) ?? []), i])
  })
  return [...groups.values()]
}

function box(p: Float64Array): number[] {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k]!
      if (v < b[k]!) b[k] = v
      if (v > b[k + 3]!) b[k + 3] = v
    }
  }
  return b
}

const NOTHING = (): string => `has no solids or surfaces ${appName()} can read. It may hold only drawings or annotations, or use STEP entities ${appName()} does not support.`
const SHAPES = /\b(MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS|FACETED_BREP|SHELL_BASED_SURFACE_MODEL|CLOSED_SHELL|OPEN_SHELL|ADVANCED_FACE|FACE_SURFACE)\s*\(/i

function mesh(occt: Occt, bytes: Uint8Array, tol: number): OcctResult {
  let r: OcctResult
  try {
    r = occt.ReadStepFile(bytes, { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: tol, angularDeflection: STEP_ANGLE_RAD })
  } catch {
    throw new StepError(`could not be read: it ran out of memory or uses STEP entities ${appName()} does not support.`)
  }
  if (!r.success) {
    if (!SHAPES.test(latin1.decode(bytes))) throw new StepError(NOTHING())
    throw new StepError(`could not be read. It may be damaged, or it uses STEP entities ${appName()} does not support.`)
  }
  return r
}

const triangles = (ms: OcctMesh[]) => ms.reduce((n, m) => n + Math.floor(m.index.array.length / 3), 0)

/** Reads a STEP file into objects and bodies in millimeters. Throws StepError with a plain reason. */
export function readStep(occt: Occt, bytes: Uint8Array, fileName: string, quality: StepQuality = 'normal'): StepRead {
  if (bytes.length === 0) throw new StepError('is empty.')
  if (bytes.length > STEP_MAX_MB * 1024 * 1024) throw new StepError(`is ${Math.round(bytes.length / 1024 / 1024)} MB. STEP files up to ${STEP_MAX_MB} MB can be opened.`)
  const why = notStep(bytes)
  if (why) throw new StepError(why)
  const notes: string[] = []
  let tol = STEP_TOLERANCE[quality]
  let r = mesh(occt, bytes, tol)
  const used = (res: OcctResult) => {
    const all = res.meshes.filter((m) => m.index.array.length >= 3)
    const solids = all.filter((m) => m.kind === 'solid')
    const shells = all.filter((m) => m.kind === 'shell' || m.kind === undefined || m.kind === '')
    const faces = all.filter((m) => m.kind === 'faces')
    return { all, solids, shells, faces, keep: solids.length ? solids : shells }
  }
  let u = used(r)
  if (u.all.length === 0) throw new StepError(NOTHING())
  if (u.keep.length === 0) throw new StepError('has only loose surfaces and no solid bodies, so there is nothing to print. Export it from your CAD program as a solid.')
  if (triangles(u.keep) > STEP_MAX_TRIANGLES && tol < STEP_TOLERANCE.coarser) {
    tol = STEP_TOLERANCE.coarser
    r = mesh(occt, bytes, tol)
    u = used(r)
    notes.push(`Meshed at ${tol} mm because the model is very detailed.`)
  }
  const total = triangles(u.keep)
  if (total > STEP_MAX_TRIANGLES) throw new StepError(`is too detailed: ${total.toLocaleString('en-US')} triangles at ${tol} mm, more than the ${STEP_MAX_TRIANGLES.toLocaleString('en-US')} ${appName()} can add at once.`)
  const left = u.all.length - u.keep.length
  if (left > 0) notes.push(`Left out ${left} open ${left === 1 ? 'surface' : 'surfaces'} that ${left === 1 ? 'is' : 'are'} not part of a solid.`)

  const base = fileName.replace(/\.(step|stp)$/i, '')
  const bodies: StepBody[] = u.keep.map((m, i) => {
    const name = cleanName(m.name)
    return {
      name: name && !GENERIC.test(name) ? name : u.keep.length === 1 ? base : `${base} ${i + 1}`,
      positions: Float64Array.from(m.attributes.position.array),
      indices: Uint32Array.from(m.index.array),
    }
  })
  const groups = groupByBox(bodies.map((b) => box(b.positions)), 0.01)
  const objects = groups.map((g) => ({ name: g.length === 1 ? bodies[g[0]!]!.name : base, bodies: g.map((i) => bodies[i]!) }))
  if (groups.length === 1 && bodies.length > 1) objects[0]!.name = base
  // One object of one body keeps the file's name, like other formats.
  if (objects.length === 1 && bodies.length === 1) objects[0]!.name = base
  const unit = stepUnit(bytes)
  if (unit && unit !== 'millimeter') notes.unshift(`Converted from ${unit === 'inch' ? 'inches' : unit === 'foot' ? 'feet' : `${unit}s`} to millimeters.`)
  return { objects, unit, triangles: total, toleranceMm: tol, notes }
}

const num = (v: number) => {
  const r = Math.round(v * 1e5) / 1e5
  return Object.is(r, -0) ? '0' : String(r)
}

/** The read file as OBJ text: an `o` per object, a `g` per body, in millimeters. */
export function stepToObj(read: StepRead): string {
  const out: string[] = []
  let base = 1
  for (const o of read.objects) {
    out.push(`o ${o.name}`)
    for (const b of o.bodies) {
      out.push(`g ${b.name}`)
      const p = b.positions
      for (let i = 0; i < p.length; i += 3) out.push(`v ${num(p[i]!)} ${num(p[i + 1]!)} ${num(p[i + 2]!)}`)
      const t = b.indices
      for (let i = 0; i + 2 < t.length; i += 3) out.push(`f ${t[i]! + base} ${t[i + 1]! + base} ${t[i + 2]! + base}`)
      base += p.length / 3
    }
  }
  return `${out.join('\n')}\n`
}
