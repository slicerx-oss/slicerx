// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

/** One third-party brand mark plus the provenance needed to use it. */
export interface BrandLogoRecord {
  slug: string
  title: string
  /** viewBox shared by the mono and color markup. */
  viewBox: string
  /** Inner SVG markup for the monochrome mark, drawn so it takes currentColor. */
  svg: string
  /** Official brand color as lowercase hex. */
  color: string
  /** Inner SVG markup for the official full-color mark, when one is available under a usable license. */
  colorSvg?: string
  /** Where the mark was retrieved from. */
  source: string
  /** SPDX identifier or license name of the mark's artwork as published at the source. */
  license: string
  /** ISO date the artwork was retrieved. */
  retrieved: string
}
