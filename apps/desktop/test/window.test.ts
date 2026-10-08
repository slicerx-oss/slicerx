// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The desktop window is one surface: no inset frame, and on macOS the app's top bar is the title area.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = import.meta.dirname
const read = (p: string) => readFileSync(resolve(here, p), 'utf8')

describe('the desktop window', () => {
  it('overlays the macOS title bar and hides its title', () => {
    const main = (JSON.parse(read('../src-tauri/tauri.conf.json')) as { app: { windows: Record<string, unknown>[] } }).app.windows[0]
    expect(main).toMatchObject({ label: 'main', titleBarStyle: 'Overlay', hiddenTitle: true })
    // centered in the 52 px top bar
    expect(main?.['trafficLightPosition']).toEqual({ x: 18, y: 20 })
  })

  it('lets the page drag and zoom the window from its top bar', () => {
    const caps = JSON.parse(read('../src-tauri/capabilities/default.json')) as { permissions: unknown[] }
    expect(caps.permissions).toEqual(expect.arrayContaining(['core:window:allow-start-dragging', 'core:window:allow-internal-toggle-maximize']))
    expect(read('../../../packages/app/src/shell/top-bar.tsx')).toContain('data-tauri-drag-region')
    expect(read('../../../packages/app/src/first-run/first-run.tsx')).toContain('className="fr-top" data-tauri-drag-region')
  })

  it('fills the window edge to edge and leaves room for the traffic lights', () => {
    const css = read('../../../packages/ui/src/styles.css')
    expect(css).toContain(':root[data-shell="desktop"] .sx-frame-root { padding: 0; }')
    expect(css).toContain(':root[data-shell="desktop"] .sx-frame { border: 0; border-radius: 0; }')
    expect(css).toMatch(/:root\[data-shell="desktop"\]\[data-os="mac"\] \.sx-appbar \{ padding-left: \d+px; \}/)
    expect(read('../src/main.tsx')).toContain("document.documentElement.dataset['shell'] = 'desktop'")
  })
})
