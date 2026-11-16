// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import { parentPort } from 'node:worker_threads'
import init from '../../../geom/wasm/pkg/sx_geom_exact.mjs'

// the engine with exact solids (packages/geom/wasm/scripts/build-exact.sh), called as the worker calls it
const engine = await init({ wasmBinary: readFileSync(new URL('../../../geom/wasm/pkg/sx_geom_exact.wasm', import.meta.url)) })
const text = (ptr, len) => new TextDecoder().decode(engine.HEAPU8.subarray(ptr, ptr + len))
function call(op, request) {
  const bytes = new TextEncoder().encode(`brep.${op}\0${JSON.stringify(request)}`)
  // the input buffer first: making it may grow the memory, which replaces HEAPU8
  const at = engine._geom_input(bytes.length)
  engine.HEAPU8.set(bytes, at)
  if (engine._geom_call() === 0) return JSON.parse(text(engine._geom_out_ptr(), engine._geom_out_len()))
  const message = text(engine._geom_error_ptr(), engine._geom_error_len())
  let error = message
  try {
    error = JSON.parse(message).error ?? message
  } catch {
    // a plain message stays as it is
  }
  throw new Error(error)
}

parentPort.on('message', ({ id, op, request }) => {
  try {
    if (op === 'history.replay') {
      const { body } = call('box', { min: [0, 0, 0], max: [20, 20, 20] })
      parentPort.postMessage({ started: true, body })
      // keep entering the real kernel without yielding to cancellation messages.
      for (;;) call('info', { body })
    }
    parentPort.postMessage({ id, result: call(op.slice('brep.'.length), request) })
  } catch (error) {
    parentPort.postMessage({ id, error: String(error) })
  }
})
