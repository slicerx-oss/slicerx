// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The pre-alpha agreement, shared by the app's first-run screen and the agreement @slicerx/embed gives
// to apps that build SlicerX in, so both ask again at the same time.

/** Raise this when the agreement text changes in substance: everyone sees it again. */
export const AGREEMENT_VERSION = 1

/**
 * The agreement in a host that cannot slice (the CAD-only browser build) is about modeling only, with its own number,
 * so a change to one text asks again only the people who read it. It started at 2 so that people who accepted the
 * slicing text (1) in the browser read this one.
 */
export const MODEL_AGREEMENT_VERSION = 2

/** The agreement version for a host that slices, or one that only models. */
export function agreementVersion(slices: boolean): number {
  return slices ? AGREEMENT_VERSION : MODEL_AGREEMENT_VERSION
}

/** The Discord bug-reports channel, when an edition does not name its own place. */
export const DEFAULT_BUG_REPORTS_URL = 'https://discord.com/channels/1555048815881355324/1556010155802628228'

/** What a person accepted, and when (ISO date). */
export interface AgreementRecord {
  version: number
  acceptedAt: string
}
