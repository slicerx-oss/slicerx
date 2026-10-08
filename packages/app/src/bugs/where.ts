// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where bug reports go. A fork never sends people or reports to SlicerX: only to its own link and backend.
import { bugReportsLink, reportsUpload, type EditionConfig } from '@slicerx/edition-config'

/** Where people post bugs: the edition's link, else SlicerX's channel for SlicerX and the reference build only. */
export function bugReportsUrl(edition: EditionConfig): string | null {
  return bugReportsLink(edition)
}

/** A fork with no bug report link and no backend of its own has bug reports off: no Report a bug, no crash reports. */
export function bugReportsOff(edition: EditionConfig): boolean {
  return bugReportsUrl(edition) === null && !reportsUpload(edition)
}
