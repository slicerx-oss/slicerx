// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads the CAD history parts of a project (docs/cad-history.md, "Storage"), written by
// history-file.ts. Untrusted: a bad step or mesh drops that object's history, never the project.
import { HISTORY_FILE_VERSION } from './history-file'
import { followField, type Follow, type History, type HistoryMesh, type Step, type StepParams } from '../cad/history/model'
import { BIN_VERSION, MAGIC } from './history-file'

const MAX_STEPS = 2000
const MAX_TRIANGLES = 20_000_000

/** The meshes of a binary part with their names and slots from the JSON. Null when the part does not read. */
export function decodeMeshes(bytes: Uint8Array | undefined, info: readonly { name: string; slot: number }[]): HistoryMesh[] | null {
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
    out.push({ name: meta.name, slot: meta.slot, positions, indices })
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

function paramsOk(p: Record<string, unknown>): boolean {
  switch (p['op']) {
    case 'face.push':
      return vec3(p['at']) && vec3(p['normal']) && isNum(p['distanceMm']) && keyOk(p['faceKey'])
    case 'shape.extrude':
      return obj(p['shape']) && typeof p['shape']['type'] === 'string' && obj(p['spec']) && isNum(p['spec']['distanceMm']) && frameOk(p['frame']) && (p['font'] === undefined || typeof p['font'] === 'string') && (p['pattern'] === undefined || patternOk(p['pattern']))
    case 'sketch.revolve':
      return Array.isArray(p['loops']) && obj(p['axis']) && vec2(p['axis']['point']) && vec2(p['axis']['direction']) && frameOk(p['frame']) && (p['angleDeg'] === undefined || isNum(p['angleDeg']))
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
    case 'thread.apply':
      return obj(p['thread']) && vec3(p['thread']['start']) && vec3(p['thread']['axis']) && isNum(p['thread']['diameterMm']) && isNum(p['thread']['lengthMm']) && typeof p['thread']['internal'] === 'boolean' && typeof p['thread']['openEnd'] === 'boolean' && obj(p['spec']) && typeof p['spec']['size'] === 'string' && isNum(p['spec']['clearanceMm']) && typeof p['label'] === 'string'
    default:
      return false
  }
}

function readStored(v: unknown, files: ReadonlyMap<string, Uint8Array>): HistoryMesh[] | null {
  if (!obj(v) || typeof v['file'] !== 'string' || !v['file'].startsWith('Metadata/slicerx_history/') || !Array.isArray(v['parts'])) return null
  const info = v['parts'].map((x) => (obj(x) && typeof x['name'] === 'string' && isNum(x['slot']) ? { name: x['name'], slot: x['slot'] } : null))
  if (info.some((x) => x === null)) return null
  return decodeMeshes(files.get(v['file']), info as { name: string; slot: number }[])
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
  if (!obj(j) || (j['version'] !== 1 && j['version'] !== HISTORY_FILE_VERSION) || !Array.isArray(j['objects'])) return out
  for (const o of j['objects']) {
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
 * The sentence to show when the project's histories come from a newer SlicerX than this one reads: the objects
 * open, without their history. Null when there is nothing to say.
 */
export function historyNewer(files: ReadonlyMap<string, Uint8Array>): string | null {
  const bytes = files.get('Metadata/slicerx_history.json')
  if (!bytes) return null
  try {
    const v = (JSON.parse(new TextDecoder().decode(bytes)) as { version?: unknown }).version
    if (typeof v === 'number' && v > HISTORY_FILE_VERSION) {
      return `This project's CAD history was saved by a newer SlicerX (history version ${v}). Its objects open without their history; update SlicerX to edit it.`
    }
  } catch {
    // A damaged part opens without histories, as before.
  }
  return null
}
