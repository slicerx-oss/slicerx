// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import { parentPort } from 'node:worker_threads'
import init from '../../../brep/lib/sx_brep.mjs'

const kernel = await init({ wasmBinary: readFileSync(new URL('../../../brep/lib/sx_brep.wasm', import.meta.url)) })
function call(op, request) {
  const o = kernel.stringToNewUTF8(op)
  const r = kernel.stringToNewUTF8(JSON.stringify(request))
  let p = 0
  try {
    p = kernel._sx_brep_call(o, r)
    const result = JSON.parse(kernel.UTF8ToString(p))
    if (result.error) throw new Error(result.error)
    return result
  } finally {
    if (p) kernel._sx_brep_free(p)
    kernel._free(r)
    kernel._free(o)
  }
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
