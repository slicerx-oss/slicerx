// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printer brand marks are optional artwork: an app entry that ships them
// registers a renderer here, and everything else falls back to a line icon.
// The renderer gets the surface the mark sits on, so a maker's dark variant
// goes on light surfaces and its light variant on dark ones, never altered.
import { Icon } from '@slicerx/ui'
import type { ReactNode } from 'react'
import { useApp } from '../state/store'

export type VendorSurface = 'dark' | 'light'
type Render = (vendor: string, size: number, on: VendorSurface) => ReactNode | null

let render: Render | null = null

/** Called once by an app entry that bundles brand artwork. */
export function setVendorMarks(r: Render): void {
  render = r
}

export function VendorMark({ vendor, size = 20 }: { vendor: string; size?: number }) {
  const scheme = useApp((s) => s.scheme)
  return <>{render?.(vendor, size, scheme) ?? <Icon name="printer" size={size} />}</>
}
