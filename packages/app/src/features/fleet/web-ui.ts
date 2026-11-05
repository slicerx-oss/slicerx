// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The printer's own web page (Mainsail, Fluidd, OctoPrint, Duet Web Control, PrusaLink), which the printer menu and
// the live view link to. It opens in the browser; SlicerX never shows it inside the app.
import { printerWebUi } from '@slicerx/printer-catalog'
import type { FleetRow } from '../../lib/queries'

export const WEB_UI_LABEL = 'Open web interface'

/** The page's address, from the saved printer; null when it has none or is not on the local network. */
export function webUiFor(r: FleetRow): string | null {
  return printerWebUi({ ...r, model: r.model || r.status.model || '' })
}

export function webUiTip(url: string): { title: string; body: string } {
  return { title: 'Web interface', body: `Opens the printer's own page, ${url}, in your browser.` }
}
