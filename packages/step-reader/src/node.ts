// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reading STEP files in Node, for servers and command line tools: each file is read in a worker thread of its own with
// a deadline, an input size cap and a cap on the memory OpenCASCADE may grow to. A file that hangs the parser or asks
// for gigabytes ends that worker, never the calling process. The answer comes back as a StepRead, typed StepError on
// failure.
import { readFile, stat } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { STEP_MAX_MB, StepError, type StepErrorCode, type StepQuality, type StepRead } from './read.ts'

export { stepInfo, toObj, toStl, type ObjOptions, type StepBounds, type StepInfo } from './convert.ts'
export { STEP_ERROR_CODES, STEP_MAX_MB, StepError, type StepErrorCode, type StepQuality, type StepRead, type StepUnit } from './read.ts'

/** Default cap on the memory OpenCASCADE may use for one file, in MB. */
export const STEP_MAX_MEMORY_MB = 2048

/** A minute, plus 2 s per megabyte: the deadline the app gives a read (a file at the 100 MB limit gets 4 min 20 s). */
export function stepDeadlineMs(bytes: number): number {
  return 60_000 + Math.ceil(bytes / (1024 * 1024)) * 2_000
}

export interface NodeReadOptions {
  /** The file's name, which names the objects. Default model.step. */
  name?: string
  quality?: StepQuality
  appName?: string
  /** Stop the read after this long. Default stepDeadlineMs of the file's size. */
  timeoutMs?: number
  /** Refuse files over this size, in MB. Default and most 100 (STEP_MAX_MB). */
  maxInputMb?: number
  /** The most memory OpenCASCADE may grow to, in MB. Default 2048. */
  maxMemoryMb?: number
  /** Another occt-import-js.wasm to load (a path or a file URL). Default: the one in this package. */
  wasm?: string | URL
}

interface WorkerAnswer {
  result?: StepRead
  error?: { code: StepErrorCode; message: string }
}

function workerUrl(): URL {
  // The source tree runs the TypeScript worker (Node strips its types); the published package runs the built one.
  return new URL(import.meta.url.endsWith('.ts') ? './node-worker.ts' : './node-worker.js', import.meta.url)
}

const tooLarge = (bytes: number, capMb: number) => new StepError('too_large', `is ${Math.round(bytes / 1024 / 1024)} MB. STEP files up to ${capMb} MB can be opened.`)

/** Reads STEP bytes in a worker thread. Throws StepError. */
export function readStepInWorker(bytes: Uint8Array, opts: NodeReadOptions = {}): Promise<StepRead> {
  const capMb = Math.min(opts.maxInputMb ?? STEP_MAX_MB, STEP_MAX_MB)
  if (bytes.length > capMb * 1024 * 1024) return Promise.reject(tooLarge(bytes.length, capMb))
  const timeoutMs = opts.timeoutMs ?? stepDeadlineMs(bytes.length)
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl(), {
      workerData: {
        bytes,
        name: opts.name ?? 'model.step',
        quality: opts.quality ?? 'normal',
        appName: opts.appName,
        maxMemoryMb: opts.maxMemoryMb ?? STEP_MAX_MEMORY_MB,
        wasm: opts.wasm === undefined ? undefined : String(opts.wasm),
      },
      // The meshes are typed arrays outside the JS heap; the heap itself stays small.
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      // Plain Node: the caller's flags (--input-type, loaders, inspector) are not for this worker.
      execArgv: [],
    })
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      void worker.terminate()
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new StepError('timeout', `took longer than ${Math.round(timeoutMs / 1000)} seconds to read, so reading it was stopped. It may be too detailed or damaged.`))),
      timeoutMs,
    )
    worker.on('message', (m: WorkerAnswer) =>
      finish(() => (m.result ? resolve(m.result) : reject(new StepError(m.error?.code ?? 'unreadable', m.error?.message ?? 'could not be read.')))),
    )
    worker.on('error', (e: Error & { code?: string }) =>
      finish(() =>
        reject(
          e.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? new StepError('out_of_memory', 'could not be read: it needs more memory than the reader may use.')
            : new StepError('unreadable', `could not be read: ${e.message}`),
        ),
      ),
    )
    worker.on('exit', (code) => finish(() => reject(new StepError('unreadable', `could not be read: the reader stopped (exit code ${code}).`))))
  })
}

/** Reads a STEP file from disk in a worker thread, refusing it by size before reading it. Throws StepError. */
export async function readStepFileInWorker(path: string, opts: NodeReadOptions = {}): Promise<StepRead> {
  const capMb = Math.min(opts.maxInputMb ?? STEP_MAX_MB, STEP_MAX_MB)
  const size = (await stat(path)).size
  if (size > capMb * 1024 * 1024) throw tooLarge(size, capMb)
  return readStepInWorker(new Uint8Array(await readFile(path)), opts)
}
