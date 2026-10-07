// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The first setup screen: the theme, light or dark or following the system, and three quick reading
// options. Every pick applies at once, so the rest of setup already shows in it. The same picker is in
// Settings > Look and feel.
import { Icon } from '@slicerx/ui'
import { EasierToRead } from '../shell/appearance-settings'
import { ThemeModeSeg, ThemePicker } from '../shell/theme-settings'

/** A small workspace drawn from the theme tokens, so it follows the pick live. */
function WorkspacePreview() {
  return (
    <div className="fr-tp" aria-hidden="true">
      <div className="fr-tp-bar">
        <i className="fr-tp-mark" />
        <b />
        <b />
        <b />
      </div>
      <div className="fr-tp-body">
        <div className="fr-tp-side">
          {['printer', 'spool', 'sliders'].map((ic) => (
            <span key={ic} className="fr-tp-card">
              <span className="fr-tp-card-h">
                <Icon name={ic as 'printer'} size={12} />
                <b />
              </span>
              <i />
              <i />
            </span>
          ))}
        </div>
        <div className="fr-tp-plate">
          <span className="fr-tp-bed" />
          <span className="fr-tp-obj" data-on />
          <span className="fr-tp-obj" />
          <span className="fr-tp-pills">
            <em data-tone="ok" />
            <em data-tone="warn" />
            <em data-tone="err" />
          </span>
          <span className="fr-tp-go" />
        </div>
      </div>
    </div>
  )
}

export function ThemeStep({ phone }: { phone: boolean }) {
  return (
    <div className="fr-theme">
      <header className="fr-head">
        <h1 className="fr-title fr-display">Pick a theme</h1>
        <p className="fr-lede">Every theme has a light and a dark mode. System follows your computer. You can change all of this later in Settings, Look and feel.</p>
      </header>
      <div className="fr-theme-grid">
        <div className="fr-theme-left">
          <ThemeModeSeg size="md" full={phone} />
          <ThemePicker minWidth={196} />
        </div>
        <div className="fr-theme-right">
          {phone ? null : <WorkspacePreview />}
          <EasierToRead />
        </div>
      </div>
    </div>
  )
}
