// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The full engine with exact solids (packages/geom/wasm/pkg/sx_geom_exact.wasm, built by
// packages/geom/wasm/scripts/build-exact.sh) for tests, through the worker's own caller (engine-call.ts). Like the
// other engine builds it is generated: a test that needs it skips without it, and on CI a missing one fails
// (wasmBuilt in geom-engine.ts).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { callEngine, type GeomExports } from '../src/geom/engine-call'
import { exactExports, type SxGeomExactModule, type SxGeomExactOptions } from '../src/geom/exact-engine'
import { wasmBuilt } from './geom-engine'

const pkg = join(__dirname, '..', '..', 'geom', 'wasm', 'pkg')
export const exactGlue = join(pkg, 'sx_geom_exact.mjs')
export const exactWasm = join(pkg, 'sx_geom_exact.wasm')
export const exactBuilt = wasmBuilt(exactWasm)

/** The kernel's ops in the module, named without their brep. prefix as the separate kernel's were. */
export interface ExactKernel {
  call(op: string, request: unknown): unknown
  memoryBytes(): number
  exports: GeomExports
  module: SxGeomExactModule
}

/** A fresh module: its own memory and its own bodies. */
export async function exactModule(): Promise<SxGeomExactModule> {
  const { default: init } = (await import(exactGlue)) as { default: (o: SxGeomExactOptions) => Promise<SxGeomExactModule> }
  return init({ wasmBinary: readFileSync(exactWasm) })
}

export function exactKernelOf(m: SxGeomExactModule): ExactKernel {
  const x = exactExports(m)
  return {
    call: (op, request) => callEngine(x, `brep.${op}`, request),
    memoryBytes: () => x.memory.buffer.byteLength,
    exports: x,
    module: m,
  }
}

export async function exactKernel(): Promise<ExactKernel> {
  return exactKernelOf(await exactModule())
}
