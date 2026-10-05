// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads STEP files off the main thread. OpenCASCADE (about 7 MB of wasm) loads here on the first STEP
// file and never in the app shell. Answers with the OBJ text for the engine's import, base64 encoded.
import { readStep, stepToObj, StepError, type Occt, type StepQuality } from './step-read'

let occt: Promise<Occt> | null = null

function load(): Promise<Occt> {
  return (occt ??= (async () => {
    const wasm = new URL('../../../vendor/occt-import-js/lib/occt-import-js.wasm', import.meta.url).href
    const { default: init } = await import('../../../vendor/occt-import-js/lib/occt-import-js.mjs')
    return (await init({ locateFile: () => wasm })) as Occt
  })())
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(out)
}

self.onmessage = async (e: MessageEvent<{ id: number; name: string; data: ArrayBuffer; quality: StepQuality }>) => {
  const { id, name, data, quality } = e.data
  try {
    const x = await load()
    const read = readStep(x, new Uint8Array(data), name, quality)
    self.postMessage({ id, result: { base64: base64(stepToObj(read)), notes: read.notes, triangles: read.triangles, toleranceMm: read.toleranceMm, unit: read.unit } })
  } catch (err) {
    const plain = err instanceof StepError
    // The caller ends this worker after a failure, since OpenCASCADE's memory may be in any state.
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err), plain })
  }
}
