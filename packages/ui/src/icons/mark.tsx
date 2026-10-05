'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useTheme } from '../theme-provider'
import { BRAND } from '../tokens'

import { MARK_PATH, MARK_VIEWBOX, markCutFor, markRings, type MarkCut } from './mark-path'

export { MARK_PATH, MARK_CUTS, markRings, markCutFor } from './mark-path'
export type { MarkCut } from './mark-path'

export interface MarkProps {
  /** Pixel size of the square mark. */
  size?: number
  className?: string
  /** Optical cut. Defaults to the one that suits `size`: full from 48 px, small from 20 px, tab below. */
  cut?: MarkCut
  /** Colors for one-color uses, such as a watermark. `to` colors the outer outline, `from` the rest. Default to the theme. */
  from?: string
  to?: string
  /** Accessible name; without one the mark is decorative. */
  label?: string
}

/**
 * The X mark: nested outlines in pink, purple and cyan, the way a slicer offsets each wall inward.
 * The outer outline takes the theme's pink, the next the purple and the core the cyan. Smaller
 * sizes get a heavier cut with fewer rings so it stays crisp.
 */
export function Mark({ size = 16, className, cut, from, to, label }: MarkProps) {
  const rings = markRings(cut ?? markCutFor(size))
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={MARK_VIEWBOX}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {rings.map((g) => {
        const color = g.role === 'o' ? to : from
        const cls = color ? undefined : `sx-mark-${g.role}`
        return g.width === null ? (
          <path key={g.role} className={cls} fill={color} d={g.path} />
        ) : (
          <path key={g.role} className={cls} fill="none" stroke={color} strokeWidth={g.width} strokeLinejoin="miter" d={g.path} />
        )
      })}
    </svg>
  )
}

export interface LogoProps {
  /** md is the app bar size (15px word, 15.5px mark). */
  size?: 'md' | 'lg' | 'xl'
  className?: string
  /** Render as a link (the site's home link) instead of a span. */
  href?: string
  /** Show the positioning line under the wordmark (splash, about, site footer). */
  tagline?: boolean
}

const LOGO_MARK_PX = { md: 15.5, lg: 24.5, xl: 41 } as const

/** The wordmark: "Slicer" in Unbounded with the layered X standing in for the last letter. */
export function Logo({ size = 'md', className, href, tagline }: LogoProps) {
  const { logo } = useTheme()
  const inner = (
    <>
      <span className="sx-brand-word" aria-hidden="true">
        Slicer
      </span>
      <span className="sx-brand-x">
        <Mark size={LOGO_MARK_PX[size]} />
      </span>
    </>
  )
  const cls = className ? `sx-brand ${className}` : 'sx-brand'
  if (logo !== undefined) {
    return href ? (
      <a className={cls} data-size={size} href={href}>
        {logo}
      </a>
    ) : (
      <span className={cls} data-size={size}>
        {logo}
      </span>
    )
  }
  const label = tagline ? `${BRAND.name}. ${BRAND.tagline}` : BRAND.name
  const lockup = tagline ? (
    <span className="sx-brand-lockup">
      <span className="sx-brand-row">{inner}</span>
      <span className="sx-brand-tagline">{BRAND.tagline}</span>
    </span>
  ) : (
    inner
  )
  if (href) {
    return (
      <a className={cls} data-size={size} data-tagline={tagline ? true : undefined} href={href} aria-label={label}>
        {lockup}
      </a>
    )
  }
  return (
    <span className={cls} data-size={size} data-tagline={tagline ? true : undefined} role="img" aria-label={label}>
      {lockup}
    </span>
  )
}
