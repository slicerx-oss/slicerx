// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The salt a history step gives the engine for the keys of the faces it makes (sx-geom faces.rs): from the step's
// id, so the step makes the same keys when the tool first runs it and in every replay. 52 bits, exact in JSON.

export function stepSalt(id: string): number {
  // FNV-1a, 64 bits as two halves, cut to 52.
  let hi = 0xcbf29ce4
  let lo = 0x84222325
  for (let i = 0; i < id.length; i++) {
    lo ^= id.charCodeAt(i)
    // Multiply by the FNV prime 0x100000001b3 in 32 bit halves.
    const l = lo * 0x1b3
    const h = hi * 0x1b3 + lo * 0x100 + Math.floor(l / 0x100000000)
    lo = l >>> 0
    hi = h >>> 0
  }
  return (hi & 0xfffff) * 0x100000000 + lo || 1
}
