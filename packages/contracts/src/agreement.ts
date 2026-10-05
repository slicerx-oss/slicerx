// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The pre-alpha agreement, shared by the app's first-run screen and the agreement @slicerx/embed gives
// to apps that build SlicerX in, so both ask again at the same time.

/** Raise this when the agreement text changes in substance: everyone sees it again. */
export const AGREEMENT_VERSION = 1

/** The Discord bug-reports channel, when an edition does not name its own place. */
export const DEFAULT_BUG_REPORTS_URL = 'https://discord.com/channels/1555048815881355324/1556010155802628228'

/** What a person accepted, and when (ISO date). */
export interface AgreementRecord {
  version: number
  acceptedAt: string
}
