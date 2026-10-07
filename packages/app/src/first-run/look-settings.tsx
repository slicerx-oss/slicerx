// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Look and feel: the controls preset, theme, accent, text, accessibility, the workspace
// the first tab opens in, hints and the ways back into setup. Settings > Slicing and modeling: auto
// slice, the electricity price and the drawing tools.
import { LOOK_OPTIONS } from '@slicerx/contracts'
import { Button, Seg, SwitchRow } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { editionHasCad, useEdition } from '../edition'
import { formatShortcut } from '../lib/keys'
import { AccentGroup, AccessibilityGroup, TextGroup } from '../shell/appearance-settings'
import { ThemeSettingsSection } from '../shell/theme-settings'
import { get, set, useApp } from '../state/store'
import { openSetup, resumeSetup, useLookChoice } from './look'

/** The price of a kWh and its currency symbol, for the Electricity row of the estimate. Typing is kept as text until it is a valid price. */
function ElectricityFields() {
  const { pricePerKwh, symbol } = useApp((s) => s.electricity)
  const [text, setText] = useState(String(pricePerKwh))
  const [sym, setSym] = useState(symbol)
  useEffect(() => setText((t) => (Number(t) === pricePerKwh ? t : String(pricePerKwh))), [pricePerKwh])
  const commit = (next: Partial<{ pricePerKwh: number; symbol: string }>) => set({ electricity: { ...get().electricity, ...next } })
  return (
    <div className="set-group">
      <h4>Electricity</h4>
      <label className="plate-form-row" htmlFor="set-kwh">
        <span>Price per kWh</span>
        <input id="set-kwh" className="sx-input" type="number" inputMode="decimal" min={0} max={5} step={0.01} value={text} onChange={(e) => {
          setText(e.target.value)
          const n = Number(e.target.value)
          if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 5) commit({ pricePerKwh: n })
        }} />
      </label>
      <label className="plate-form-row" htmlFor="set-currency">
        <span>Currency symbol</span>
        <input id="set-currency" className="sx-input" maxLength={4} value={sym} onChange={(e) => {
          setSym(e.target.value)
          if (e.target.value.trim()) commit({ symbol: e.target.value.trim() })
        }} />
      </label>
      <p className="sx-muted sx-small">Used for the electricity cost in the print estimate.</p>
    </div>
  )
}

export function LookSettingsSection() {
  const choice = useLookChoice()
  const firstRun = useApp((s) => s.firstRun)
  const tips = useApp((s) => s.tooltips)
  const modeling = editionHasCad(useEdition())
  // Changing it never moves the session you are in; it applies from the next launch.
  const openIn = useApp((s) => s.modelModeDefault)
  const custom = Boolean(choice.overrides && Object.keys(choice.overrides).length)
  const go = (fn: () => void) => {
    set({ settingsOpen: false, settingsSection: null })
    fn()
  }
  return (
    <section className="set-sec" aria-labelledby="look-h">
      <h3 id="look-h" className="sr-only">Look and feel</h3>
      <div className="set-card">
        <div className="set-card-main">
          <b>{LOOK_OPTIONS[choice.id].label}</b>
          <span className="sx-muted sx-small">
            {custom ? 'With your control changes. ' : ''}
            {LOOK_OPTIONS[choice.id].summary}
          </span>
        </div>
        <Button icon="sliders" onClick={() => go(() => openSetup('look'))}>
          Change
        </Button>
      </div>
      <ThemeSettingsSection />
      <AccentGroup />
      <TextGroup />
      <AccessibilityGroup />
      {modeling ? (
        <div className="set-group">
          <h4>Workspace</h4>
          <div className="set-seg-row">
            <span className="set-seg-text">
              <span>Open models in</span>
              <small>The mode the first tab starts in. {formatShortcut('Mod+E')} switches any time.</small>
            </span>
            <Seg
              size="sm"
              label="Open models in"
              value={openIn}
              onChange={(v) => set({ modelModeDefault: v })}
              options={[
                { value: 'slice', label: 'Slicing' },
                { value: 'design', label: 'CAD design' },
              ]}
            />
          </div>
        </div>
      ) : null}
      <div className="set-group">
        <h4>Help and hints</h4>
        <SwitchRow id="set-tips" icon="help" label="Show feature tooltips" detail="Hover or focus a control to see what it does. Press ? any time to see one." checked={tips.enabled} onChange={(v) => set({ tooltips: { ...get().tooltips, enabled: v } })} />
      </div>
      <div className="set-group">
        <h4>Setup</h4>
        <p className="set-actions">
          <Button variant="ghost" icon="printer" onClick={() => go(() => openSetup('printer'))}>
            Add a printer with guided setup
          </Button>
          <Button variant="ghost" icon="sliders" onClick={() => go(resumeSetup)}>
            {firstRun && !firstRun.completedAt ? 'Finish setup' : 'Run setup again'}
          </Button>
        </p>
      </div>
    </section>
  )
}

export function SlicingSettingsSection() {
  const cad = useApp((s) => s.cadTools)
  const autoSlice = useApp((s) => s.autoSlice)
  const modeling = editionHasCad(useEdition())
  return (
    <section className="set-sec" aria-labelledby="slicing-h">
      <h3 id="slicing-h" className="sr-only">Slicing and modeling</h3>
      <div className="set-group">
        <h4>Slicing</h4>
        <SwitchRow id="set-autoslice" icon="slice" label="Slice automatically" detail="Slices in the background after every edit, so time and filament are always current. Off shows a Slice button and slices only when you press it." checked={autoSlice} onChange={(v) => set({ autoSlice: v })} />
      </div>
      <ElectricityFields />
      <div className="set-group">
        <h4>Modeling</h4>
        <SwitchRow id="set-cad" icon="shapes" label="Drawing tools" detail={modeling ? 'Draw a shape or text on a face or the bed and extrude it, add basic shapes, subtract a shape. Measure, arrays, repair and simplify are always on.' : 'Add basic shapes and subtract a shape. Measure, arrays, repair and simplify are always on.'} checked={cad} onChange={(v) => set({ cadTools: v })} />
      </div>
    </section>
  )
}
