// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The full engine with exact solids (packages/geom/wasm/scripts/build-exact.sh): sx-geom and the SMLib kernel in one
// Emscripten module, with the same exports as the other builds (lib.rs). Emscripten's glue instantiates it, and its
// memory is read through HEAPU8, which the glue replaces whenever the memory grows.
import type { GeomExports } from './engine-call'

/** The Emscripten module, as far as the worker reaches it. */
export interface SxGeomExactModule {
  HEAPU8: Uint8Array
  _geom_input(len: number): number
  _geom_file(len: number): number
  _geom_call(): number
  _geom_ops(): number
  _geom_out_ptr(): number
  _geom_out_len(): number
  _geom_out_files(): number
  _geom_out_file_ptr(n: number): number
  _geom_out_file_len(n: number): number
  _geom_error_ptr(): number
  _geom_error_len(): number
  _geom_panic_ptr(): number
  _geom_panic_len(): number
}

export interface SxGeomExactOptions {
  locateFile?: (file: string, prefix: string) => string
  wasmBinary?: ArrayBuffer | Uint8Array
}

/** The module's calls as the exports of the other builds, so one caller (engine-call.ts) serves all three. */
export function exactExports(m: SxGeomExactModule): GeomExports {
  // one memory object for the module's life: the worker counts each module's memory once
  const memory = {
    get buffer() {
      return m.HEAPU8.buffer
    },
  } as WebAssembly.Memory
  return {
    memory,
    geom_input: (n) => m._geom_input(n),
    geom_file: (n) => m._geom_file(n),
    geom_call: () => m._geom_call(),
    geom_ops: () => m._geom_ops(),
    geom_out_ptr: () => m._geom_out_ptr(),
    geom_out_len: () => m._geom_out_len(),
    geom_out_files: () => m._geom_out_files(),
    geom_out_file_ptr: (n) => m._geom_out_file_ptr(n),
    geom_out_file_len: (n) => m._geom_out_file_len(n),
    geom_error_ptr: () => m._geom_error_ptr(),
    geom_error_len: () => m._geom_error_len(),
    geom_panic_ptr: () => m._geom_panic_ptr(),
    geom_panic_len: () => m._geom_panic_len(),
  }
}

/** Loads the module from the build's two files: the glue (an ES module) and its wasm. */
export async function loadExactExports(glue: URL, wasm: URL): Promise<GeomExports> {
  const { default: init } = (await import(/* @vite-ignore */ glue.href)) as { default: (o: SxGeomExactOptions) => Promise<SxGeomExactModule> }
  return exactExports(await init({ locateFile: () => wasm.href }))
}
