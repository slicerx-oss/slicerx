// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads the CAD history parts of a project (docs/cad-history.md, "Storage"), written by
// file.ts. Untrusted: a bad step or mesh drops mesh history; required exact history refuses the project.
import { productName } from '@slicerx/contracts/brand'
import { featureOf, timelineOf, type Item, type SketchItem, type Timeline } from './design'
import { pinnedOlder, type PlaceOf } from './design-frame'
import { readTilt } from './tilt'
import { BIN_VERSION, DESIGN_FILE_VERSION, HISTORY_FILE_VERSION, MAGIC, SKETCH_ANCHORS } from './file'
import { MAX_STEPS_REPEATED, stepPatternProblem, type StepPattern } from './pattern'
import { idNumber, MAX_PROJECTION, type Projection, type ProjectSource } from './project'
import { followField, keepsArrayOf, MAX_PART_SLOT, type Follow, type History, type HistoryMesh, type PaintTexts, type PrimitiveSpec, type Step, type StepParams } from './model'

const MAX_STEPS = 2000
const MAX_TRIANGLES = 20_000_000

/** The meshes of a binary part with their names, slots and paint from the JSON. Null when the part does not read. */
export function decodeMeshes(bytes: Uint8Array | undefined, info: readonly { name: string; slot: number; paint?: PaintTexts; primitive?: PrimitiveSpec }[]): HistoryMesh[] | null {
  if (!bytes || bytes.byteLength < 12) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== BIN_VERSION || dv.getUint32(8, true) !== info.length) return null
  let at = 12
  const out: HistoryMesh[] = []
  for (const meta of info) {
    if (at + 8 > bytes.byteLength) return null
    const nv = dv.getUint32(at, true)
    const nt = dv.getUint32(at + 4, true)
    at += 8
    if (nt > MAX_TRIANGLES || at + (nv + nt) * 12 > bytes.byteLength) return null
    const positions = new Float32Array(nv * 3)
    for (let i = 0; i < positions.length; i++, at += 4) positions[i] = dv.getFloat32(at, true)
    const indices = new Uint32Array(nt * 3)
    for (let i = 0; i < indices.length; i++, at += 4) {
      const v = dv.getUint32(at, true)
      if (v >= nv) return null
      indices[i] = v
    }
    if (!positions.every(Number.isFinite)) return null
    // Paint on a triangle the mesh does not have drops the mesh, as a bad index does.
    if (meta.paint && Object.values(meta.paint).some((layer) => Object.keys(layer ?? {}).some((k) => Number(k) >= nt))) return null
    out.push({ name: meta.name, slot: meta.slot, positions, indices, ...(meta.paint ? { paint: meta.paint } : {}), ...(meta.primitive ? { primitive: meta.primitive } : {}) })
  }
  return out
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isVec = (n: number) => (v: unknown): boolean => Array.isArray(v) && v.length === n && v.every(isNum)
const vec2 = isVec(2)
const vec3 = isVec(3)
const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const frameOk = (f: unknown) => f === undefined || (obj(f) && vec3(f['origin']) && vec3(f['normal']) && vec3(f['u']) && vec3(f['v']))
const profileOk = (f: Record<string, unknown>) => Array.isArray(f['loops']) && frameOk(f['frame']) && (f['open'] === undefined || typeof f['open'] === 'boolean') && (f['landmarks'] === undefined || (Array.isArray(f['landmarks']) && f['landmarks'].length <= 64 && f['landmarks'].every(vec2)))
const thickenOk = (t: unknown) => t === undefined || (obj(t) && isNum(t['thicknessMm']) && (t['side'] === undefined || ['outward', 'inward', 'center'].includes(t['side'] as string)))
const edgesOk = (e: unknown) =>
  Array.isArray(e) && e.length > 0 && e.length <= 1000 && e.every((x) => obj(x) && vec3(x['a']) && vec3(x['b']) && vec3(x['face']) && (x['keys'] === undefined || (Array.isArray(x['keys']) && x['keys'].length === 2 && x['keys'].every(keyOk))))

/** One stored follow, or null when it does not read. */
function readFollow(f: unknown): Follow | null {
  if (!obj(f) || typeof f['step'] !== 'string' || !isNum(f['distanceMm'])) return null
  const pts = f['points']
  if (pts === undefined) return { step: f['step'], distanceMm: f['distanceMm'] }
  if (!Array.isArray(pts) || pts.length === 0 || pts.length > 2000 || !pts.every((k) => Number.isInteger(k) && (k as number) >= 0)) return null
  return { step: f['step'], distanceMm: f['distanceMm'], points: pts as number[] }
}

/** The stored follow field: one follow or a list of them. Ones that do not read are left out. */
function readFollows(f: unknown): Pick<Step, 'follow'> {
  const list = (Array.isArray(f) ? f.slice(0, 64) : f === undefined ? [] : [f]).map(readFollow).filter((x): x is Follow => x !== null)
  return followField(list)
}

/** Whether stored params have the fields the app reads; the engine checks the rest on replay. */
/** A face key (absent, or a whole number below 2^52). */
const keyOk = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) > 0 && (v as number) < 2 ** 52)

/** A feature pattern (cad/pattern.ts): its kind and the numbers that kind needs. */
function patternOk(v: unknown): boolean {
  if (!obj(v)) return false
  switch (v['kind']) {
    case 'linear':
      return Number.isInteger(v['count']) && vec2(v['stepMm']) && (v['count2'] === undefined || Number.isInteger(v['count2'])) && (v['step2Mm'] === undefined || vec2(v['step2Mm']))
    case 'circular':
      return Number.isInteger(v['count']) && vec2(v['center']) && (v['angleDeg'] === undefined || isNum(v['angleDeg']))
    case 'points':
      return Array.isArray(v['offsets']) && v['offsets'].length <= 500 && v['offsets'].every(vec2)
    default:
      return false
  }
}

const PAINT_LAYERS = ['color', 'seam', 'support', 'fuzzy']
const SIDES = ['bottom', 'top', 'front', 'back', 'left', 'right']
const stateOk = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255

/** Paint by layer: known layers, triangle indices as keys, texts of hex digits. */
function paintOk(v: unknown): v is PaintTexts {
  if (!obj(v)) return false
  return Object.entries(v).every(
    ([layer, texts]) =>
      PAINT_LAYERS.includes(layer) &&
      obj(texts) &&
      Object.keys(texts).length <= MAX_TRIANGLES &&
      Object.entries(texts).every(([k, t]) => /^\d+$/.test(k) && typeof t === 'string' && t.length <= 4096 && /^[0-9a-fA-F]+$/.test(t)),
  )
}

/** A paint step's target: its kind and the values that kind needs. */
function targetOk(t: unknown): boolean {
  if (!obj(t)) return false
  const angle = t['angleDeg'] === undefined || isNum(t['angleDeg'])
  switch (t['kind']) {
    case 'part':
      return true
    case 'direction': {
      const d = t['direction']
      const pick = t['pick']
      const pickOk = pick === undefined || pick === 'all' || pick === 'largest' || (obj(pick) && vec3(pick['nearest']))
      return (vec3(d) || (typeof d === 'string' && SIDES.includes(d))) && angle && pickOk
    }
    case 'height': {
      const n = (k: string) => t[k] === undefined || isNum(t[k])
      const set = ['below', 'above', 'from', 'to'].filter((k) => t[k] !== undefined).sort().join(',')
      return n('below') && n('above') && n('from') && n('to') && ['below', 'above', 'from,to'].includes(set)
    }
    case 'seed':
      return vec3(t['point']) && keyOk(t['faceKey']) && angle && (t['mode'] === undefined || t['mode'] === 'smart' || t['mode'] === 'bucket')
    case 'replace':
      return stateOk(t['from'])
    default:
      return false
  }
}

/** Sketch constraints: a type, refs that are loop (and segment) indices or numbers, and a dimension's driven flag and typed text. */
function constraintsOk(c: unknown): boolean {
  if (c === undefined) return true
  const ref = (r: unknown) => isNum(r) || (obj(r) && Number.isInteger(r['e']) && (r['seg'] === undefined || Number.isInteger(r['seg'])) && (r['at'] === undefined || typeof r['at'] === 'string'))
  return Array.isArray(c) && c.length <= 10_000 && c.every((k) => obj(k) && typeof k['type'] === 'string' && Object.entries(k).every(([f, v]) => f === 'type' || (f === 'driven' && v === true) || (f === 'expr' && typeof v === 'string' && v.length <= 200) || ref(v)))
}

function paramsOk(p: Record<string, unknown>): boolean {
  switch (p['op']) {
    case 'face.push':
      return vec3(p['at']) && vec3(p['normal']) && isNum(p['distanceMm']) && keyOk(p['faceKey'])
    case 'shape.extrude':
      return obj(p['shape']) && typeof p['shape']['type'] === 'string' && constraintsOk(p['shape']['constraints']) && obj(p['spec']) && isNum(p['spec']['distanceMm']) && frameOk(p['frame']) && (p['font'] === undefined || typeof p['font'] === 'string') && (p['pattern'] === undefined || patternOk(p['pattern']))
    case 'sketch.revolve':
      return Array.isArray(p['loops']) && constraintsOk(p['constraints']) && obj(p['axis']) && vec2(p['axis']['point']) && vec2(p['axis']['direction']) && frameOk(p['frame']) && (p['angleDeg'] === undefined || isNum(p['angleDeg']))
    case 'sketch.sweep':
      return obj(p['profile']) && profileOk(p['profile']) && thickenOk(p['thicken']) && obj(p['path']) && frameOk(p['path']['frame']) && Array.isArray(p['path']['loops']) !== Array.isArray(p['path']['points']) && (p['path']['points'] === undefined || (p['path']['points'] as unknown[]).every((q) => Array.isArray(q) && q.length === 3 && q.every(isNum))) && (p['path']['smooth'] === undefined || typeof p['path']['smooth'] === 'boolean') && (p['scaleEnd'] === undefined || isNum(p['scaleEnd']) || vec2(p['scaleEnd'])) && (p['twistDeg'] === undefined || isNum(p['twistDeg'])) && (p['ease'] === undefined || p['ease'] === 'linear' || p['ease'] === 'smooth') && (p['endProfile'] === undefined || (obj(p['endProfile']) && Array.isArray(p['endProfile']['loops']) && p['endProfile']['frame'] === undefined && (p['endProfile']['open'] === undefined || typeof p['endProfile']['open'] === 'boolean'))) && (p['operation'] === undefined || ['new', 'join', 'cut'].includes(p['operation'] as string))
    case 'sketch.loft':
      return Array.isArray(p['profiles']) && p['profiles'].length >= 2 && p['profiles'].length <= 64 && p['profiles'].every((f: unknown) => obj(f) && profileOk(f)) && (p['smooth'] === undefined || typeof p['smooth'] === 'boolean') && (p['closed'] === undefined || typeof p['closed'] === 'boolean') && thickenOk(p['thicken']) && (p['operation'] === undefined || ['new', 'join', 'cut'].includes(p['operation'] as string))
    case 'subtract':
      return Array.isArray(p['solids']) && typeof p['label'] === 'string'
    case 'hollow':
      return isNum(p['wallMm'])
    case 'repair':
      return true
    case 'simplify':
      return isNum(p['targetRatio'])
    case 'array.merged':
      return obj(p['spec']) && isNum(p['spec']['count'])
    case 'parts.add':
      return typeof p['label'] === 'string'
    case 'parts.order':
      return isOrder(p['order'])
    case 'parts.slot':
      return Number.isInteger(p['slot']) && (p['slot'] as number) >= 1 && (p['slot'] as number) <= MAX_PART_SLOT && typeof p['name'] === 'string'
    case 'edge.fillet':
      return edgesOk(p['edges']) && isNum(p['radiusMm'])
    case 'edge.chamfer':
      return edgesOk(p['edges']) && isNum(p['distanceMm'])
    case 'hole.apply':
      return obj(p['hole']) && vec3(p['hole']['entry']) && vec3(p['hole']['axis']) && isNum(p['hole']['diameterMm']) && isNum(p['hole']['depthMm']) && typeof p['hole']['through'] === 'boolean' && obj(p['spec']) && isNum(p['spec']['diameterMm']) && typeof p['label'] === 'string'
    case 'shell':
      return Array.isArray(p['open']) && p['open'].length <= 64 && p['open'].every((o: unknown) => obj(o) && vec3(o['at']) && vec3(o['normal']) && keyOk(o['key'])) && isNum(p['wallMm'])
    case 'paint':
      return typeof p['layer'] === 'string' && PAINT_LAYERS.includes(p['layer']) && stateOk(p['state']) && targetOk(p['target']) && (p['maxDepth'] === undefined || (Number.isInteger(p['maxDepth']) && (p['maxDepth'] as number) >= 0 && (p['maxDepth'] as number) <= 10))
    case 'thread.apply':
      return obj(p['thread']) && vec3(p['thread']['start']) && vec3(p['thread']['axis']) && isNum(p['thread']['diameterMm']) && isNum(p['thread']['lengthMm']) && typeof p['thread']['internal'] === 'boolean' && typeof p['thread']['openEnd'] === 'boolean' && obj(p['spec']) && typeof p['spec']['size'] === 'string' && isNum(p['spec']['clearanceMm']) && typeof p['label'] === 'string'
    case 'boolean':
      return ['union', 'difference', 'intersection'].includes(p['kind'] as string) && Array.isArray(p['with']) && p['with'].length > 0 && p['with'].length <= 64 && p['with'].every((k) => Number.isInteger(k) && (k as number) >= 0)
    case 'plane.cut':
      return planeOk(p['plane']) && ['both', 'below', 'above'].includes(p['keep'] as string) && (p['name'] === undefined || (typeof p['name'] === 'string' && p['name'].length >= 1 && p['name'].length <= 120))
    case 'split':
      return vec3(p['buildVolumeMm']) && (p['buildVolumeMm'] as number[]).every((n) => n > 0) && (p['marginMm'] === undefined || isNum(p['marginMm']))
    case 'mirror':
      return planeOk(p['plane']) && typeof p['copy'] === 'boolean'
    case 'pattern':
      return Array.isArray(p['steps']) && p['steps'].length > 0 && p['steps'].length <= MAX_STEPS_REPEATED && p['steps'].every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200) && stepPatternOk(p['spec'])
    default:
      return false
  }
}

/** A pattern step's copies: a row or grid, a circle or a mirror plane, each with what it needs (stepPatternProblem). */
function stepPatternOk(v: unknown): boolean {
  if (!obj(v)) return false
  const opt = (k: string) => v[k] === undefined || vec3(v[k])
  switch (v['kind']) {
    case 'mirror':
      return planeOk(v['plane']) && stepPatternProblem(v as StepPattern) === null
    case 'linear':
      return isNum(v['count']) && vec3(v['step']) && (v['count2'] === undefined || isNum(v['count2'])) && opt('step2') && (v['onSurface'] === undefined || v['onSurface'] === true) && stepPatternProblem(v as StepPattern) === null
    case 'circular':
      return isNum(v['count']) && vec3(v['center']) && opt('axis') && (v['angleDeg'] === undefined || isNum(v['angleDeg'])) && (v['rotateCopies'] === undefined || v['rotateCopies'] === true) && stepPatternProblem(v as StepPattern) === null
    default:
      return false
  }
}

/** A permutation of 0 to n - 1, as a parts.order step stores it. */
function isOrder(v: unknown): boolean {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_ITEMS) return false
  const seen = new Set<number>()
  for (const k of v) {
    if (!Number.isInteger(k) || k < 0 || k >= v.length || seen.has(k)) return false
    seen.add(k)
  }
  return true
}

const planeOk = (v: unknown) => obj(v) && vec3(v['point']) && vec3(v['normal']) && (v['normal'] as number[]).some((n) => n !== 0)

/** A part's shape as Add shape made it, or undefined for one that is not a shape this reader knows (it stays a mesh). */
function primitiveOf(v: unknown): PrimitiveSpec | undefined {
  if (!obj(v) || !obj(v['frame'])) return undefined
  const f = v['frame']
  if (!isVec(3)(f['origin']) || !isVec(3)(f['u']) || !isVec(3)(f['normal'])) return undefined
  const frame = { origin: f['origin'] as [number, number, number], u: f['u'] as [number, number, number], normal: f['normal'] as [number, number, number] }
  // u and the normal at right angles and of unit length, as the kernel places a solid
  const d = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
  if (Math.abs(d(frame.u, frame.u) - 1) > 1e-6 || Math.abs(d(frame.normal, frame.normal) - 1) > 1e-6 || Math.abs(d(frame.u, frame.normal)) > 1e-6) return undefined
  const pos = (k: string) => isNum(v[k]) && (v[k] as number) > 0
  if (v['type'] === 'box' && isVec(3)(v['sizeMm']) && (v['sizeMm'] as number[]).every((x) => x > 0)) return { type: 'box', sizeMm: v['sizeMm'] as [number, number, number], frame }
  if (v['type'] === 'cylinder' && pos('diameterMm') && pos('heightMm')) return { type: 'cylinder', diameterMm: v['diameterMm'] as number, heightMm: v['heightMm'] as number, frame }
  if (v['type'] === 'cone' && pos('diameterMm') && pos('heightMm') && isNum(v['topDiameterMm']) && (v['topDiameterMm'] as number) >= 0) return { type: 'cone', diameterMm: v['diameterMm'] as number, topDiameterMm: v['topDiameterMm'] as number, heightMm: v['heightMm'] as number, frame }
  if (v['type'] === 'sphere' && pos('diameterMm')) return { type: 'sphere', diameterMm: v['diameterMm'] as number, frame }
  return undefined
}

const withPrimitive = (v: unknown): { primitive?: PrimitiveSpec } => {
  const p = primitiveOf(v)
  return p ? { primitive: p } : {}
}

function readStored(v: unknown, files: ReadonlyMap<string, Uint8Array>): HistoryMesh[] | null {
  if (!obj(v) || typeof v['file'] !== 'string' || !v['file'].startsWith('Metadata/slicerx_history/') || !Array.isArray(v['parts'])) return null
  const info = v['parts'].map((x) =>
    obj(x) && typeof x['name'] === 'string' && isNum(x['slot']) && (x['paint'] === undefined || paintOk(x['paint']))
      ? { name: x['name'], slot: x['slot'], ...(x['paint'] !== undefined ? { paint: x['paint'] as PaintTexts } : {}), ...withPrimitive(x['primitive']) }
      : null,
  )
  if (info.some((x) => x === null)) return null
  return decodeMeshes(files.get(v['file']), info as { name: string; slot: number; paint?: PaintTexts; primitive?: PrimitiveSpec }[])
}

function readHistory(v: Record<string, unknown>, files: ReadonlyMap<string, Uint8Array>): History | null {
  if (v['exact'] !== undefined && v['exact'] !== true) return null
  const base = v['base'] === null || v['base'] === undefined ? [] : readStored(v['base'], files)
  const raw = v['steps']
  if (!base || !Array.isArray(raw) || raw.length > MAX_STEPS) return null
  const steps: Step[] = []
  for (const s of raw) {
    if (!obj(s) || typeof s['id'] !== 'string' || !Number.isInteger(s['part']) || (s['part'] as number) < -1 || !isVec(16)(s['transform']) || !obj(s['params']) || !paramsOk(s['params'])) return null
    let params = s['params'] as unknown as StepParams
    if (params.op === 'parts.add') {
      const parts = readStored(s['params']['parts'], files)
      if (!parts) return null
      // the part an array copied, by name: kept only as a name a part could have
      const { arrayOf, ...rest } = params
      params = { ...rest, parts, ...(keepsArrayOf(arrayOf) ? { arrayOf } : {}) }
    }
    steps.push({
      id: s['id'],
      part: s['part'] as number,
      transform: s['transform'] as number[],
      params,
      ...readFollows(s['follow']),
      ...(s['suppressed'] === true ? { suppressed: true } : {}),
      ...(typeof s['broken'] === 'string' ? { broken: s['broken'].slice(0, 500) } : {}),
      ...(typeof s['bind'] === 'string' && s['bind'].length <= 200 ? { bind: s['bind'] } : {}),
      ...(typeof s['label'] === 'string' && s['label'].trim() ? { label: s['label'].trim().slice(0, 100) } : {}),
      // the plan feature mimir tagged the step with (design.check matches features by it)
      ...(typeof s['feature'] === 'string' && s['feature'].trim() ? { feature: s['feature'].trim().slice(0, 60) } : {}),
      // the sketches a loft or sweep was made from, which hide while it is live
      ...usesOf(s['uses']),
      // the lean an edit gave what the step made
      ...readTilt(s['tilt']),
      // the call it was made in with other steps, which undo with it (a file from before groups has none)
      ...(typeof s['group'] === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s['group']) ? { group: s['group'] } : {}),
    })
  }
  return { version: 1, base, steps, ...(v['exact'] === true ? { exact: true } : {}), ...(typeof v['ended'] === 'string' ? { ended: v['ended'].slice(0, 200) } : {}), ...placedOf(v['placed']) }
}

/** A loft's or sweep's source sketch ids (Step.uses): up to 64 short strings, else none. */
function usesOf(v: unknown): Pick<Step, 'uses'> {
  if (!Array.isArray(v)) return {}
  const ids = v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 80).slice(0, 64)
  return ids.length ? { uses: ids } : {}
}

/** A body's landing moves (History.placed): two finite numbers within a bed's reach, else none. */
function placedOf(v: unknown): Pick<History, 'placed'> {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 100_000)) return {}
  return v[0] === 0 && v[1] === 0 ? {} : { placed: [v[0] as number, v[1] as number] }
}

const MAX_ITEMS = 4000

/**
 * A version 3 file's bodies as version 2 objects: each body with the live features on it, in timeline order, their
 * sketches put back in (design.ts, featureParams). The steps are then read as any others. Null when it does not read.
 */
function designObjects(j: Record<string, unknown>, all = false): Record<string, unknown>[] | null {
  const items = j['items']
  const marker = j['marker']
  if (!Array.isArray(j['bodies']) || !Array.isArray(items) || items.length > MAX_ITEMS || !Number.isInteger(marker) || (marker as number) < 0) return null
  const sketches = new Map<string, Record<string, unknown>>()
  const steps = new Map<string, unknown[]>()
  // a feature whose sketch is gone drops its body's history, not the others
  const bad = new Set<string>()
  for (const it of all ? items : items.slice(0, marker as number)) {
    if (!obj(it)) return null
    if (it['kind'] === 'sketch') {
      if (typeof it['id'] !== 'string' || !Array.isArray(it['loops']) || !frameOk(it['frame']) || (it['constraints'] !== undefined && !Array.isArray(it['constraints']))) return null
      sketches.set(it['id'], it)
      continue
    }
    if (it['kind'] !== 'feature' || typeof it['body'] !== 'string' || !obj(it['params'])) return null
    const { kind: _k, body, sketch, projected: _p, ...step } = it
    let params = it['params']
    if (sketch !== undefined) {
      const k = typeof sketch === 'string' ? sketches.get(sketch) : undefined
      if (!k) {
        bad.add(body as string)
        continue
      }
      // a feature takes the projections it was made with, never one projected later
      const taken = Array.isArray(it['projected']) ? (it['projected'] as unknown[]) : []
      const loops = Array.isArray(k['loops']) ? (k['loops'] as unknown[]).filter((l) => !obj(l) || l['projected'] === undefined || taken.includes(l['projected'])) : k['loops']
      const frame = k['frame'] === undefined ? {} : { frame: k['frame'] }
      const cons = k['constraints'] === undefined ? {} : { constraints: k['constraints'] }
      if (params['op'] === 'shape.extrude') params = { ...params, ...frame, shape: { type: 'sketch', loops, ...cons } }
      else if (params['op'] === 'sketch.revolve') params = { ...params, ...frame, ...cons, loops }
      else return null
    }
    const list = steps.get(body as string) ?? []
    list.push({ ...step, params })
    steps.set(body as string, list)
  }
  return j['bodies'].map((b) => (obj(b) && typeof b['object'] === 'string' ? { ...b, steps: bad.has(b['object']) ? null : (steps.get(b['object']) ?? []) } : {}))
}

/** The stored objects of a file version this reads, or null. */
function storedObjects(j: unknown): unknown[] | null {
  if (!obj(j)) return null
  if (j['version'] === DESIGN_FILE_VERSION) return designObjects(j)
  if ((j['version'] !== 1 && j['version'] !== HISTORY_FILE_VERSION) || !Array.isArray(j['objects'])) return null
  return j['objects']
}

function requireExactHistories(j: unknown, objectIds: ReadonlySet<string>, read: ReadonlyMap<string, History>): void {
  if (!obj(j)) return
  const bodies = [j['objects'], j['bodies']].flatMap(v => Array.isArray(v) ? v : [])
  for (const b of bodies) {
    if (!obj(b) || b['exact'] === undefined || typeof b['object'] !== 'string' || !objectIds.has(b['object'])) continue
    if (b['exact'] !== true || !read.get(b['object'])?.exact) throw new Error(`The required exact history of object ${b['object']} could not be read. The project was not opened as a mesh.`)
  }
}

const isMat4 = isVec(16)
const isEdge = (e: unknown): boolean => obj(e) && vec3(e['a']) && vec3(e['b']) && vec3(e['face']) && (e['center'] === undefined || vec3(e['center'])) && (e['keys'] === undefined || (Array.isArray(e['keys']) && e['keys'].length === 2 && e['keys'].every(isNum)))

// a sketch's projections; a malformed one is dropped, and its curves stay as the sketch's own
function projectionsOf(v: unknown): Pick<SketchItem, 'projections'> {
  if (!Array.isArray(v)) return {}
  const out: Projection[] = []
  for (const p of v.slice(0, 256)) {
    if (!obj(p) || typeof p['id'] !== 'string' || (p['mode'] !== 'reference' && p['mode'] !== 'real') || !obj(p['source'])) continue
    const s = p['source']
    if (typeof s['body'] !== 'string') continue
    const placed = Number.isInteger(s['part']) && (s['part'] as number) >= 0 && isMat4(s['transform'])
    const f = s['face']
    const ok =
      s['kind'] === 'silhouette' ||
      (s['kind'] === 'edges' && placed && Array.isArray(s['edges']) && s['edges'].length > 0 && s['edges'].length <= 256 && s['edges'].every(isEdge)) ||
      (s['kind'] === 'face' && placed && obj(f) && vec3(f['at']) && vec3(f['normal']) && (f['key'] === undefined || isNum(f['key'])))
    if (!ok) continue
    out.push({ id: p['id'], source: s as unknown as ProjectSource, mode: p['mode'], ...(typeof p['lost'] === 'string' ? { lost: p['lost'].slice(0, 300) } : {}) })
  }
  return out.length ? { projections: out } : {}
}

/**
 * How many projection ids each sketch has handed out: its saved count, or the highest id its projections, its loops or
 * the features on it name, so an id a file dropped or never counted is not handed out again.
 */
function projectionCounts(items: readonly unknown[]): Map<string, number> {
  const out = new Map<string, number>()
  const see = (sketch: unknown, id: unknown) => {
    const n = typeof id === 'number' ? id : idNumber(id)
    if (typeof sketch === 'string' && Number.isInteger(n) && n > 0 && n < MAX_PROJECTION) out.set(sketch, Math.max(out.get(sketch) ?? 0, n))
  }
  for (const it of items) {
    if (!obj(it)) continue
    if (it['kind'] === 'sketch') {
      see(it['id'], it['nextProjection'])
      if (Array.isArray(it['projections'])) for (const p of it['projections'].slice(0, 256)) if (obj(p)) see(it['id'], p['id'])
      if (Array.isArray(it['loops'])) for (const l of it['loops']) if (obj(l)) see(it['id'], l['projected'])
    } else if (Array.isArray(it['projected'])) for (const id of it['projected'].slice(0, 256)) see(it['sketch'], id)
  }
  return out
}

// the body a sketch sits on; anything malformed is dropped, the sketch kept
function onOf(v: unknown): Pick<SketchItem, 'on'> {
  if (!obj(v) || typeof v['body'] !== 'string' || !Number.isInteger(v['part']) || (v['part'] as number) < 0) return {}
  return { on: { body: v['body'], part: v['part'] as number } }
}

// the one design a sketch was drawn for and where it stood: a body id and 16 finite numbers, else none
function drawnForOf(v: unknown): Pick<SketchItem, 'drawnFor'> {
  if (!Array.isArray(v) || v.length !== 1 || !obj(v[0])) return {}
  const { design, transform } = v[0] as Record<string, unknown>
  if (typeof design !== 'string' || !Array.isArray(transform) || transform.length !== 16 || !transform.every((x) => typeof x === 'number' && Number.isFinite(x))) return {}
  return { drawnFor: [{ design, transform: transform as number[] }] }
}

/**
 * The plate's design timeline (design.ts), bodies by 3MF object id: a version 3 file as it was saved, rolled back
 * steps included, or an older file's histories merged by when each step was made. Null when there is none; a body
 * whose history does not read is left out with its features. With `standing`, where each object stands by its 3MF
 * object id, a file written before sketches moved with what they are drawn for or on opens with each sketch where that
 * app showed it (pinnedOlder): a version 3 file at its stored frame, a version 1 or 2 file moved with its body.
 */
export function parseTimeline(files: ReadonlyMap<string, Uint8Array>, objectIds: ReadonlySet<string>, standing?: PlaceOf): Timeline | null {
  const t = readTimeline(files, objectIds)
  if (!t || !standing) return t
  // written before sketches moved with what they are drawn for or on: each opens where that app showed it, at its stored
  // frame from a design file, moved with its body since its step from an object history file
  const j = JSON.parse(new TextDecoder().decode(files.get('Metadata/slicerx_history.json')!)) as Record<string, unknown>
  if (j['version'] !== DESIGN_FILE_VERSION) return pinnedOlder(t, standing, true)
  return j['sketchAnchors'] === SKETCH_ANCHORS ? t : pinnedOlder(t, standing)
}

function readTimeline(files: ReadonlyMap<string, Uint8Array>, objectIds: ReadonlySet<string>): Timeline | null {
  const bytes = files.get('Metadata/slicerx_history.json')
  if (!bytes) return null
  let j: unknown
  try {
    j = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  if (!obj(j)) return null
  if (j['version'] !== DESIGN_FILE_VERSION) {
    const h = parseHistories(files, objectIds)
    return h.size ? timelineOf([...h].map(([id, history]) => ({ id, history }))) : null
  }
  const objects = designObjects(j, true)
  if (!objects) {
    requireExactHistories(j, objectIds, new Map())
    return null
  }
  const histories = new Map<string, History>()
  for (const o of objects) {
    if (!obj(o) || typeof o['object'] !== 'string' || !objectIds.has(o['object']) || histories.has(o['object'])) continue
    try {
      const h = readHistory(o, files)
      if (h) histories.set(o['object'], h)
    } catch {
      // that body is left out
    }
  }
  requireExactHistories(j, objectIds, histories)
  if (!histories.size) return null
  const items: Item[] = []
  let marker = 0
  const counted = projectionCounts(j['items'] as unknown[])
  ;(j['items'] as unknown[]).forEach((it, i) => {
    if (!obj(it)) return
    if (it['kind'] === 'sketch') {
      const name = typeof it['name'] === 'string' && it['name'].trim() ? it['name'].trim().slice(0, 100) : 'Sketch'
      const n = counted.get(it['id'] as string) ?? 0
      const k: SketchItem = { kind: 'sketch', id: it['id'] as string, name, ...(it['frame'] ? { frame: it['frame'] as NonNullable<SketchItem['frame']> } : {}), loops: it['loops'] as SketchItem['loops'], ...(Array.isArray(it['constraints']) ? { constraints: it['constraints'] } : {}), ...onOf(it['on']), ...drawnForOf(it['drawnFor']), ...projectionsOf(it['projections']), ...(n ? { nextProjection: n } : {}) }
      items.push(k)
    } else {
      const step = histories.get(it['body'] as string)?.steps.find((s) => s.id === it['id'])
      if (!step) return
      items.push(featureOf(step, it['body'] as string, typeof it['sketch'] === 'string' ? it['sketch'] : undefined))
    }
    if (i < (j['marker'] as number)) marker = items.length
  })
  const bodies = [...histories].map(([id, h]) => ({ id, base: h.base, ...(h.exact ? { exact: true as const } : {}), ...(h.ended ? { ended: h.ended } : {}), ...(h.placed ? { placed: h.placed } : {}) }))
  return { bodies, items, marker }
}

/** Histories by 3MF object id. A newer version, a missing object or a part that does not read leaves that history out. */
export function parseHistories(files: ReadonlyMap<string, Uint8Array>, objectIds: ReadonlySet<string>): Map<string, History> {
  const out = new Map<string, History>()
  const bytes = files.get('Metadata/slicerx_history.json')
  if (!bytes) return out
  let j: unknown
  try {
    j = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return out
  }
  const objects = storedObjects(j)
  if (!objects) {
    requireExactHistories(j, objectIds, out)
    return out
  }
  for (const o of objects) {
    if (!obj(o) || typeof o['object'] !== 'string' || !objectIds.has(o['object']) || out.has(o['object'])) continue
    try {
      const h = readHistory(o, files)
      if (h) out.set(o['object'], h)
    } catch {
      // That object opens without its history.
    }
  }
  requireExactHistories(j, objectIds, out)
  return out
}

/**
 * The sentence to show when saved CAD history does not read (a damaged or hand-edited file): the objects open as they
 * print, without that history, and the person is told so rather than finding the timeline empty. Null when every
 * history saved for the project's objects was read, or when the histories are from a newer SlicerX ([`historyNewer`]
 * says so then).
 */
export function historyLost(files: ReadonlyMap<string, Uint8Array>, objectIds: ReadonlySet<string>, read: ReadonlyMap<string, History>): string | null {
  const bytes = files.get('Metadata/slicerx_history.json')
  if (!bytes) return null
  const whole = "This project's CAD history could not be read, so its objects open without it."
  let j: unknown
  try {
    j = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return whole
  }
  if (!obj(j)) return whole
  if (typeof j['version'] === 'number' && j['version'] > DESIGN_FILE_VERSION) return null
  const objects = storedObjects(j)
  if (!objects) return whole
  const lost = objects.filter((o) => obj(o) && typeof o['object'] === 'string' && objectIds.has(o['object']) && !read.has(o['object'])).length
  if (lost === 0) return null
  return lost === 1 ? 'The CAD history of 1 object could not be read, so it opens without it.' : `The CAD history of ${lost} objects could not be read, so they open without it.`
}

/**
 * The sentence to show when the project's histories come from a newer app than this one reads: the objects
 * open, without their history. Null when there is nothing to say.
 */
export function historyNewer(files: ReadonlyMap<string, Uint8Array>): string | null {
  const bytes = files.get('Metadata/slicerx_history.json')
  if (!bytes) return null
  try {
    const v = (JSON.parse(new TextDecoder().decode(bytes)) as { version?: unknown }).version
    if (typeof v === 'number' && v > DESIGN_FILE_VERSION) {
      return `This project's CAD history was saved by a newer ${productName()} (history version ${v}). Its objects open without their history; update ${productName()} to edit it.`
    }
  } catch {
    // A damaged part opens without histories, as before.
  }
  return null
}
