// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Joins SXPV chunks of consecutive layer ranges into the buffer one run over
// the whole range would produce. Mirrors sx_core::preview::stitch_lines.
import { SXPV_EXTRA, SXPV_EXTRA_BYTES, SXPV_FLAG_EXTRAS, SXPV_FLAG_LAYER_LINES, SXPV_FLAG_OBJECTS, SXPV_FLAG_TRAVELS, SXPV_HEADER_BYTES, SXPV_OBJECT_BYTES, SXPV_SEGMENT_BYTES, SXPV_TRAVEL_BYTES, readPreview, type PreviewBuffers } from '@slicerx/contracts'

/**
 * `layerLines` is the 1-based line of each layer marker (`;LAYER_CHANGE`, `; CHANGE_LAYER` on a Bambu Lab printer) in the finished file (the WASM finalize step returns
 * it), one per layer that has G-code. Shards count their extras' G-code lines from their layer's marker; with
 * the layer lines they become lines of the file, without them 0 (unknown). `progressLines` are the finished
 * file's progress lines (`M73 P R` after moves, which finalize adds inside layers); the count skips them.
 * `layerTimeS` are the layers' seconds as the finished file reads them (finalize returns them); the shards' own
 * estimates, which leave out acceleration, give way to them when there is one per layer.
 */
export function stitchPreview(chunks: ArrayBuffer[], layerLines: readonly number[] = [], progressLines: readonly number[] = [], layerTimeS: readonly number[] = []): ArrayBuffer {
  const parts: PreviewBuffers[] = chunks.map(readPreview)
  const first = parts[0]
  if (!first) return new ArrayBuffer(0)
  const hasTravels = parts.every((p) => p.travelStart !== null)
  const hasObjects = parts.every((p) => p.objectsOffset >= 0)
  const hasExtras = hasTravels && parts.every((p) => p.extrasOffset >= 0)
  let segs = 0
  let layers = 0
  let travels = 0
  let tools = 1
  for (const p of parts) {
    segs += p.segmentCount
    layers += p.layerCount
    travels += p.travelCount
    tools = Math.max(tools, p.toolCount)
  }
  const tables = (layers + 1) * 4 + layers * 8 + (hasTravels ? (layers + 1) * 4 : 0)
  const objectBytes = hasObjects ? (segs * SXPV_OBJECT_BYTES + 3) & ~3 : 0
  const extraBytes = hasExtras ? (segs * SXPV_EXTRA_BYTES + travels + 3) & ~3 : 0
  const size = SXPV_HEADER_BYTES + tables + segs * SXPV_SEGMENT_BYTES + (hasTravels ? travels * SXPV_TRAVEL_BYTES : 0) + extraBytes + objectBytes
  const out = new ArrayBuffer(size)
  const v = new DataView(out)
  const bytes = new Uint8Array(out)
  bytes.set(new Uint8Array(first.raw, 0, 8))
  v.setUint16(6, (hasTravels ? SXPV_FLAG_TRAVELS : 0) | (hasObjects ? SXPV_FLAG_OBJECTS : 0) | (hasExtras ? SXPV_FLAG_EXTRAS : 0), true)
  v.setUint32(8, segs, true)
  v.setUint32(12, layers, true)
  v.setUint32(16, hasTravels ? travels : 0, true)
  v.setUint32(20, tools, true)
  bytes.set(new Uint8Array(first.raw, 24, 8), 24)
  let o = SXPV_HEADER_BYTES
  let base = 0
  for (const p of parts) {
    for (let l = 0; l < p.layerCount; l++, o += 4) v.setUint32(o, base + (p.layerStart[l] ?? 0), true)
    base += p.segmentCount
  }
  v.setUint32(o, base, true)
  o += 4
  for (const p of parts) {
    bytes.set(new Uint8Array(p.layerZ.buffer, p.layerZ.byteOffset, p.layerZ.byteLength), o)
    o += p.layerZ.byteLength
  }
  if (layerTimeS.length === layers && layers > 0) {
    for (const t of layerTimeS) {
      v.setFloat32(o, t, true)
      o += 4
    }
  } else {
    for (const p of parts) {
      bytes.set(new Uint8Array(p.layerTimeS.buffer, p.layerTimeS.byteOffset, p.layerTimeS.byteLength), o)
      o += p.layerTimeS.byteLength
    }
  }
  if (hasTravels) {
    base = 0
    for (const p of parts) {
      for (let l = 0; l < p.layerCount; l++, o += 4) v.setUint32(o, base + (p.travelStart?.[l] ?? 0), true)
      base += p.travelCount
    }
    v.setUint32(o, base, true)
    o += 4
  }
  for (const p of parts) {
    const n = p.segmentCount * SXPV_SEGMENT_BYTES
    bytes.set(new Uint8Array(p.raw, p.segmentsOffset, n), o)
    o += n
  }
  if (hasTravels) {
    for (const p of parts) {
      const n = p.travelCount * SXPV_TRAVEL_BYTES
      bytes.set(new Uint8Array(p.raw, p.travelsOffset, n), o)
      o += n
    }
  }
  if (hasExtras) {
    // Layers before the first marker have no G-code (a resume).
    const skip = Math.max(0, layers - layerLines.length)
    let layer0 = 0
    for (const p of parts) {
      const n = p.segmentCount * SXPV_EXTRA_BYTES
      bytes.set(new Uint8Array(p.raw, p.extrasOffset, n), o)
      if ((new DataView(p.raw).getUint16(6, true) & SXPV_FLAG_LAYER_LINES) !== 0) {
        let l = 0
        for (let k = 0; k < p.segmentCount; k++) {
          while (l + 1 < p.layerCount && (p.layerStart[l + 1] ?? 0) <= k) l++
          const at = o + k * SXPV_EXTRA_BYTES + SXPV_EXTRA.gcodeLine
          const rel = v.getUint32(at, true)
          const base = layerLines[layer0 + l - skip]
          v.setUint32(at, base !== undefined && layer0 + l >= skip && rel !== 0xffffffff ? fileLine(base, rel, progressLines) : 0, true)
        }
      }
      o += n
      layer0 += p.layerCount
    }
    for (const p of parts) {
      bytes.set(new Uint8Array(p.raw, p.travelFlagsOffset, p.travelCount), o)
      o += p.travelCount
    }
    o = (o + 3) & ~3
  }
  if (hasObjects) {
    for (const p of parts) {
      const n = p.segmentCount * SXPV_OBJECT_BYTES
      bytes.set(new Uint8Array(p.raw, p.objectsOffset, n), o)
      o += n
    }
  }
  return out
}

/** The line `rel` lines after the marker on line `base`, not counting the progress lines in between. Mirrors
 * sx_core::extras::file_line. `progress` is sorted. */
export function fileLine(base: number, rel: number, progress: readonly number[]): number {
  const after = (x: number): number => {
    let lo = 0
    let hi = progress.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((progress[mid] ?? 0) <= x) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const from = after(base)
  let line = base + rel
  for (;;) {
    const next = base + rel + (after(line) - from)
    if (next === line) return line
    line = next
  }
}
