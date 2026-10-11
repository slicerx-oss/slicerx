// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { SVGProps } from 'react'

// muninn's mark (icons/extra.mjs) facing left, its wing apart so it can beat
export const RAVEN_BODY = 'M1.5 12l5.9-3.4c1.3-.7 2.8-.6 3.9.2 2.1 1.3 4.5 2 6.7 2.3l4.5-1.3-.8 3.2-3.9.5c-2 2-6.1 2.6-8.6.8-.4-.3-.8-.7-1.1-1.1l-.8-.1.4-.6z'
export const RAVEN_WING = 'M11 9.1C11.6 5.6 14.2 2.6 19.5 1.5l-.7 1.8 1.6-.3-1 1.9 1.3.1-1.6 2.2c-1 1.4-2.4 2.8-4 3.9'
export const RAVEN_EYE = { cx: 8.9, cy: 10.5, r: 0.85 }

export interface RavenProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Pixel size; the bird sits on the 24 px icon grid. */
  size?: number
  /** Beats its wing. Still under reduced motion. */
  flap?: boolean
  facing?: 'left' | 'right'
  /** Accessible name. Without one the raven is decorative. */
  label?: string
}

/** One raven in flight, huginn or muninn, drawn like the icon set with a dark body inside the stroke. */
export function Raven({ size = 24, flap = false, facing = 'left', label, className, ...rest }: RavenProps) {
  return (
    <svg
      className={['sx-raven', className].filter(Boolean).join(' ')}
      data-flap={flap || undefined}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      {...rest}
    >
      <g transform={facing === 'right' ? 'matrix(-1 0 0 1 24 0)' : undefined}>
        <path className="sx-raven-body" d={RAVEN_BODY} />
        <path className="sx-raven-wing" d={RAVEN_WING} />
        <circle className="sx-raven-eye" {...RAVEN_EYE} />
      </g>
    </svg>
  )
}

// elder futhark runes on a 4 by 8 box, straight strokes only (the camera's and the site's ring)
const RUNES: Record<string, string> = {
  H: 'M0 0v8M4 0v8M0 2.5l4 3',
  U: 'M0 8V0l4 3v5',
  G: 'M0 0l4 8M4 0L0 8',
  I: 'M2 0v8',
  N: 'M2 0v8M.5 3l3 2',
  M: 'M0 0v8M4 0v8M0 0l4 4M4 0L0 4',
}
const RING = [...'HUGINN MUNINN ']

export interface RuneRingProps {
  /** Pixel size across. */
  size?: number
  /** Turns against the clock (muninn); with the clock otherwise (huginn). Still under reduced motion. */
  reverse?: boolean
  className?: string
}

/** The ring of runes spelling huginn and muninn, turning slowly. Decorative. */
export function RuneRing({ size = 34, reverse = false, className }: RuneRingProps) {
  return (
    <svg className={['sx-rune-ring', className].filter(Boolean).join(' ')} data-reverse={reverse || undefined} width={size} height={size} viewBox="0 0 120 120" aria-hidden="true">
      <circle cx="60" cy="60" r="56" />
      <circle cx="60" cy="60" r="42" />
      {RING.map((c, i) => {
        const at = `rotate(${(i * 360) / RING.length} 60 60) translate(58.5 8) scale(.75)`
        return c === ' ' ? <circle key={i} cx="2" cy="4" r=".9" transform={at} className="sx-rune-sep" /> : <path key={i} d={RUNES[c]} transform={at} />
      })}
    </svg>
  )
}
