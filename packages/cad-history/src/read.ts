// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads the CAD history parts of a project (docs/cad-history.md, "Storage"), written by
// file.ts. Untrusted: a bad step or mesh drops that object's history, never the project.
import { productName } from '@slicerx/contracts/brand'
import { featureOf, timelineOf, type Item, type SketchItem, type Timeline } from './design'
import { BIN_VERSION, DESIGN_FILE_VERSION, HISTORY_FILE_VERSION, MAGIC } from './file'
import { followField, type Follow, type History, type HistoryMesh, type PaintTexts, type PrimitiveSpec, type Step, type StepParams } from './model'

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
      return planeOk(p['plane']) && ['both', 'below', 'above'].includes(p['keep'] as string)
    case 'split':
      return vec3(p['buildVolumeMm']) && (p['buildVolumeMm'] as number[]).every((n) => n > 0) && (p['marginMm'] === undefined || isNum(p['marginMm']))
    case 'mirror':
      return planeOk(p['plane']) && typeof p['copy'] === 'boolean'
    default:
      return false
  }
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
      params = { ...params, parts }
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
    })
  }
  return { version: 1, base, steps, ...(typeof v['ended'] === 'string' ? { ended: v['ended'].slice(0, 200) } : {}) }
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
    const { kind: _k, body, sketch, ...step } = it
    let params = it['params']
    if (sketch !== undefined) {
      const k = typeof sketch === 'string' ? sketches.get(sketch) : undefined
      if (!k) {
        bad.add(body as string)
        continue
      }
      const loops = k['loops']
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

// the body a sketch sits on; anything malformed is dropped, the sketch kept
function onOf(v: unknown): Pick<SketchItem, 'on'> {
  if (!obj(v) || typeof v['body'] !== 'string' || !Number.isInteger(v['part']) || (v['part'] as number) < 0) return {}
  return { on: { body: v['body'], part: v['part'] as number } }
}

/**
 * The plate's design timeline (design.ts), bodies by 3MF object id: a version 3 file as it was saved, rolled back
 * steps included, or an older file's histories merged by when each step was made. Null when there is none; a body
 * whose history does not read is left out with its features.
 */
export function parseTimeline(files: ReadonlyMap<string, Uint8Array>, objectIds: ReadonlySet<string>): Timeline | null {
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
  if (!objects) return null
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
  if (!histories.size) return null
  const items: Item[] = []
  let marker = 0
  ;(j['items'] as unknown[]).forEach((it, i) => {
    if (!obj(it)) return
    if (it['kind'] === 'sketch') {
      const name = typeof it['name'] === 'string' && it['name'].trim() ? it['name'].trim().slice(0, 100) : 'Sketch'
      const k: SketchItem = { kind: 'sketch', id: it['id'] as string, name, ...(it['frame'] ? { frame: it['frame'] as NonNullable<SketchItem['frame']> } : {}), loops: it['loops'] as SketchItem['loops'], ...(Array.isArray(it['constraints']) ? { constraints: it['constraints'] } : {}), ...onOf(it['on']) }
      items.push(k)
    } else {
      const step = histories.get(it['body'] as string)?.steps.find((s) => s.id === it['id'])
      if (!step) return
      items.push(featureOf(step, it['body'] as string, typeof it['sketch'] === 'string' ? it['sketch'] : undefined))
    }
    if (i < (j['marker'] as number)) marker = items.length
  })
  const bodies = [...histories].map(([id, h]) => ({ id, base: h.base, ...(h.ended ? { ended: h.ended } : {}) }))
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
  if (!objects) return out
  for (const o of objects) {
    if (!obj(o) || typeof o['object'] !== 'string' || !objectIds.has(o['object']) || out.has(o['object'])) continue
    try {
      const h = readHistory(o, files)
      if (h) out.set(o['object'], h)
    } catch {
      // That object opens without its history.
    }
  }
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
