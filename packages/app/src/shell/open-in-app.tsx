// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The CAD-only browser build's way to slice: the design downloads as a project file, then the desktop app on this
// computer is asked to open it through its link, `<scheme>://open?download=<sha256>&name=<file>`. The app finds the
// file it just got in the Downloads folder by that hash (it never takes a path from a page) and asks before it opens
// it. When nothing answers the link, the page offers the app's download.
import { Button } from '@slicerx/ui'
import { useState } from 'react'
import { appName, currentEdition } from '../edition'
import { sx3mfBytes } from '../export/actions'
import { allPlates, projectBase } from '../plate/plates'
import { get, toast } from '../state/store'

/** How long the page waits for the app to take the link (the window loses focus) before it offers the download. */
export const ANSWER_MS = 2500

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

/** The link that asks the desktop app to open a project this page downloaded. */
export function openLink(scheme: string, sha256: string, name: string): string {
  return `${scheme}://open?download=${sha256}&name=${encodeURIComponent(name)}`
}

/** Downloads the design and asks the app to open it. False when there is nothing to send. */
export async function openInApp(): Promise<boolean> {
  const plates = allPlates(get())
  if (plates.every((p) => p.objects.length === 0)) {
    toast('There is nothing on the plate to open.', 'info')
    return false
  }
  const bytes = await sx3mfBytes(plates)
  const name = `${projectBase()}.sx3mf`
  const sha = hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
  // A plain download, so the file lands in the Downloads folder the app looks in (a save dialog could put it anywhere).
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/vnd.slicerx.sx3mf' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  const edition = currentEdition()
  let answered = false
  const away = () => (answered = true)
  window.addEventListener('blur', away, { once: true })
  window.location.assign(openLink(edition.apps.deepLinkScheme, sha, name))
  setTimeout(() => {
    window.removeEventListener('blur', away)
    if (answered) return
    const site = new URL(edition.routes.landing, window.location.origin).href
    toast(`${name} is in your Downloads. Open it in ${appName()} to slice it.`, 'info', { label: `Get ${appName()}`, run: () => window.open(site, '_blank', 'noopener') })
  }, ANSWER_MS)
  return true
}

export function OpenInAppButton() {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="primary"
      size="sm"
      tip="nav.openInApp"
      data-testid="open-in-app"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void openInApp().finally(() => setBusy(false))
      }}
    >
      Open in {appName()}
    </Button>
  )
}
