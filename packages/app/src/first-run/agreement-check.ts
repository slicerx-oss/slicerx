// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether the pre-alpha agreement must be shown, apart from the agreement itself (agreement.tsx), which loads only
// when it opens.
import type { EditionConfig } from '@slicerx/edition-config'
import { crashReportsRequired } from '@slicerx/edition-config'
import { AGREEMENT_VERSION, type Host } from '@slicerx/contracts'

/**
 * Whether the agreement must be shown: a pre-alpha build, not embedded in another app, and not accepted in
 * this version. A build for the end-to-end tests (`build.e2e`, set by SLICERX_E2E=1) skips it, so the specs
 * start at the app.
 */
export function needsAgreement(edition: EditionConfig, host: Pick<Host, 'kind'> & { build?: Pick<Host['build'], 'e2e'> }, accepted: { version: number } | null): boolean {
  if (!crashReportsRequired(edition) || host.kind === 'embedded') return false
  if (host.build?.e2e) return false
  return accepted?.version !== AGREEMENT_VERSION
}
