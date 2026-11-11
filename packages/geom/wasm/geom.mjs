// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Typed-enough access to sx-geom-wasm (wasm/src/lib.rs). Run it in a Web Worker: calls are
// synchronous and a large mesh operation takes a while.
//   const geom = await createGeom(await WebAssembly.compileStreaming(fetch('sx_geom_wasm.wasm')))
//   const out = geom.call('build', { solids: [{ type: 'box', min: [0, 0, 0], max: [10, 10, 5] }] })
// Meshes go in and come out as { positions: number[], indices: number[] } (flat), unless a request
// says meshOutput: 'stlBase64'. Failures throw an Error carrying the message from sx-geom.
//
// A call that stops the engine (a trap: a panic, or memory the host would not grow) throws an Error
// with trapped: true and says why: "the engine stopped on an internal error: <the panic and where>",
// or, with outOfMemory: true, "the engine ran out of memory at <n> MB; try the step again". A trapped
// module traps on every later call, so the next call runs on a fresh one. A call that ran out of
// memory is tried once more on a fresh one first, and the retry goes to `log` (by default
// console.warn); a panic would only repeat, so it is not. A nest session's later steps (nest.step,
// nest.end) are not tried again either: the session was in the module that stopped.
export async function createGeom(module, { log = (line) => console.warn(line) } = {}) {
  const exportsOf = (instance) => {
    const x = instance.exports
    for (const name of ['memory', 'geom_input', 'geom_call', 'geom_ops', 'geom_out_ptr', 'geom_out_len', 'geom_error_ptr', 'geom_error_len']) {
      if (!(name in x)) throw new Error(`sx-geom-wasm export ${name} is missing`)
    }
    return x
  }
  let x = exportsOf(await WebAssembly.instantiate(module, {}))
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
  /** Runs `f` on the module; a trap leaves the module for a fresh one and throws why. */
  const guarded = (f) => {
    x ??= exportsOf(new WebAssembly.Instance(module, {}))
    try {
      return f()
    } catch (e) {
      if (!(e instanceof WebAssembly.RuntimeError)) throw e
      const panic = x.geom_panic_len ? text(x.geom_panic_ptr(), x.geom_panic_len()) : ''
      const mb = (x.memory.buffer.byteLength / 2 ** 20).toFixed(1)
      x = null
      const message = panic
        ? `the engine stopped on an internal error: ${panic.replace(/\s+/g, ' ').trim()}`
        : `the engine ran out of memory at ${mb} MB; try the step again`
      throw Object.assign(new Error(message), { trapped: true, outOfMemory: !panic })
    }
  }
  const once = (op, request) =>
    guarded(() => {
      const bytes = new TextEncoder().encode(`${op}\0${JSON.stringify(request)}`)
      const at = x.geom_input(bytes.length)
      new Uint8Array(x.memory.buffer, at, bytes.length).set(bytes)
      return x.geom_call()
    })
  return {
    /** Operation names the module accepts. */
    operations: () => result(guarded(() => x.geom_ops())),
    /** Runs one operation on a request object and returns the response object. */
    call(op, request) {
      let code
      try {
        code = once(op, request)
      } catch (e) {
        if (!e.outOfMemory || op === 'nest.step' || op === 'nest.end') throw e
        log(`sx-geom ${op}: ${e.message}; trying it once more on a fresh engine`)
        code = once(op, request)
      }
      return result(code)
    },
  }
}
