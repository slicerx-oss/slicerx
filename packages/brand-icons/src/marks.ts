// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The images in ../assets are third-party logos, not covered by the SlicerX license (see TRADEMARKS.md, LOGOS.md).
import { createElement } from 'react'

/** An official raster mark exactly as the maker's press kit provides it: one file for dark backgrounds, one for light. */
export interface OfficialMarkRecord {
  slug: string
  title: string
  /** Pixel size of the source files, for the aspect ratio. */
  width: number
  height: number
  /** The mark as supplied for dark backgrounds (white artwork). */
  dark: string
  /** The mark as supplied for light backgrounds (black artwork). */
  light: string
  source: string
  /** What the maker's terms say, plus the owner's report of permission. */
  license: string
  retrieved: string
}

const asset = (file: string) => new URL(`../assets/${file}`, import.meta.url).href

export const OFFICIAL_MARKS = {
  prusa: {
    slug: 'prusa',
    title: 'Prusa Research',
    width: 2495,
    height: 1550,
    dark: asset('prusa-white.png'),
    light: asset('prusa-black.png'),
    source: 'https://prusa3d.com/downloads/press/prusaresearch.zip (logo-kit/rgb, from https://www.prusa3d.com/page/media-assets_987/)',
    license: 'Press kit: "ready for immediate release worldwide". Brand manual: black or white only, no alterations. Permission reported by the maintainers, 2026-09-30.',
    retrieved: '2026-09-30',
  },
  flashforge: {
    slug: 'flashforge',
    title: 'Flashforge',
    width: 1000,
    height: 200,
    dark: asset('flashforge-white.png'),
    light: asset('flashforge-black.png'),
    source: 'https://cdn.shopify.com/s/files/1/0591/8641/3646/files/Logo.zip?v=1770363731 (from https://www.flashforge.com/pages/press)',
    license: 'Media kit files, used unaltered per the Flashforge brand guidelines. Permission reported by the maintainers, 2026-09-30.',
    retrieved: '2026-09-30',
  },
} as const satisfies Record<string, OfficialMarkRecord>

export type OfficialMarkSlug = keyof typeof OFFICIAL_MARKS

export function hasOfficialMark(slug: string): slug is OfficialMarkSlug {
  return Object.hasOwn(OFFICIAL_MARKS, slug)
}

export interface OfficialMarkProps {
  slug: OfficialMarkSlug
  /** Pixel size of the square box the mark is fitted into, keeping its proportions. Default 20. */
  size?: number
  /** Which supplied file to use. The app is dark, so the default is 'dark'. */
  on?: 'dark' | 'light'
  title?: string
  className?: string
}

/** A maker's official mark, unaltered and fitted (never stretched) into a square box. */
export function OfficialMark({ slug, size = 20, on = 'dark', title, className }: OfficialMarkProps) {
  const m: OfficialMarkRecord = OFFICIAL_MARKS[slug]
  return createElement('img', {
    src: on === 'dark' ? m.dark : m.light,
    alt: title ?? '',
    width: size,
    height: size,
    className,
    style: { objectFit: 'contain' },
    'aria-hidden': title ? undefined : true,
  })
}
