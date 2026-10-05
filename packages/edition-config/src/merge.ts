// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

type Plain = Record<string, unknown>
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Deep merge for config layers: objects merge, arrays and scalars replace, `undefined` leaves the lower layer. */
export function mergeLayers<T>(...layers: unknown[]): T {
  let out: unknown = undefined
  for (const layer of layers) out = mergeTwo(out, layer)
  return out as T
}

function mergeTwo(a: unknown, b: unknown): unknown {
  if (b === undefined) return a
  if (isPlain(a) && isPlain(b)) {
    const out: Plain = { ...a }
    for (const [k, v] of Object.entries(b)) out[k] = mergeTwo(a[k], v)
    return out
  }
  return b
}
