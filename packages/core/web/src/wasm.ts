// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Typed access to the sx-wasm C ABI (packages/core/wasm/src/lib.rs).
import type { Collision, CollisionFix } from '@slicerx/contracts'

interface SxExports {
  memory: WebAssembly.Memory
  sx_input(len: number): number
  sx_error_ptr(): number
  sx_error_len(): number
  sx_out_ptr(which: number): number
  sx_out_len(which: number): number
  sx_load_mesh(): number
  sx_release_mesh(id: number): void
  sx_mesh_parts(id: number): number
  sx_project_metadata(): number
  sx_slice_shard(shard: number, shards: number): number
  sx_finalize?(): number
  sx_set_thumbnail?(width: number, height: number): number
  sx_set_request?(): number
  sx_set_collisions?(): number
}

export const OUT_GCODE = 0
export const OUT_SXPV = 1
export const OUT_INFO = 2
export const OUT_PARTS = 3

function isExports(x: unknown): x is SxExports {
  if (typeof x !== 'object' || x === null) return false
  const e = x as Record<string, unknown>
  return e.memory instanceof WebAssembly.Memory && typeof e.sx_slice_shard === 'function' && typeof e.sx_load_mesh === 'function'
}

export class SxWasm {
  private readonly x: SxExports

  private constructor(x: SxExports) {
    this.x = x
  }

  static async create(module: WebAssembly.Module): Promise<SxWasm> {
    const instance = await WebAssembly.instantiate(module, {})
    if (!isExports(instance.exports)) throw new Error('sx-wasm exports are missing')
    return new SxWasm(instance.exports)
  }

  private put(bytes: Uint8Array): void {
    const p = this.x.sx_input(bytes.length)
    new Uint8Array(this.x.memory.buffer, p, bytes.length).set(bytes)
  }

  private error(): Error {
    const bytes = new Uint8Array(this.x.memory.buffer, this.x.sx_error_ptr(), this.x.sx_error_len())
    return new Error(new TextDecoder().decode(bytes))
  }

  /** Copies an output out of linear memory. */
  out(which: number): Uint8Array {
    return new Uint8Array(this.x.memory.buffer, this.x.sx_out_ptr(which), this.x.sx_out_len(which)).slice()
  }

  outJson(): unknown {
    return JSON.parse(new TextDecoder().decode(this.out(OUT_INFO)))
  }

  /** Loads a model; returns the module's mesh id. */
  loadMesh(fileName: string, data: Uint8Array): number {
    const name = new TextEncoder().encode(fileName)
    const buf = new Uint8Array(name.length + 1 + data.length)
    buf.set(name)
    buf.set(data, name.length + 1)
    this.put(buf)
    const id = this.x.sx_load_mesh()
    if (id === 0) throw this.error()
    return id
  }

  /** A loaded mesh's parts in the raw format (`decodeParts` reads it). */
  meshParts(id: number): Uint8Array {
    if (this.x.sx_mesh_parts(id) !== 0) throw this.error()
    return this.out(OUT_PARTS)
  }

  /** The settings entries of a 3MF project (JSON text), without loading geometry. */
  projectMetadata(fileName: string, data: Uint8Array): unknown {
    const name = new TextEncoder().encode(fileName)
    const buf = new Uint8Array(name.length + 1 + data.length)
    buf.set(name)
    buf.set(data, name.length + 1)
    this.put(buf)
    if (this.x.sx_project_metadata() !== 0) throw this.error()
    return this.outJson()
  }

  /**
   * Writes progress and the statistics footer into a whole G-code file (the shards joined in order),
   * the thumbnails when given, and binary G-code when the request's settings ask for it. `fileName` is the
   * name the request's `filename_format` gives the file.
   */
  finalizeGcode(
    data: Uint8Array,
    thumbnail?: { width: number; height: number; rgba: Uint8Array },
    request?: Uint8Array,
    collide?: Uint8Array,
  ): { data: Uint8Array; format: 'gcode' | 'bgcode'; timeS?: number; prepareS?: number; layerTimeS?: number[]; fileName?: string; layerLines?: number[]; progressLines?: number[]; collisions?: Collision[]; collisionFixes?: CollisionFix[] } {
    if (!this.x.sx_finalize) return { data, format: 'gcode' }
    if (thumbnail && this.x.sx_set_thumbnail) {
      this.put(thumbnail.rgba)
      if (this.x.sx_set_thumbnail(thumbnail.width, thumbnail.height) !== 0) throw this.error()
    }
    if (request && this.x.sx_set_request) {
      this.put(request)
      if (this.x.sx_set_request() !== 0) throw this.error()
    }
    if (collide && this.x.sx_set_collisions) {
      this.put(collide)
      if (this.x.sx_set_collisions() !== 0) throw this.error()
    }
    this.put(data)
    if (this.x.sx_finalize() !== 0) throw this.error()
    const info = this.outJson() as { format?: string; timeS?: number | null; prepareS?: number | null; layerTimeS?: number[]; fileName?: string | null; layerLines?: number[]; progressLines?: number[]; collisions?: Collision[]; collisionFixes?: CollisionFix[] }
    return {
      data: this.out(OUT_GCODE),
      format: info.format === 'bgcode' ? 'bgcode' : 'gcode',
      ...(typeof info.timeS === 'number' ? { timeS: info.timeS } : {}),
      ...(typeof info.prepareS === 'number' ? { prepareS: info.prepareS } : {}),
      ...(Array.isArray(info.layerTimeS) ? { layerTimeS: info.layerTimeS } : {}),
      ...(typeof info.fileName === 'string' ? { fileName: info.fileName } : {}),
      ...(Array.isArray(info.layerLines) ? { layerLines: info.layerLines } : {}),
      ...(Array.isArray(info.progressLines) ? { progressLines: info.progressLines } : {}),
      ...(Array.isArray(info.collisions) && info.collisions.length ? { collisions: info.collisions, collisionFixes: info.collisionFixes ?? [] } : {}),
    }
  }

  releaseMesh(id: number): void {
    this.x.sx_release_mesh(id)
  }

  /** Slices one shard of a request (JSON with numeric mesh ids). Outputs stay readable until the next call. */
  sliceShard(requestJson: Uint8Array, shard: number, shards: number): void {
    this.put(requestJson)
    if (this.x.sx_slice_shard(shard, shards) !== 0) throw this.error()
  }
}
