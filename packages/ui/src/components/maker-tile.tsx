// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

/** Printer makers SlicerX lists. Plain names and letters only; no maker artwork. */
export const MAKERS = {
  'bambu-lab': { name: 'Bambu Lab', letters: 'Bl' },
  prusa: { name: 'Prusa', letters: 'Pr' },
  creality: { name: 'Creality', letters: 'Cr' },
  elegoo: { name: 'Elegoo', letters: 'El' },
  anycubic: { name: 'Anycubic', letters: 'An' },
  voron: { name: 'Voron', letters: 'Vo' },
  snapmaker: { name: 'Snapmaker', letters: 'Sn' },
  sovol: { name: 'Sovol', letters: 'So' },
  qidi: { name: 'Qidi', letters: 'Qi' },
  flashforge: { name: 'Flashforge', letters: 'Ff' },
  ankermake: { name: 'AnkerMake', letters: 'Ak' },
  ratrig: { name: 'Rat Rig', letters: 'Rr' },
} as const

export type MakerSlug = keyof typeof MAKERS

const VENDOR_PATTERNS: readonly [RegExp, MakerSlug][] = [
  [/bambu/i, 'bambu-lab'], [/prusa/i, 'prusa'], [/creality/i, 'creality'], [/elegoo/i, 'elegoo'],
  [/anycubic/i, 'anycubic'], [/voron/i, 'voron'], [/snapmaker/i, 'snapmaker'], [/sovol/i, 'sovol'],
  [/qidi/i, 'qidi'], [/flashforge/i, 'flashforge'], [/anker/i, 'ankermake'], [/rat ?rig/i, 'ratrig'],
]

/** The tile for a vendor name as printer profiles spell it, or null when the maker has no tile. */
export function makerSlugFor(vendor: string): MakerSlug | null {
  return VENDOR_PATTERNS.find(([re]) => re.test(vendor))?.[1] ?? null
}

export interface MakerTileProps {
  maker: MakerSlug
  /** Pixel size of the square. Default 24. */
  size?: number
  /** Adds the maker name as the accessible name. Without it the tile is decorative. */
  label?: boolean
  className?: string
}

/**
 * A neutral lettermark tile that stands in for a printer maker: a rounded square in the icon stroke
 * with the maker's initials. It is not a logo and implies no affiliation. Use it beside the maker's
 * plain-text name.
 */
export function MakerTile({ maker, size = 24, label, className }: MakerTileProps) {
  const { name, letters } = MAKERS[maker]
  return (
    <svg
      className={className ? `sx-ic ${className}` : 'sx-ic'}
      style={{ width: size, height: size }}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label ? name : undefined}
      aria-hidden={label ? undefined : true}
    >
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <text
        x="12"
        y="12.2"
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
        stroke="none"
        className="sx-maker-letters"
      >
        {letters}
      </text>
    </svg>
  )
}
