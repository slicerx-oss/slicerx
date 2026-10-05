// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Spoolhouse window: the pre-alpha agreement first, then the sliced plate in the SlicerX
// viewport, filament per slot, and the settings panel, all in Spoolhouse's theme.
import { Agreement, agreementNeeded, EmbedTheme, injectStyles, RELEASE, SettingsPanel, Viewport, type SettingsChange } from '@slicerx/embed'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { spoolhouseDark, spoolhouseLight } from './brand.ts'

injectStyles()

interface Slice {
  time_text: string
  filament_g: number
  filaments: { slot: number; filament_g: number }[]
}

/** The spools in slots 1 and 2, as the main process sliced them. */
const SLOT_COLORS = ['#F4EE2A', '#00AE42']

/** Crashes of the SlicerX parts, for Spoolhouse's own crash reporting. */
function reportCrash(error: Error): void {
  console.error('[spoolhouse] SlicerX part failed:', error.message, `(SlicerX ${RELEASE.stage})`)
}

function App() {
  const [mustAgree, setMustAgree] = useState(() => agreementNeeded())
  const [scheme, setScheme] = useState<'dark' | 'light'>('dark')
  const [preview, setPreview] = useState<ArrayBuffer | null>(null)
  const [slice, setSlice] = useState<Slice | null>(null)
  const [overrides, setOverrides] = useState<Record<string, unknown>>({})

  useEffect(() => {
    // In Electron the main process sends these over IPC; here they sit next to the page.
    void fetch('./preview.sxpv').then(async (r) => (r.ok ? setPreview(await r.arrayBuffer()) : undefined))
    void fetch('./slice.json').then(async (r) => (r.ok ? setSlice((await r.json()) as Slice) : undefined))
  }, [])

  const theme = scheme === 'dark' ? spoolhouseDark : spoolhouseLight
  return (
    <EmbedTheme theme={theme}>
      <div className="sh-app" data-scheme={scheme} style={{ height: '100vh', display: 'grid', gridTemplateRows: 'auto 1fr', background: 'var(--ink-0)', color: 'var(--fg)' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--line-soft)' }}>
          <strong style={{ font: '600 18px var(--f-display)', color: 'var(--purple)' }}>Spoolhouse</strong>
          <span style={{ color: 'var(--muted)' }}>{slice ? `Plate 1: ${slice.time_text}, ${slice.filament_g} g` : 'No slice yet'}</span>
          <span style={{ flex: 1 }} />
          <button type="button" data-testid="scheme" onClick={() => setScheme(scheme === 'dark' ? 'light' : 'dark')}>
            {scheme === 'dark' ? 'Light' : 'Dark'}
          </button>
          <a href={RELEASE.bugReportsUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--muted)' }}>
            Report a SlicerX bug
          </a>
        </header>
        {mustAgree ? (
          <div style={{ display: 'grid', placeItems: 'center', padding: 24, overflow: 'auto' }}>
            <Agreement appName="Spoolhouse" onAccept={() => setMustAgree(false)} />
          </div>
        ) : (
          <main style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 12, padding: 12, minHeight: 0 }}>
            <Viewport preview={preview} colorMode="tool" toolColors={SLOT_COLORS} view="iso" onError={reportCrash} style={{ minHeight: 320 }} />
            <aside style={{ display: 'grid', gap: 12, alignContent: 'start', overflow: 'auto' }}>
              <ul data-testid="slots" style={{ margin: 0, padding: 12, listStyle: 'none', background: 'var(--ink-1)', borderRadius: 'var(--r-lg)' }}>
                {slice?.filaments.map((f) => (
                  <li key={f.slot}>
                    Slot {f.slot}: {f.filament_g} g
                  </li>
                ))}
              </ul>
              <SettingsPanel mode="easy" onChange={({ overrides: o }: SettingsChange) => setOverrides(o)} />
              <output data-testid="overrides" style={{ color: 'var(--dim)', fontSize: 12 }}>
                {Object.keys(overrides).length} changed settings
              </output>
            </aside>
          </main>
        )}
      </div>
    </EmbedTheme>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
