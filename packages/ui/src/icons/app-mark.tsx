'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useId } from 'react'

import { perchCutFor, perchShapes, type PerchCut } from './perch-path'

export { perchShapes, perchCutFor } from './perch-path'
export type { PerchCut, PerchShapes } from './perch-path'

export interface AppMarkProps {
  /** Pixel size of the square mark. */
  size?: number
  className?: string
  /** Optical cut. Defaults to the one that suits `size`: full from 64 px, small from 20 px, the 16 px cut below. */
  cut?: PerchCut
  /** One color for the whole mark, such as `currentColor`. Defaults to the theme's gradient. */
  color?: string
  /** Accessible name; without one the mark is decorative. */
  label?: string
}

/**
 * The app mark: huginn perched on three printed layers, in the theme's purple to pink. It stands
 * for the app on its own, where an icon goes; the wordmark keeps the layered X.
 */
export function AppMark({ size = 24, className, cut, color, label }: AppMarkProps) {
  const uid = useId().replace(/[^\w-]/g, '')
  const s = perchShapes(cut ?? perchCutFor(size))
  const bird = color ?? `url(#sx-pb-${uid})`
  const bar = color ?? `url(#sx-pl-${uid})`
  const g = s.birdGradient
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={s.viewBox}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        {color ? null : (
          <>
            <linearGradient id={`sx-pb-${uid}`} gradientUnits="userSpaceOnUse" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}>
              <stop offset="0" style={{ stopColor: 'var(--grad-from)' }} />
              <stop offset="1" style={{ stopColor: 'var(--grad-to)' }} />
            </linearGradient>
            <linearGradient id={`sx-pl-${uid}`} gradientUnits="userSpaceOnUse" x1={s.barGradient.x1} y1="0" x2={s.barGradient.x2} y2="0">
              <stop offset="0" style={{ stopColor: 'var(--grad-from)' }} />
              <stop offset="1" style={{ stopColor: 'var(--grad-to)' }} />
            </linearGradient>
          </>
        )}
        <mask id={`sx-pc-${uid}`} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <rect width="100" height="100" fill="white" />
          {s.wing ? (
            <g transform={s.birdTransform}>
              {s.wing.width === null ? (
                <path d={s.wing.d} fill="black" />
              ) : (
                <path d={s.wing.d} fill="none" stroke="black" strokeWidth={s.wing.width} strokeLinecap="round" />
              )}
            </g>
          ) : null}
          {s.eye ? <circle cx={s.eye.cx} cy={s.eye.cy} r={s.eye.r} fill="black" /> : null}
        </mask>
      </defs>
      {s.legs ? <path transform={s.birdTransform} d={s.legs.d} fill="none" stroke={bird} strokeWidth={s.legs.width} /> : null}
      {s.bars.map((b) => (
        <rect key={b.y} x={b.x} y={b.y} width={b.width} height={b.height} rx={b.rx} fill={bar} />
      ))}
      <g mask={`url(#sx-pc-${uid})`}>
        <path transform={s.birdTransform} d={s.body} fill={bird} />
      </g>
    </svg>
  )
}
