// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Web pages the Help menu opens, and how they open: the desktop shell registers the system browser,
// the browser build opens a new tab. The pages are the edition's own (links in the edition config),
// falling back to SlicerX's. The desktop shell opens https pages only.
import { editionLinks } from '@slicerx/edition-config'
import { currentEdition } from '../edition'

/** The edition's docs, support and download pages. */
export function helpLinks(): { docs: string; support: string; download: string } {
  return editionLinks(currentEdition())
}

let opener: ((url: string) => Promise<void>) | null = null

export function registerLinkOpener(open: (url: string) => Promise<void>): void {
  opener = open
}

export async function openLink(url: string): Promise<void> {
  if (opener) await opener(url)
  else window.open(url, '_blank', 'noopener')
}
