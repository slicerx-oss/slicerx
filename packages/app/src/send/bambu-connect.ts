// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printing on a Bambu Lab printer with Developer Mode off. The printer still sends status with the access code, but
// it refuses commands from other apps (Bambu Lab's Authorization Control, wiki.bambulab.com/en/software/third-party-
// integration), so the print goes through Bambu Connect, Bambu Lab's own app for third-party software: the plate is
// exported as a .gcode.3mf and opened there with the URL scheme on Bambu Lab's wiki
// (https://wiki.bambulab.com/en/software/bambu-connect, "Launching Bambu Connect from Third-Party Software"), and the
// person presses Print in Bambu Connect. Bambu Lab makes no Bambu Connect for Linux, and a web page has no file path
// to hand over, so those save the file instead. With Developer Mode on, prints go straight from the app as before.
import type { BambuConnectHost, FileHost, PrinterInfo, PrinterStatus } from '@slicerx/contracts'

/** Bambu Lab's Bambu Connect page, with the downloads for Windows and macOS. */
export const BAMBU_CONNECT_DOWNLOAD = 'https://wiki.bambulab.com/en/software/bambu-connect'

/** How a print reaches the printer: straight from the app, or through Bambu Connect. */
export type PrintRoute = 'direct' | 'bambu-connect'

/**
 * Bambu Connect for a Bambu Lab printer that reports Developer Mode off (status only); direct otherwise. A printer
 * that does not say goes direct, and a refusal there offers Bambu Connect on the Print sheet.
 */
export function printRoute(printer: Pick<PrinterInfo, 'plugin'>, status: Pick<PrinterStatus, 'live'> | null | undefined): PrintRoute {
  return printer.plugin === 'bambu-lan' && status?.live?.monitorOnly === true ? 'bambu-connect' : 'direct'
}

/** What happened to the file: opened in Bambu Connect, Bambu Connect missing, saved instead, or the save canceled. */
export type HandOff = { outcome: 'opened' } | { outcome: 'missing' } | { outcome: 'saved'; fileName: string; why: 'linux' | 'web' } | { outcome: 'canceled' }

/** Whether this computer runs Linux, where Bambu Lab makes no Bambu Connect. */
export function onLinux(nav: Pick<Navigator, 'userAgent'> | undefined = globalThis.navigator): boolean {
  const ua = nav?.userAgent ?? ''
  return /Linux/.test(ua) && !/Android/.test(ua)
}

/**
 * Hands the exported plate to Bambu Connect: the desktop shell writes it and opens Bambu Lab's import link. Where
 * that cannot happen (Linux, or the browser) the file is saved for the person to take over.
 */
export async function handToBambuConnect(
  host: { bambuConnect?: BambuConnectHost; files: Pick<FileHost, 'save'> },
  file: { name: string; data: ArrayBuffer },
  title: string,
  linux = onLinux(),
): Promise<HandOff> {
  if (host.bambuConnect && !linux) {
    const r = await host.bambuConnect.open(file.name, file.data, title)
    if (r !== 'unsupported') return { outcome: r }
  }
  const saved = await host.files.save(file.name, file.data, { accept: ['.3mf'] })
  if (!saved) return { outcome: 'canceled' }
  return { outcome: 'saved', fileName: saved.name || file.name, why: linux || host.bambuConnect ? 'linux' : 'web' }
}

/** The one line shown after a hand-off, its tone, and a download link where Bambu Connect is needed. */
export function handOffCopy(h: HandOff, appName: string): { text: string; tone: 'ok' | 'info' | 'warn'; download?: string } {
  switch (h.outcome) {
    case 'opened':
      return { text: 'Opening in Bambu Connect: press Print there', tone: 'ok' }
    case 'missing':
      return { text: 'Bambu Connect isn\'t installed. Install it from Bambu Lab, then print again.', tone: 'warn', download: BAMBU_CONNECT_DOWNLOAD }
    case 'saved':
      return h.why === 'linux'
        ? { text: `Saved ${h.fileName}. Bambu Connect isn't available for Linux yet: copy the file to the printer's SD card and start it there, or turn on Developer Mode to print directly from ${appName}.`, tone: 'info' }
        : { text: `Saved ${h.fileName}. Open it in Bambu Connect and press Print there.`, tone: 'info', download: BAMBU_CONNECT_DOWNLOAD }
    case 'canceled':
      return { text: 'Nothing was sent', tone: 'info' }
  }
}
