// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Typed-enough access to sx-geom-wasm (wasm/src/lib.rs). Run it in a Web Worker: calls are
// synchronous and a large mesh operation takes a while.
//   const geom = await createGeom(await WebAssembly.compileStreaming(fetch('sx_geom_wasm.wasm')))
//   const out = geom.call('build', { solids: [{ type: 'box', min: [0, 0, 0], max: [10, 10, 5] }] })
// Meshes go in and come out as { positions: number[], indices: number[] } (flat), unless a request
// says meshOutput: 'stlBase64'. Failures throw an Error carrying the message from sx-geom.
export async function createGeom(module) {
  const instance = await WebAssembly.instantiate(module, {})
  const x = instance.exports
  for (const name of ['memory', 'geom_input', 'geom_call', 'geom_ops', 'geom_out_ptr', 'geom_out_len', 'geom_error_ptr', 'geom_error_len']) {
    if (!(name in x)) throw new Error(`sx-geom-wasm export ${name} is missing`)
  }
  const text = (ptr, len) => new TextDecoder().decode(new Uint8Array(x.memory.buffer, ptr, len))
  const result = (code) => {
    if (code === 0) return JSON.parse(text(x.geom_out_ptr(), x.geom_out_len()))
    let message = text(x.geom_error_ptr(), x.geom_error_len())
    try {
      message = JSON.parse(message).error ?? message
    } catch {
      // A plain message stays as it is.
    }
    throw new Error(message)
  }
  return {
    /** Operation names the module accepts. */
    operations: () => result(x.geom_ops()),
    /** Runs one operation on a request object and returns the response object. */
    call(op, request) {
      const bytes = new TextEncoder().encode(`${op}\0${JSON.stringify(request)}`)
      const at = x.geom_input(bytes.length)
      new Uint8Array(x.memory.buffer, at, bytes.length).set(bytes)
      return result(x.geom_call())
    },
  }
}
