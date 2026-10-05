// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Cover art and initials for store listings.
import type { Listing } from '@slicerx/contracts'

/** The listing's cover image, or null when the creator has not uploaded one. */
export function coverFor(listing: Listing): string | null {
  return listing.coverUrl && /^(https?:|\/|data:|blob:)/.test(listing.coverUrl) ? listing.coverUrl : null
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z0-9]/.test(w) && w.toLowerCase() !== 'and')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}
