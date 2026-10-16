// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// ?planes: the view shows Create Sketch's origin planes, drawn in the theme's accent, so a host can check its edition
// colors reach the Model tools. Uses the React pieces, since the planes are a handle call.
import { createRoot } from 'react-dom/client'
import { EmbedTheme, injectStyles, Viewport, type EmbedEdition } from '../src/index'

export async function mountPlanes(editionUrl: string | null, light: boolean): Promise<void> {
  injectStyles()
  const edition = editionUrl ? ((await (await fetch(editionUrl)).json()) as EmbedEdition) : null
  const vp = document.getElementById('vp')
  const host = document.createElement('div')
  host.id = 'planes'
  host.style.cssText = 'height: 460px; border-radius: 8px; overflow: hidden'
  // the theme wrapper and the view fill the slot the element had
  const fill = document.createElement('style')
  fill.textContent = '#planes > *, #planes > * > * { width: 100%; height: 100%; }'
  document.head.append(fill)
  vp?.replaceWith(host)
  createRoot(host).render(
    <EmbedTheme theme={light ? 'light' : 'dark'} edition={edition}>
      <Viewport label="Origin planes" reveal={false} style={{ width: '100%', height: '100%' }} onReady={(handle) => handle.setOriginPlanes({ center: [128, 128, 0], sizeMm: 140 })} />
    </EmbedTheme>,
  )
}
