// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One STEP read in a Node worker thread (node.ts starts it): load OpenCASCADE with the memory cap, read, answer once.
import { readFile } from 'node:fs/promises'
import { parentPort, workerData } from 'node:worker_threads'
import { defaultWasmUrl, loadOcct } from './load.ts'
import { readStep, StepError, type StepQuality } from './read.ts'

interface Job {
  bytes: Uint8Array
  name: string
  quality: StepQuality
  appName?: string
  maxMemoryMb: number
  wasm?: string
}

const job = workerData as Job
const port = parentPort!
try {
  const wasm = job.wasm === undefined ? defaultWasmUrl() : /^file:/i.test(job.wasm) ? new URL(job.wasm) : job.wasm
  const occt = await loadOcct({ wasmBinary: new Uint8Array(await readFile(wasm)), maxMemoryMb: job.maxMemoryMb })
  const result = readStep(occt, job.bytes, job.name, job.quality, job.appName === undefined ? {} : { appName: job.appName })
  const buffers = result.objects.flatMap((o) => o.bodies.flatMap((b) => [b.positions.buffer, b.indices.buffer])) as ArrayBuffer[]
  port.postMessage({ result }, buffers)
} catch (e) {
  port.postMessage({ error: e instanceof StepError ? { code: e.code, message: e.message } : { code: 'unreadable', message: `could not be read: ${e instanceof Error ? e.message : String(e)}` } })
}
