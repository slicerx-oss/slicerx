// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createElement } from 'react'
import type { BrandLogoRecord } from './types'
import { klipper } from './logos/klipper'
import { octoprint } from './logos/octoprint'
import { mainsail } from './logos/mainsail'
import { fluidd } from './logos/fluidd'
import { spoolman } from './logos/spoolman'
import { homeAssistant } from './logos/home-assistant'
import { claude } from './logos/claude'
import { cursor } from './logos/cursor'
import { githubCopilot } from './logos/github-copilot'
import { zed } from './logos/zed'
import { windsurf } from './logos/windsurf'

export const BRAND_LOGOS = {
  'klipper': klipper,
  'octoprint': octoprint,
  'mainsail': mainsail,
  'fluidd': fluidd,
  'spoolman': spoolman,
  'home-assistant': homeAssistant,
  'claude': claude,
  'cursor': cursor,
  'github-copilot': githubCopilot,
  'zed': zed,
  'windsurf': windsurf,
} as const satisfies Record<string, BrandLogoRecord>

export type { BrandLogoRecord }
export type BrandSlug = keyof typeof BRAND_LOGOS
export const BRAND_SLUGS = Object.keys(BRAND_LOGOS) as BrandSlug[]

export interface BrandLogoProps {
  slug: BrandSlug
  /** Pixel size of the square box the mark is fitted into. Default 20. */
  size?: number
  /** mono paints the mark in currentColor. color uses the official artwork or brand hex. */
  variant?: 'mono' | 'color'
  /** Accessible name. Without one the logo is decorative and hidden from readers. */
  title?: string
  className?: string
}

/** A third-party brand mark. No hooks, so it renders on the server. */
export function BrandLogo({ slug, size = 20, variant = 'mono', title, className }: BrandLogoProps) {
  const logo: BrandLogoRecord = BRAND_LOGOS[slug]
  const colorArt = variant === 'color' && logo.colorSvg !== undefined
  const markup = colorArt ? (logo.colorSvg as string) : logo.svg
  const fill = variant === 'color' ? logo.color : 'currentColor'
  return createElement('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    className,
    width: size,
    height: size,
    viewBox: logo.viewBox,
    fill: colorArt ? undefined : fill,
    role: title ? 'img' : undefined,
    'aria-label': title,
    'aria-hidden': title ? undefined : true,
    focusable: 'false',
    dangerouslySetInnerHTML: { __html: markup },
  })
}

export { OfficialMark, OFFICIAL_MARKS, hasOfficialMark } from './marks'
export type { OfficialMarkRecord, OfficialMarkSlug, OfficialMarkProps } from './marks'
