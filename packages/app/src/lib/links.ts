// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Web pages the Help menu opens, and how they open: the desktop shell registers the system browser,
// the browser build opens a new tab. The pages are the edition's own (links in the edition config),
// falling back to SlicerX's. The desktop shell opens only the pages its capabilities allow
// (editionPages in the edition config); a refused or failed open shows the link to copy.
import { editionLinks } from '@slicerx/edition-config'
import { webUiUrl } from '@slicerx/printer-catalog'
import { currentEdition } from '../edition'
import { toast } from '../state/store'

/** The edition's docs, support and download pages. */
export function helpLinks(): { docs: string; support: string; download: string } {
  return editionLinks(currentEdition())
}

let opener: ((url: string) => Promise<void>) | null = null

/** The desktop shell's opener. Links in the page (`<a target="_blank">`) go through it too. */
export function registerLinkOpener(open: (url: string) => Promise<void>): void {
  if (!opener && typeof document !== 'undefined') document.addEventListener('click', onLinkClick)
  opener = open
}

/** Opens a page with `open`; when it is refused or fails, a toast shows the link to copy instead. */
export async function openSafely(url: string, open: (url: string) => Promise<void>): Promise<void> {
  try {
    await open(url)
  } catch {
    toast(`Couldn't open ${url}. Copy the link to open it in your browser.`, 'warn', { label: 'Copy link', run: () => void navigator.clipboard?.writeText(url).then(() => toast('Copied', 'ok')) })
  }
}

export async function openLink(url: string): Promise<void> {
  const open = opener
  if (open) await openSafely(href(url), open)
  else window.open(url, '_blank', 'noopener')
}

let printerOpener: ((url: string) => Promise<void>) | null = null

/**
 * The desktop shell's opener for printers' own web pages. Those are local addresses the opener's allow list never
 * takes, so the shell checks each one is on the local network itself (src-tauri/src/printer_page.rs).
 */
export function registerPrinterPageOpener(open: (url: string) => Promise<void>): void {
  printerOpener = open
}

/**
 * Opens a printer's own web page in the browser: the address from `printerWebUi` (@slicerx/printer-catalog), built
 * from the saved printer. Anything else, such as a host off the local network, is refused before it leaves the app.
 */
export async function openPrinterPage(url: string): Promise<void> {
  if (!isPrinterPage(url)) {
    toast("That printer's address is not on your local network, so its page was not opened.", 'warn')
    return
  }
  if (printerOpener) await openSafely(url, printerOpener)
  else window.open(url, '_blank', 'noopener')
}

/** A printer page as `webUiUrl` builds it: http, a local host, a plain path. */
function isPrinterPage(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' || u.username || u.password || u.search || u.hash) return false
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const port = u.port ? Number(u.port) : 80
  return webUiUrl(host, port, u.pathname) === url
}

/** The link as the shell compares it with its allow list (allowPattern): parsed, so `https://a.example` gains its `/`. */
function href(url: string): string {
  try {
    return new URL(url).href
  } catch {
    return url
  }
}

/** A click on a link that would leave the app: the ones the opener plugin used to take, now through openLink. */
function onLinkClick(e: MouseEvent): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.altKey) return
  const a = e.composedPath().find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement)
  if (!a?.href || (a.target !== '_blank' && !e.ctrlKey && !e.shiftKey)) return
  if (!/^(https?|mailto|tel):/.test(a.href)) return
  e.preventDefault()
  void openLink(a.href)
}
