// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opens each Vault starter the way the app does, on a Bambu Lab A1 with a 0.4 mm nozzle, PLA and the Standard tier,
// slices it with the native engine and lists everything the person would be warned about: the engine's warnings, the
// objects list's fit notes and the toasts from opening. It runs only when STARTERS_DIR names a folder of .sx3mf files,
// SX_BIN the sx command and SX_GEOM_BIN the sx-geom command; STARTERS_OUT gets one JSON report per file.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Host, MeshHandle, MeshPart, SliceRequest } from '@slicerx/contracts'
import { encodeParts } from '../../core/web/src/parts'
import { setGeomProvider } from '../src/geom/client'
import { previewStats } from '../src/lib/preview-stats'
import { fitNotes } from '../src/plate/fit-notes'
import { checkObject, checkTouches } from '../src/plate/fit-run'
import { objectFit } from '../src/plate/fit-state'
import { openModelBytes, slicePlate } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { get, set } from '../src/state/store'
import { resolveConfig } from '../src/adapters/config'
import { minGapFor } from '../src/plate/fit-check'

const DIR = process.env['STARTERS_DIR']
const SX = process.env['SX_BIN'] ?? 'sx'
const GEOM = process.env['SX_GEOM_BIN'] ?? 'sx-geom'
const OUT = process.env['STARTERS_OUT'] ?? '/tmp/starters-audit'
const files = DIR && existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.sx3mf')).sort() : []

setGeomProvider({
  async call<T>(op: string, request: unknown): Promise<T> {
    const r = spawnSync(GEOM, [op], { input: JSON.stringify(request), maxBuffer: 1 << 30 })
    const out = JSON.parse(r.stdout.toString()) as Record<string, unknown>
    if (r.status !== 0) throw new Error(JSON.stringify(out))
    return out as T
  },
})

let seq = 0
const work = join(OUT, 'work')
const meshes = new Map<string, string>()
const previews = new Map<string, Uint8Array>()

function handleOf(id: string, name: string, parts: MeshPart[]): MeshHandle {
  let tris = 0
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) {
    tris += p.indices.length / 3
    for (let i = 0; i < p.positions.length; i++) {
      lo[i % 3] = Math.min(lo[i % 3]!, p.positions[i]!)
      hi[i % 3] = Math.max(hi[i % 3]!, p.positions[i]!)
    }
  }
  return { id, hash: id, name, triangles: tris, bboxMm: [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!], openEdges: 0, parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: p.indices.length / 3 })) }
}

const slicer = {
  async loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> {
    const id = `m${++seq}`
    const path = join(work, `${id}.raw`)
    writeFileSync(path, encodeParts(parts))
    meshes.set(id, path)
    return handleOf(id, name, parts)
  },
  async loadModel(data: ArrayBuffer, fileName: string): Promise<MeshHandle> {
    const id = `m${++seq}`
    const path = join(work, `${id}-${fileName.replace(/[^\w.]/g, '_')}`)
    writeFileSync(path, new Uint8Array(data))
    meshes.set(id, path)
    return { id, hash: id, name: fileName, triangles: 0, bboxMm: [0, 0, 0], openEdges: 0, parts: [] }
  },
  async slice(req: SliceRequest) {
    const id = `s${++seq}`
    const o = (req.options ?? {}) as Record<string, unknown>
    const options = { flavor: o['flavor'], layerTopsMm: o['layerTopsMm'], heightRanges: o['heightRanges'], machineLimits: o['machineLimits'], trustedGcode: o['trustedGcode'], layerGcode: o['layerGcode'] }
    const dir = join(work, id)
    mkdirSync(dir, { recursive: true })
    const used = Object.fromEntries(req.plate.objects.map((ob) => [ob.mesh, meshes.get(ob.mesh)!]))
    writeFileSync(join(dir, 'request.json'), JSON.stringify({ plate: req.plate, config: req.config, options, meshes: used }))
    const r = spawnSync(SX, ['slice', '--request', join(dir, 'request.json'), '--out-dir', dir], { maxBuffer: 1 << 30 })
    if (r.status !== 0) throw new Error(`sx: ${r.stderr.toString()}`)
    const report = JSON.parse(r.stdout.toString()) as Record<string, unknown>
    previews.set(id, readFileSync(join(dir, 'slice.sxpv')))
    return { ...report, id, layerZ: Float32Array.from((report['layerZ'] as number[]) ?? []), layerTimeS: Float32Array.from((report['layerTimeS'] as number[]) ?? []) }
  },
  async getPreview(id: string): Promise<ArrayBuffer> {
    const b = previews.get(id)!
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  },
}

const host = { kind: 'desktop', capabilities: { threads: 1 }, slicer } as unknown as Host

describe.skipIf(files.length === 0)('Vault starters on the A1, 0.4 mm, PLA, Standard', () => {
  mkdirSync(work, { recursive: true })
  for (const f of files) {
    it(f, async () => {
      set({ printerModel: { vendor: 'Bambu Lab', model: 'A1' }, goal: 'standard' })
      await profileReady()
      const toasts: string[] = []
      const stop = (await import('../src/state/store')).appStore.subscribe((s, prev) => {
        if (s.toast && s.toast !== prev.toast) toasts.push(`${s.toast.tone ?? 'info'}: ${s.toast.text}`)
      })
      const bytes = readFileSync(join(DIR!, f))
      await openModelBytes(host, f, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, undefined, { fresh: true })
      await profileReady()
      await slicePlate(host, { auto: true })
      stop()
      const s = get()
      const cfg = resolveConfig(s.easy, s.overrides)
      const layerMm = Number(cfg['layer_height']) || 0.2
      const ac = new AbortController()
      const notes: string[] = []
      const printed = s.plate.filter((p) => p.printable !== false)
      for (const e of printed.filter((p) => p.parts.length > 1)) await checkObject(e, minGapFor(s), layerMm, ac.signal)
      const touches = printed.length > 1 ? await checkTouches(printed, minGapFor(s), layerMm, ac.signal) : []
      for (const e of printed) for (const n of fitNotes(e.id, objectFit(e.id), touches, (id) => s.plate.find((p) => p.id === id)?.name ?? id, layerMm)) notes.push(`${e.name}: ${n.text} [${n.which.join('; ')}]`)
      const slice = get().slice
      const result = slice.status === 'done' ? slice.result : null
      const stats = get().preview ? previewStats(get().preview!) : null
      const report = {
        file: f,
        status: slice.status,
        error: slice.status === 'error' ? slice.message : undefined,
        printer: s.profile?.printerId,
        filaments: s.profile?.filamentIds,
        config: { layer_height: cfg['layer_height'], max_bridge_length: cfg['max_bridge_length'], enable_support: cfg['enable_support'], smart_layer: cfg['smart_layer'], nozzle_temperature: cfg['nozzle_temperature'] },
        objects: s.plate.map((p) => ({ name: p.name, parts: p.parts.length, colors: p.colors })),
        marks: get().layerMarks[s.activePlate] ?? [],
        warnings: result?.warnings ?? [],
        fitNotes: notes,
        toasts,
        features: stats?.features.map((x) => ({ feature: x.feature, lengthM: Number(x.lengthM.toFixed(2)) })),
        stats: result?.stats,
        layerCount: result?.layerCount,
      }
      writeFileSync(join(OUT, `${f}.json`), JSON.stringify(report, null, 2))
      expect(slice.status).toBe('done')
    })
  }
})
