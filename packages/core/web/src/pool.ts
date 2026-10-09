// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The browser slicer: a pool of Web Workers, each with its own sx-wasm
// instance. A slice is split into one layer range per worker; the core
// guarantees that the chunks concatenate into the same bytes as a single run.
import { sliceClock } from './clock'
import type {
  GcodeExport,
  GcodeTarget,
  MeshHandle,
  MeshPart,
  ProjectMetadata,
  SliceProgress,
  SliceRequest,
  SliceResult,
  SliceStage,
  SliceWarning,
  SliceWarningCode,
  SlicerHost,
} from '@slicerx/contracts'
import type { FromWorker, MeshInfo, ShardInfo, ToWorker } from './protocol'
import { decodeParts, encodeParts } from './parts'
import { shardCount } from './shards'
import { stitchPreview } from './stitch'

/** A time the caller set on the request wins over the clock (tests and reproducible runs). */
function pickClock(o: unknown): { nowUnix?: number; nowOffsetMinutes?: number } {
  const r = (o ?? {}) as { nowUnix?: number; nowOffsetMinutes?: number }
  return { ...(typeof r.nowUnix === 'number' ? { nowUnix: r.nowUnix } : {}), ...(typeof r.nowOffsetMinutes === 'number' ? { nowOffsetMinutes: r.nowOffsetMinutes } : {}) }
}

export interface PoolOptions {
  /**
   * Most workers the pool grows to; defaults to navigator.hardwareConcurrency, at most 16.
   * The pool starts with one worker and adds the rest when a slice has shards for them.
   */
  workers?: number
  /** URL of sx_wasm.wasm, or an already compiled module. */
  wasm: string | URL | WebAssembly.Module
  /** Creates a worker; the default loads ./worker.ts as a module worker. */
  createWorker?: () => Worker
  /** Layer ranges per worker for one slice; more ranges balance better and repeat more halo layers. */
  shardsPerWorker?: number
  /** Slice a small cube in every worker at start-up so the first real slice runs optimized code. Default true. */
  warmUp?: boolean
}

interface Pending {
  resolve: (msg: FromWorker) => void
  reject: (e: Error) => void
}

interface StoredSlice {
  gcode: ArrayBuffer[]
  /** `bgcode` when the profile asked for binary G-code. */
  format: 'gcode' | 'bgcode'
  preview: ArrayBuffer | null
  /** The preview went to the page (getPreview hands it over once and keeps no copy). */
  previewTaken?: boolean
  previewChunks: ArrayBuffer[]
  /** The name `filename_format` gives the file, when the engine returned one. */
  fileName?: string
  /** 1-based line of each layer marker (`;LAYER_CHANGE`, `; CHANGE_LAYER` on a Bambu Lab printer) in the finished file, for the preview's G-code lines. */
  layerLines: number[]
  /** 1-based lines of the progress lines finalize added, which the preview's line count skips. */
  progressLines: number[]
  /** The layers' seconds as the finished file reads them, for the preview's time table. */
  layerTimeS: number[]
}

class PoolWorker {
  readonly worker: Worker
  private readonly pending = new Map<number, Pending>()
  private nextCall = 1
  readonly ready: Promise<void>
  /** Meshes this worker has loaded. */
  readonly meshIds = new Set<string>()
  /** Why the worker stopped (it errored, a message could not be read, or it was retired); null while it works. */
  failed: Error | null = null

  constructor(worker: Worker, module: WebAssembly.Module, warmUp: boolean, private readonly onFail: (w: PoolWorker) => void = () => undefined) {
    this.worker = worker
    this.ready = new Promise((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<FromWorker>) => {
        const msg = ev.data
        if (msg.type === 'ready') {
          resolve()
          return
        }
        if (msg.type === 'error' && msg.call === 0) {
          reject(new Error(`Worker start failed: ${msg.message}`))
          return
        }
        const p = this.pending.get(msg.call)
        if (!p) return
        this.pending.delete(msg.call)
        if (msg.type === 'error') p.reject(new Error(msg.message))
        else p.resolve(msg)
      }
      worker.onerror = (ev) => {
        const e = new Error(`A slicer worker stopped: ${ev.message || 'it failed'}`)
        reject(e)
        this.fail(e)
      }
      worker.onmessageerror = () => this.fail(new Error('A slicer worker sent a message that could not be read'))
    })
    // A start that failed is handled by whoever awaits `ready`; the rejection is not left unhandled here.
    this.ready.catch(() => undefined)
    this.send({ type: 'init', module, warmUp })
  }

  /** Stops the worker: every call waiting on it is rejected with `e`, and later calls fail at once. */
  fail(e: Error): void {
    if (this.failed) return
    this.failed = e
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const p of waiting) p.reject(e)
    this.worker.terminate()
    this.onFail(this)
  }

  send(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer)
  }

  call(build: (call: number) => ToWorker, transfer: Transferable[] = []): Promise<FromWorker> {
    if (this.failed) return Promise.reject(this.failed)
    const call = this.nextCall++
    return new Promise((resolve, reject) => {
      this.pending.set(call, { resolve, reject })
      this.send(build(call), transfer)
    })
  }
}

/** A part held by weak references to its arrays and its paint (when the part has any), which stay the caller's. */
interface WeakPart {
  name: string
  slot: number
  positions: WeakRef<Float32Array>
  indices: WeakRef<Uint32Array>
  paint?: WeakRef<object>
}

function weakPart(p: MeshPart): WeakPart {
  const paint = (p as { paint?: object }).paint
  return { name: p.name, slot: p.slot, positions: new WeakRef(p.positions), indices: new WeakRef(p.indices), ...(paint ? { paint: new WeakRef(paint) } : {}) }
}

/** The parts again, or null when the caller dropped any of their arrays or paint. */
function strongParts(list: readonly WeakPart[]): MeshPart[] | null {
  const out: MeshPart[] = []
  for (const w of list) {
    const positions = w.positions.deref()
    const indices = w.indices.deref()
    const paint = w.paint?.deref()
    if (!positions || !indices || (w.paint && !paint)) return null
    out.push({ name: w.name, slot: w.slot, positions, indices, ...(paint ? { paint } : {}) } as MeshPart)
  }
  return out
}

const WARNING_CODES: readonly SliceWarningCode[] = ['open_edges', 'thin_wall', 'floating_region', 'long_bridge', 'outside_bed', 'unsupported_setting', 'manual_step']

function toWarning(w: ShardInfo['warnings'][number]): SliceWarning {
  const code = WARNING_CODES.find((c) => c === w.code) ?? 'unsupported_setting'
  const out: SliceWarning = { code, message: w.message }
  if (w.layer !== undefined) out.layer = w.layer
  return out
}


async function sha256Hex(parts: ArrayBuffer[]): Promise<{ hex: string; bytes: number }> {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const all = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    all.set(new Uint8Array(p), o)
    o += p.byteLength
  }
  const digest = await crypto.subtle.digest('SHA-256', all)
  return { hex: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''), bytes: total }
}

export async function createWasmSlicer(opts: PoolOptions): Promise<SlicerHost> {
  const module =
    opts.wasm instanceof WebAssembly.Module ? opts.wasm : await WebAssembly.compileStreaming(fetch(opts.wasm))
  const count = Math.max(1, Math.min(16, opts.workers ?? (globalThis.navigator?.hardwareConcurrency || 4)))
  const make = opts.createWorker ?? (() => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }))
  const shardsPerWorker = Math.max(1, Math.min(8, opts.shardsPerWorker ?? 8))
  const warmUp = opts.warmUp ?? true
  // One worker at start; the others start when a slice has shards for them and load the meshes already
  // in the pool before they take a shard. A worker joins `workers` only once it holds every mesh.
  const workers: PoolWorker[] = []
  let starting = 0
  const meshes = new Map<string, MeshHandle>()
  const slices = new Map<string, StoredSlice>()
  let nextId = 1
  // What each mesh was loaded from, so a pool whose every worker stopped can start a new one with the same meshes
  // and paint. For parts, weak references to the caller's own arrays and paint (no copy, and nothing kept alive the
  // caller dropped), encoded again only for a restart; for a file the caller passed as bytes, those bytes as a Blob
  // (outside the page's heap).
  const sources = new Map<string, { fileName: string; parts?: WeakPart[]; blob?: Blob }>()
  let restarting: Promise<void> | null = null

  /** A worker that stopped leaves the pool; when it was the last one, a new one starts with every mesh. */
  const retire = (w: PoolWorker): void => {
    const i = workers.indexOf(w)
    if (i >= 0) workers.splice(i, 1)
    if (workers.length === 0 && !restarting) restarting = restart().finally(() => (restarting = null))
  }
  const restart = async (): Promise<void> => {
    const w = new PoolWorker(make(), module, warmUp, retire)
    await w.ready
    for (const [meshId, src] of sources) {
      const parts = src.parts ? strongParts(src.parts) : null
      // Parts the caller no longer holds belong to no plate any more: that mesh is not loaded again.
      if (src.parts && !parts) {
        sources.delete(meshId)
        meshes.delete(meshId)
        continue
      }
      const data = parts ? (encodeParts(parts).slice().buffer as ArrayBuffer) : await (src.blob ?? new Blob()).arrayBuffer()
      w.meshIds.add(meshId)
      await w.call((call) => ({ type: 'load', call, meshId, fileName: src.fileName, data }), [data])
    }
    if (!w.failed) workers.push(w)
  }
  /** The first worker, after a restart when every worker had stopped. */
  const firstWorker = async (): Promise<PoolWorker> => {
    for (let tries = 0; tries < 3; tries++) {
      const w = workers[0]
      if (w) return w
      restarting ??= restart().finally(() => (restarting = null))
      await restarting.catch(() => undefined)
    }
    throw new Error('The slicer could not start a worker')
  }

  const first = new PoolWorker(make(), module, warmUp, retire)
  await first.ready
  workers.push(first)

  const load = async (data: Uint8Array, fileName: string, parts?: MeshPart[]): Promise<MeshHandle> => {
    const meshId = `mesh-${nextId++}`
    await firstWorker()
    sources.set(meshId, parts ? { fileName, parts: parts.map(weakPart) } : { fileName, blob: new Blob([data as BlobPart]) })
    try {
      return await loadIn(meshId, data, fileName)
    } catch (e) {
      sources.delete(meshId)
      throw e
    }
  }

  const loadIn = async (meshId: string, data: Uint8Array, fileName: string): Promise<MeshHandle> => {
    const send = (w: PoolWorker) => {
      const copy = data.slice().buffer
      w.meshIds.add(meshId)
      return w.call((call) => ({ type: 'load', call, meshId, fileName, data: copy }), [copy])
    }
    const results = await Promise.all(workers.map(send))
    // A worker that joined while this mesh was loading gets it too.
    for (let late = workers.filter((w) => !w.meshIds.has(meshId)); late.length > 0; late = workers.filter((w) => !w.meshIds.has(meshId))) {
      await Promise.all(late.map(send))
    }
    const loaded = results[0]
    if (!loaded || loaded.type !== 'loaded') throw new Error('Mesh load failed')
    const info: MeshInfo = loaded.info
    const handle: MeshHandle = {
      id: meshId,
      hash: info.hash,
      name: fileName,
      triangles: info.triangles,
      bboxMm: info.bboxMm,
      openEdges: 0,
      parts: info.parts.map((p) => (p.color ? { name: p.name, slot: p.slot, triangles: p.triangles, color: p.color } : { name: p.name, slot: p.slot, triangles: p.triangles })),
    }
    meshes.set(meshId, handle)
    return handle
  }

  /** Gives a new worker every mesh in the pool, then adds it to `workers`. */
  const join = async (w: PoolWorker): Promise<void> => {
    await w.ready
    for (let todo = [...meshes.keys()].filter((id) => !w.meshIds.has(id)); todo.length > 0; todo = [...meshes.keys()].filter((id) => !w.meshIds.has(id))) {
      for (const id of todo) {
        const handle = meshes.get(id)
        const w0 = workers[0]
        if (!handle || !w0) continue
        const r = await w0.call((call) => ({ type: 'parts', call, meshId: id }))
        if (r.type !== 'parts') throw new Error('Mesh parts failed')
        const copy = r.data.slice(0)
        w.meshIds.add(id)
        await w.call((call) => ({ type: 'load', call, meshId: id, fileName: handle.name, data: copy }), [copy])
      }
    }
    workers.push(w)
  }

  /** Starts workers until `want` are running or starting; returns the ones started now, each resolving when it has joined. */
  const grow = (want: number): Promise<PoolWorker | null>[] => {
    const out: Promise<PoolWorker | null>[] = []
    while (workers.length + starting < Math.min(count, want)) {
      starting++
      const w = new PoolWorker(make(), module, warmUp, retire)
      out.push(
        join(w)
          .then(() => w as PoolWorker | null)
          .catch(() => {
            w.worker.terminate()
            return null
          })
          .finally(() => {
            starting--
          }),
      )
    }
    return out
  }

  return {
    loadModel(data: ArrayBuffer, fileName: string): Promise<MeshHandle> {
      return load(new Uint8Array(data), fileName)
    },
    loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> {
      return load(encodeParts(parts), name, parts)
    },
    async meshParts(id: string): Promise<MeshPart[]> {
      if (!meshes.has(id)) throw new Error(`Unknown mesh ${id}`)
      const w = await firstWorker()
      const r = await w.call((call) => ({ type: 'parts', call, meshId: id }))
      if (r.type !== 'parts') throw new Error('Mesh parts failed')
      return decodeParts(new Uint8Array(r.data))
    },
    async projectMetadata(data: ArrayBuffer, fileName: string): Promise<ProjectMetadata> {
      const w = await firstWorker()
      const copy = data.slice(0)
      const r = await w.call((call) => ({ type: 'metadata', call, fileName, data: copy }), [copy])
      if (r.type !== 'metadata') throw new Error('Project metadata failed')
      return r.info as ProjectMetadata
    },
    async slice(req: SliceRequest, o?: { onProgress?: (p: SliceProgress) => void; signal?: AbortSignal }): Promise<SliceResult> {
      const started = performance.now()
      // Options the engine reads: the dialect, sleipnir tops, resume, height ranges and per-layer G-code.
      const { flavor, layerTopsMm, resumeFromLayer, resumeZ, heightRanges, machineLimits, trustedGcode, layerGcode } = (req.options ?? {}) as Record<string, unknown>
      const clock = sliceClock()
      const options = { flavor, layerTopsMm, resumeFromLayer, resumeZ, heightRanges, machineLimits, trustedGcode, layerGcode, ...clock, ...pickClock(req.options) }
      // The thumbnail image goes to the joining step, not to every shard: { width, height, rgba } of raw RGBA bytes.
      const thumbnail = (req.options as Record<string, unknown> | undefined)?.thumbnail as
        | { width: number; height: number; rgba: Uint8Array | ArrayBuffer }
        | undefined
      const request = JSON.stringify({ plate: req.plate, config: req.config, options })
      // Fewer ranges than the pool could take when the plate has few layers (`shardCount`).
      const cap = Math.max(1, Math.min(count * shardsPerWorker, 64))
      const asked = req.options?.shards
      const shards =
        asked !== undefined
          ? Math.max(1, Math.min(asked, 64))
          : shardCount(req.plate.objects, req.config as unknown as Record<string, unknown>, (id) => meshes.get(id)?.bboxMm, cap)
      let done = 0
      const stage: SliceStage = 'paths'
      // Shards go to whichever worker is free next, so a worker that drew
      // heavy layers (solid bottoms and tops) does not hold up the rest.
      const results: FromWorker[] = new Array<FromWorker>(shards)
      // Shards a stopped worker had go back in the queue for the others.
      const todo = Array.from({ length: shards }, (_, i) => i)
      let lost: Error | null = null
      const drain = async (w: PoolWorker): Promise<void> => {
        // A canceled slice hands out no more shards; the ones running finish and are dropped.
        for (let s = o?.signal?.aborted ? undefined : todo.shift(); s !== undefined; s = o?.signal?.aborted ? undefined : todo.shift()) {
          let r: FromWorker
          try {
            r = await w.call((call) => ({ type: 'slice', call, request, shard: s, shards }))
          } catch (e) {
            if (!w.failed) throw e
            todo.push(s)
            lost = w.failed
            return
          }
          results[s] = r
          done++
          o?.onProgress?.({ stage, fraction: done / shards })
        }
      }
      // The workers running now take shards at once; new ones take shards as soon as they hold the meshes.
      await firstWorker()
      const joining = o?.signal?.aborted ? [] : grow(shards).map((p) => p.then((w) => (w ? drain(w) : undefined)))
      const jobs = (async () => {
        await Promise.all([...workers.map(drain), ...joining])
        // Shards left by a worker that stopped after the others finished: the workers left take them, or a new one
        // started with every mesh when none is left. A worker that keeps stopping fails the slice.
        for (let round = 0; todo.length > 0 && round < 2 && !o?.signal?.aborted; round++) {
          await firstWorker()
          await Promise.all(workers.map(drain))
        }
        if (todo.length > 0) throw lost ?? new Error('The slice stopped before every layer was sliced')
      })()
      const aborted = new Promise<never>((_, reject) => {
        if (o?.signal?.aborted) reject(new DOMException('Slice canceled', 'AbortError'))
        o?.signal?.addEventListener('abort', () => reject(new DOMException('Slice canceled', 'AbortError')))
      })
      // A slice given up on (canceled) may still fail later; that failure has no one waiting for it.
      jobs.catch(() => undefined)
      await Promise.race([jobs, aborted])
      const parts = results.filter((r): r is Extract<FromWorker, { type: 'sliced' }> => r.type === 'sliced')
      const infos = parts.map((p) => p.info)
      const layerCount = infos[0]?.layerCount ?? 0
      const layerZ = new Float32Array(infos.flatMap((i) => i.layerZ))
      const layerTimeS = new Float32Array(infos.flatMap((i) => i.layerTimeS))
      const slots = Math.max(1, ...infos.map((i) => i.stats.filament_mm.length))
      const sum = (pick: (i: ShardInfo) => number[]) =>
        Array.from({ length: slots }, (_, k) => infos.reduce((acc, i) => acc + (pick(i)[k] ?? 0), 0))
      const stageMicros: SliceResult['stageMicros'] = {}
      for (const i of infos) {
        for (const [k, v] of Object.entries(i.stageMicros)) {
          const key = k as SliceStage
          stageMicros[key] = (stageMicros[key] ?? 0) + v
        }
      }
      const seen = new Set<string>()
      const warnings: SliceWarning[] = []
      for (const w of infos.flatMap((i) => i.warnings)) {
        if (seen.has(w.message)) continue
        seen.add(w.message)
        warnings.push(toWarning(w))
      }
      const id = `slice-${nextId++}`
      // The shards carry marker lines; joined, a worker turns them into progress and totals.
      let gcode = parts.map((p) => p.gcode)
      let format: 'gcode' | 'bgcode' = 'gcode'
      // The whole file's time once finalized (the shards' own sums leave out the joins).
      let finalTime: number | undefined
      let layerLines: number[] = []
      let progressLines: number[] = []
      let finalLayerTimes: number[] = []
      let prepareS = 0
      let fileName: string | undefined
      let collisions: Pick<SliceResult, 'collisions' | 'collisionFixes'> = {}
      // By object: every shard's hits go to finalize, which reports them at the finished file's times.
      const meta = infos.find((i) => i.collide?.meta)?.collide?.meta
      const collide = meta ? JSON.stringify({ meta, hits: infos.flatMap((i) => i.collide?.hits ?? []) }) : undefined
      const w0 = gcode.length > 0 ? await firstWorker().catch(() => undefined) : undefined
      if (w0 && gcode.length > 0) {
        try {
          const joined = new Uint8Array(gcode.reduce((n, g) => n + g.byteLength, 0))
          let at = 0
          for (const g of gcode) {
            joined.set(new Uint8Array(g), at)
            at += g.byteLength
          }
          const buf = joined.buffer as ArrayBuffer
          const rgba = thumbnail ? new Uint8Array(thumbnail.rgba instanceof ArrayBuffer ? thumbnail.rgba : thumbnail.rgba.buffer.slice(thumbnail.rgba.byteOffset, thumbnail.rgba.byteOffset + thumbnail.rgba.byteLength)).slice().buffer : undefined
          const r = await w0.call(
            (call) => ({ type: 'finalize', call, data: buf, request, ...(collide ? { collide } : {}), ...(thumbnail && rgba ? { thumbnail: { width: thumbnail.width, height: thumbnail.height, rgba } } : {}) }),
            rgba ? [buf, rgba] : [buf],
          )
          if (r.type === 'finalized') {
            gcode = [r.data]
            format = r.format
            finalTime = r.timeS
            if (r.layerTimeS?.length === layerCount && layerCount > 0) {
              finalLayerTimes = r.layerTimeS
              prepareS = r.prepareS ?? 0
            }
            layerLines = r.layerLines ?? []
            progressLines = r.progressLines ?? []
            fileName = r.fileName
            if (r.collisions?.length) collisions = { collisions: r.collisions, collisionFixes: r.collisionFixes ?? [] }
          }
        } catch {
          // Left as written: the markers are comments, only the progress lines and footer are missing.
        }
      }
      slices.set(id, { gcode, format, ...(fileName ? { fileName } : {}), preview: null, previewChunks: parts.map((p) => p.sxpv), layerLines, progressLines, layerTimeS: finalLayerTimes })
      return {
        id,
        engine: 'sx',
        layerCount,
        layerZ,
        layerTimeS: finalLayerTimes.length ? new Float32Array(finalLayerTimes) : layerTimeS,
        stats: {
          timeS: finalTime ?? infos.reduce((a, i) => a + i.stats.time_s, 0),
          ...(prepareS > 0 ? { prepareS } : {}),
          filamentMm: sum((i) => i.stats.filament_mm),
          filamentG: sum((i) => i.stats.filament_g),
          cost: infos.reduce((a, i) => a + i.stats.cost, 0),
          toolChanges: infos.reduce((a, i) => a + i.stats.tool_changes, 0),
        },
        stageMicros,
        wallMs: performance.now() - started,
        warnings,
        ...(format === 'bgcode' ? { gcodeFormat: 'bgcode' as const } : {}),
        ...(fileName ? { fileName } : {}),
        ...(infos[0]?.primeTower ? { primeTower: infos[0].primeTower } : {}),
        ...(infos[0]?.varyLayerCost ? { varyLayerCost: infos[0].varyLayerCost } : {}),
        ...(infos[0]?.filamentMap ? { filamentMap: infos[0].filamentMap } : {}),
        ...collisions,
      }
    },
    // The page reads each slice's preview once and keeps it, so the pool hands it over and keeps no copy; a second ask
    // is an error, as on the desktop.
    getPreview(sliceId: string): Promise<ArrayBuffer> {
      const s = slices.get(sliceId)
      if (!s) return Promise.reject(new Error(`Unknown slice ${sliceId}`))
      if (s.previewTaken) return Promise.reject(new Error(`The preview of slice ${sliceId} was already sent`))
      const preview = s.preview ?? stitchPreview(s.previewChunks, s.layerLines, s.progressLines, s.layerTimeS)
      s.preview = null
      s.previewTaken = true
      s.previewChunks = []
      s.layerLines = []
      s.progressLines = []
      s.layerTimeS = []
      return Promise.resolve(preview)
    },
    async exportGcode(sliceId: string, target: GcodeTarget): Promise<GcodeExport> {
      const s = slices.get(sliceId)
      if (!s) throw new Error(`Unknown slice ${sliceId}`)
      const { hex, bytes } = await sha256Hex(s.gcode)
      const out: GcodeExport = { fileName: s.fileName ?? `${sliceId}.${s.format}`, bytes, sha256: hex }
      if (target.kind === 'blob') out.blob = new Blob(s.gcode, { type: s.format === 'bgcode' ? 'application/octet-stream' : 'text/x-gcode' })
      else out.path = target.path
      return out
    },
    gcodeLineStarts(sliceId: string): Promise<Uint32Array> {
      const s = slices.get(sliceId)
      if (!s) return Promise.reject(new Error(`Unknown slice ${sliceId}`))
      return lineStarts(s.gcode)
    },
    gcodeBytes(sliceId: string, start: number, end: number): Promise<Uint8Array> {
      const s = slices.get(sliceId)
      if (!s) return Promise.reject(new Error(`Unknown slice ${sliceId}`))
      return Promise.resolve(byteRange(s.gcode, start, end))
    },
    release(id: string): void {
      sources.delete(id)
      if (meshes.delete(id)) for (const w of workers) w.send({ type: 'release', meshId: id })
      slices.delete(id)
    },
  }
}

/**
 * Where each line of the text in `chunks` starts, then one past the end. Walked 4 MB at a time with a yield between,
 * so a big slice's G-code never holds the page.
 */
export async function lineStarts(chunks: ArrayBuffer[]): Promise<Uint32Array> {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  if (total === 0) return new Uint32Array([0])
  // About 30 bytes a line in slicer output; grown on demand.
  let starts = new Uint32Array(Math.max(16, Math.ceil(total / 24)))
  let n = 0
  const push = (v: number) => {
    if (n >= starts.length) {
      const grown = new Uint32Array(starts.length * 2)
      grown.set(starts)
      starts = grown
    }
    starts[n++] = v
  }
  push(0)
  let base = 0
  let walked = 0
  for (const c of chunks) {
    const b = new Uint8Array(c)
    for (let pos = b.indexOf(10); pos >= 0; pos = b.indexOf(10, pos + 1)) {
      push(base + pos + 1)
      if (pos - walked > 4 << 20) {
        walked = pos
        await new Promise((r) => setTimeout(r, 0))
      }
    }
    base += b.length
    walked = 0
  }
  // A text that ends with a line break has no empty last line: its last start is the end.
  if (starts[n - 1] !== total) push(total)
  return starts.slice(0, n)
}

/** Bytes [start, end) of the text in `chunks`, copied out. */
export function byteRange(chunks: ArrayBuffer[], start: number, end: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, end - start))
  let base = 0
  for (const c of chunks) {
    const a = Math.max(start, base)
    const b = Math.min(end, base + c.byteLength)
    if (b > a) out.set(new Uint8Array(c, a - base, b - a), a - start)
    base += c.byteLength
    if (base >= end) break
  }
  return out
}
