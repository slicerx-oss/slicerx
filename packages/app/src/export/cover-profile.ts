// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The camera every Vault cover is drawn from, kept apart from the renderer so
// the card stand-in can share it without loading the renderer.

/** The fixed camera and fit rule every cover uses. */
export const COVER_PROFILE = {
  /** turn about z, degrees */
  yawDeg: -45,
  /** look down, degrees (true isometric) */
  elevDeg: 35.264,
  /** the projected part fills this share of the width or height, whichever is hit first */
  fitWidth: 0.56,
  fitHeight: 0.54,
  /** the part's lowest point sits this far down the frame */
  base: 0.76,
  /** grid square, mm */
  gridMm: 10,
} as const

const YAW = (COVER_PROFILE.yawDeg * Math.PI) / 180
const ELEV = (COVER_PROFILE.elevDeg * Math.PI) / 180
const CY = Math.cos(YAW)
const SY = Math.sin(YAW)
const CE = Math.cos(ELEV)
const SE = Math.sin(ELEV)

/** World mm to view: x right, y up, depth toward the camera. Linear, so it turns normals too. */
export function isoView(x: number, y: number, z: number): [number, number, number] {
  const x1 = x * CY - y * SY
  const y1 = x * SY + y * CY
  return [x1, y1 * SE + z * CE, -y1 * CE + z * SE]
}

