// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The B-rep kernel (packages/brep): exact solids on SMLib, about 1 MB of wasm that the geometry worker loads the
// first time a call needs it, and never with the app shell. One JSON call, the same as sx-brep's native build; the
// ops are listed in packages/brep/src/lib.rs.
import type { SxBrepModule } from '../../../brep/lib/sx_brep.mjs'

export interface BrepModule {
  call(op: string, request: unknown): unknown
}

/** One call: request in as JSON, the reply back parsed; a reply with an error throws it. */
export function brepModule(m: SxBrepModule): BrepModule {
  return {
    call(op, request) {
      const o = m.stringToNewUTF8(op)
      const r = m.stringToNewUTF8(JSON.stringify(request ?? {}))
      try {
        const p = m._sx_brep_call(o, r)
        if (!p) throw new Error('brep: out of memory')
        const text = m.UTF8ToString(p)
        m._sx_brep_free(p)
        const reply = JSON.parse(text) as { error?: string }
        if (typeof reply.error === 'string') throw new Error(reply.error)
        return reply
      } finally {
        m._free(o)
        m._free(r)
      }
    },
  }
}

export async function loadBrep(): Promise<BrepModule> {
  const wasm = new URL('../../../brep/lib/sx_brep.wasm', import.meta.url).href
  const { default: init } = await import('../../../brep/lib/sx_brep.mjs')
  return brepModule(await init({ locateFile: () => wasm }))
}
