// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The G-code side of the calibrations that are not models: layer indexes for per-band firmware commands, and the
// splice that swaps a placeholder's body for a tool path test's own G-code (pressure advance lines and pattern).
import type { Host, SlicerHost } from '@slicerx/contracts'
import { get } from '../state/store'

/** The 0-based layer that starts at a height: layer 0 is the first layer, layer k above it starts at first + (k - 1) * h. */
export function layerIndexAt(zMm: number, layerHeightMm: number, firstLayerMm: number): number {
  if (zMm <= 1e-6) return 0
  return Math.max(0, Math.round((zMm - firstLayerMm) / layerHeightMm) + 1)
}

/**
 * The sliced placeholder with its body (everything from the first layer change to the end sequence) replaced by
 * the test's own G-code. Returns null when the file does not have the engine's markers.
 */
export function spliceBody(gcode: string, body: string): string | null {
  // a bambu lab file marks its layers as orca's processor does for those printers
  const start = gcode.includes('\n; CHANGE_LAYER\n') ? gcode.indexOf('; CHANGE_LAYER\n') : gcode.indexOf(';LAYER_CHANGE\n')
  const end = gcode.lastIndexOf('\n; end\n')
  if (start < 0 || end < 0 || end < start) return null
  return `${gcode.slice(0, start)}; calibration test: G-code from the test, not from slicing\n${body.endsWith('\n') ? body : `${body}\n`}${gcode.slice(end + 1)}`
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** `host.slicer.exportGcode`, with a tool path test's body spliced in when the active plate is one. */
export async function exportPlateGcode(host: Pick<Host, 'slicer'> | { slicer: Pick<SlicerHost, 'exportGcode'> }, resultId: string): ReturnType<SlicerHost['exportGcode']> {
  const out = await host.slicer.exportGcode(resultId, { kind: 'blob' })
  const s = get()
  const body = s.calibration[s.activePlate]?.body
  if (!body || !out.blob) return out
  const spliced = spliceBody(await out.blob.text(), body)
  if (spliced === null) throw new Error('The calibration G-code could not be placed in the sliced file.')
  const blob = new Blob([spliced], { type: 'text/x-gcode' })
  return { ...out, blob, bytes: blob.size, sha256: await sha256Hex(await blob.arrayBuffer()) }
}
