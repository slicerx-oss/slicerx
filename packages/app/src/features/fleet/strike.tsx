// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The strike: the X drawn as offset perimeters, broken where it lands. The guard stamps it on the camera frame where it
// saw something, the same mark the collision check puts in Preview. Placeholder until the strike icon is in
// packages/ui/icons; this larger version with its ring stays for the camera frame.

/** The strike over a frame, centered on its box. */
export function StrikeMark({ size = 64, pulse = true }: { size?: number; pulse?: boolean }) {
  return (
    <svg className="strike" viewBox="-32 -32 64 64" width={size} height={size} overflow="visible" aria-hidden="true" data-pulse={pulse || undefined}>
      <circle className="strike-ring" r="27" />
      <circle className="strike-core" r="20" />
      <g className="strike-x">
        <path d="M-17.5 -14.5 L-5.5 -2.5 M3.5 6.5 L14.5 17.5 M-14.5 -17.5 L-2.5 -5.5 M6.5 3.5 L17.5 14.5" />
        <path d="M14.5 -17.5 L3.5 -6.5 M-6.5 3.5 L-17.5 14.5 M17.5 -14.5 L6.5 -3.5 M-3.5 6.5 L-14.5 17.5" />
      </g>
      <g className="strike-crack">
        <path d="M0 -5 L0 -11 M5 0 L11 0 M0 5 L0 11 M-5 0 L-11 0" />
      </g>
      <rect className="strike-dot" x="-2.6" y="-2.6" width="5.2" height="5.2" transform="rotate(45)" />
    </svg>
  )
}
