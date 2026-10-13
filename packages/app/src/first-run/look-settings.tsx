// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Look and feel: the controls preset, theme, accent, text, accessibility, the workspace
// the first tab opens in, hints and the ways back into setup. Settings > Slicing and modeling: auto
// slice, the electricity price and the drawing tools.
import { LOOK_OPTIONS } from '@slicerx/contracts'
import { Button, Seg, Select, SwitchRow } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { editionHasCad, useEdition } from '../edition'
import { formatShortcut } from '../lib/keys'
import { AccentGroup, AccessibilityGroup, SetRow, TextGroup } from '../shell/appearance-settings'
import { AUTO_SLICE_DETAIL, AUTO_SLICE_MODES, autoSliceFields, autoSliceMode } from '../state/auto-slice-mode'
import { MULTI_BODY_DETAIL, MULTI_BODY_MODES } from '../state/multi-body'
import { ThemeSettingsSection } from '../shell/theme-settings'
import { hostSlices } from '../state/model-mode'
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
  // a host that cannot slice has no slicer look, printers or Slice tab to choose
  const slices = hostSlices()
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
      {slices ? (
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
      ) : null}
      <ThemeSettingsSection />
      <AccentGroup />
      <TextGroup />
      <AccessibilityGroup />
      {modeling && slices ? (
        <div className="set-group">
          <h4>Workspace</h4>
          <div className="set-seg-row">
            <span className="set-seg-text">
              <span>Open models in</span>
              <small>The tab the plate opens in. {formatShortcut('Mod+E')} switches any time.</small>
            </span>
            <Seg
              size="sm"
              label="Open models in"
              value={openIn}
              onChange={(v) => set({ modelModeDefault: v })}
              options={[
                { value: 'slice', label: 'Slicing' },
                { value: 'design', label: 'Model' },
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
          {slices ? (
            <Button variant="ghost" icon="printer" onClick={() => go(() => openSetup('printer'))}>
              Add a printer with guided setup
            </Button>
          ) : null}
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
  const mode = useApp(autoSliceMode)
  const bodies = useApp((s) => s.multiBodyImport)
  const slices = hostSlices()
  const modeling = editionHasCad(useEdition()) || !slices
  const multiBody = (
    <SetRow id="set-multibody" icon="split" label="Files with several bodies" detail={MULTI_BODY_DETAIL}>
      <Seg label="Files with several bodies" size="sm" value={bodies} onChange={(v) => set({ multiBodyImport: v })} options={MULTI_BODY_MODES.map((m) => ({ value: m.value, label: m.label, title: m.title, testId: `set-multibody-${m.value}` }))} />
    </SetRow>
  )
  return (
    <section className="set-sec" aria-labelledby="slicing-h">
      <h3 id="slicing-h" className="sr-only">{slices ? 'Slicing and modeling' : 'Modeling'}</h3>
      {slices ? (
        <>
          <div className="set-group">
            <h4>Slicing</h4>
            <SetRow id="set-autoslice" icon="slice" label="Auto slice" detail={AUTO_SLICE_DETAIL}>
              <Seg label="Auto slice" size="sm" value={mode} onChange={(v) => set(autoSliceFields(v))} options={AUTO_SLICE_MODES.map((m) => ({ value: m.value, label: m.label, title: m.title, testId: `set-autoslice-${m.value}` }))} />
            </SetRow>
            {multiBody}
          </div>
          <ElectricityFields />
        </>
      ) : (
        <div className="set-group">
          <h4>Import</h4>
          {multiBody}
        </div>
      )}
      <div className="set-group">
        <h4>Modeling</h4>
        <SwitchRow id="set-cad" icon="shapes" label="Drawing tools" detail={modeling ? 'Draw a shape or text on a face or the bed and extrude it, add basic shapes, subtract a shape. Measure, arrays, repair and simplify are always on.' : 'Add basic shapes and subtract a shape. Measure, arrays, repair and simplify are always on.'} checked={cad} onChange={(v) => set({ cadTools: v })} />
        <UnitRows />
      </div>
    </section>
  )
}

const PRECISION_MM = [0, 1, 2, 3].map((d) => ({ value: `d${d}`, label: d ? (0).toFixed(d) : '0' }))
const PRECISION_IN = [...[2, 3, 4].map((d) => ({ value: `d${d}`, label: (0).toFixed(d) })), ...[16, 32, 64].map((f) => ({ value: `f${f}`, label: `1/${f}` }))]

/** Display units for lengths in Model, and how precisely they show. Data stays in mm; Slice stays in mm. */
function UnitRows() {
  const u = useApp((s) => s.units)
  const inches = u.length === 'in'
  const precision = inches ? (u.inchFraction ? `f${u.inchFraction}` : `d${u.inchDigits}`) : `d${u.mmDigits}`
  const setPrecision = (v: string) => {
    const n = Number(v.slice(1))
    set({ units: { ...u, ...(inches ? (v[0] === 'f' ? { inchFraction: n } : { inchDigits: n, inchFraction: 0 }) : { mmDigits: n }) } })
  }
  return (
    <>
      <SetRow id="set-units" icon="ruler" label="Display units" detail="Lengths in Model show in this unit. A typed unit always works, such as 25.4mm, 1in, 1&quot; or 3/8 in. Files and print settings stay in mm.">
        <Seg label="Display units" size="sm" value={u.length} onChange={(v) => set({ units: { ...u, length: v } })} options={[{ value: 'mm', label: 'mm', title: 'Millimeters', testId: 'set-units-mm' }, { value: 'in', label: 'in', title: 'Inches', testId: 'set-units-in' }]} />
      </SetRow>
      <SetRow id="set-precision" icon="tolerance" label="Precision" detail="Decimals shown, or in inches a fraction to the nearest 1/16, 1/32 or 1/64.">
        {/* a select, not a segment: the inch choices outnumber the mm ones, and a switch of unit must not move the rows below */}
        <Select id="set-precision-pick" className="set-precision" size="sm" aria-label="Precision" data-testid="set-precision-pick" value={precision} onChange={(e) => setPrecision(e.target.value)}>
          {(inches ? PRECISION_IN : PRECISION_MM).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </SetRow>
    </>
  )
}
