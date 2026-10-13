// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Types for the Emscripten module built by ../scripts/build-wasm.sh. Only what SlicerX calls.

export interface SxBrepModuleOptions {
  /** Where to fetch sx_brep.wasm from. */
  locateFile?: (file: string, prefix: string) => string
  /** The wasm bytes, when they are already loaded (tests in Node). */
  wasmBinary?: ArrayBuffer | Uint8Array
}

export interface SxBrepModule {
  _sx_brep_call(op: number, request: number): number
  _sx_brep_free(reply: number): void
  _free(ptr: number): void
  stringToNewUTF8(text: string): number
  UTF8ToString(ptr: number): string
}

declare function sxBrep(options?: SxBrepModuleOptions): Promise<SxBrepModule>
export default sxBrep
