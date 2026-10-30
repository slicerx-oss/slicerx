// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Loads OpenCASCADE (occt-import-js.mjs and occt-import-js.wasm, which sit next to this file) in a browser, a worker or
// Node. The wasm is a separate file found with new URL(..., import.meta.url), the pattern Vite and other bundlers copy
// as an asset, so it can be rebuilt with ../build.sh and replaced on its own. No Node imports here: browsers load this.
// In Node, a capped load reads a file: URL through process.getBuiltinModule instead (wasmBytes).
import { OUT_OF_MEMORY, readStep, type Occt, type ReadOptions, type StepQuality, type StepRead } from './read.ts'

/** Default cap on the memory OpenCASCADE may use for one file, in MB: what the Node path and the app's browser worker both pass. */
export const STEP_MAX_MEMORY_MB = 2048

/** Where the wasm sits next to this module, in the source tree and in the published package alike. */
export function defaultWasmUrl(): URL {
  return new URL('./occt-import-js.wasm', import.meta.url)
}

export interface LoadOptions {
  /** Where to fetch occt-import-js.wasm from (an http(s), file or blob URL). Default: the file next to this module. */
  wasm?: URL | string
  /** The wasm bytes, when the caller has them already (a Node worker reads the file itself). */
  wasmBinary?: ArrayBuffer | Uint8Array
  /**
   * The most memory OpenCASCADE may grow to, in MB. A file that needs more fails with StepError out_of_memory instead
   * of taking the process to its 4 GB wasm limit. The module is spent after that; load a new one.
   */
  maxMemoryMb?: number
}

interface ModuleArgs {
  locateFile?: (file: string, prefix: string) => string
  instantiateWasm?: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => object
  print?: (s: string) => void
  printErr?: (s: string) => void
}

/** Lets `memory` grow to `maxBytes` and no further; `onRefuse` hears each refused growth. */
function capMemory(memory: WebAssembly.Memory, maxBytes: number, onRefuse: () => void): void {
  const grow = memory.grow.bind(memory)
  Object.defineProperty(memory, 'grow', {
    configurable: true,
    value: (pages: number) => {
      if (memory.buffer.byteLength + pages * 65536 > maxBytes) {
        onRefuse()
        throw new RangeError(OUT_OF_MEMORY)
      }
      return grow(pages)
    },
  })
}

/** Node's file reading, when this runs in Node; found at run time, so nothing here imports a Node module. */
function nodeFiles(): { readFile(path: URL): Promise<Uint8Array> } | undefined {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
  return proc?.getBuiltinModule?.('node:fs/promises') as { readFile(path: URL): Promise<Uint8Array> } | undefined
}

async function wasmBytes(url: string): Promise<ArrayBuffer | Uint8Array> {
  // Node's fetch does not read file: URLs, so in Node a file URL is read from disk, as the glue does on its own when
  // there is no cap. Browsers and workers fetch every URL.
  const files = url.startsWith('file:') ? nodeFiles() : undefined
  if (files) return files.readFile(new URL(url))
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`could not fetch ${url}: ${res.status}`)
  return res.arrayBuffer()
}

/** The OpenCASCADE module itself, for callers that drive readStep on their own. */
export async function loadOcct(opts: LoadOptions = {}): Promise<Occt & { outOfMemory?: boolean }> {
  const url = String(opts.wasm ?? defaultWasmUrl().href)
  const { default: init } = await import('./occt-import-js.mjs')
  const state = { outOfMemory: false }
  const args: ModuleArgs = { locateFile: () => url }
  const cap = opts.maxMemoryMb
  // The module's ready promise never settles after a failed instantiation of our own, so that failure races it.
  let failed: (e: unknown) => void = () => undefined
  const failure = new Promise<never>((_, reject) => (failed = reject))
  if (cap !== undefined || opts.wasmBinary) {
    args.instantiateWasm = (imports, done) => {
      void (async () => {
        const bytes = opts.wasmBinary ?? (await wasmBytes(url))
        const { instance, module } = await WebAssembly.instantiate(bytes as BufferSource, imports)
        // The build minifies export names, so the memory is found by its type.
        const memory = Object.values(instance.exports).find((v): v is WebAssembly.Memory => v instanceof WebAssembly.Memory)
        if (cap !== undefined) {
          if (!memory) throw new Error('the STEP reader exports no memory to cap')
          capMemory(memory, cap * 1024 * 1024, () => (state.outOfMemory = true))
        }
        done(instance, module)
      })().catch(failed)
      return {}
    }
  }
  if (cap !== undefined) {
    // An aborted read prints its reason; the caller gets a StepError instead.
    args.print = () => undefined
    args.printErr = () => undefined
  }
  const occt = (await Promise.race([init(args), failure])) as Occt & { outOfMemory?: boolean }
  Object.defineProperty(occt, 'outOfMemory', { get: () => state.outOfMemory })
  return occt
}

export interface StepReader {
  /** Reads a STEP file. Throws StepError. After any error the module may be in any state: close it and load again. */
  read(bytes: Uint8Array, opts?: { name?: string; quality?: StepQuality } & ReadOptions): StepRead
  /** Drops this reader's module, so its memory can go. */
  close(): void
}

/** Loads OpenCASCADE and returns a reader for STEP files (browser, worker or Node). */
export async function loadStepReader(opts: LoadOptions = {}): Promise<StepReader> {
  let occt: Occt | null = await loadOcct(opts)
  return {
    read(bytes, o = {}) {
      if (!occt) throw new Error('This STEP reader was closed. Load a new one.')
      return readStep(occt, bytes, o.name ?? 'model.step', o.quality ?? 'normal', o.appName === undefined ? {} : { appName: o.appName })
    },
    close() {
      occt = null
    },
  }
}
