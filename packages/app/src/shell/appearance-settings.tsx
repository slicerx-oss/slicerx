// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Look and feel: accent, text and accessibility. Each choice lands in `appearance` (or
// `motion`, `fonts`) in the store; the shell applies them to the root (app.tsx, first-run/look.ts).
import { Icon, Seg, Select, Switch, tipAttrs, type IconName } from '@slicerx/ui'
import { bodyPx, MONO_FONTS, UI_FONTS } from '@slicerx/ui/theme'
import type { ReactNode } from 'react'
import { useEdition } from '../edition'
import type { Appearance } from '../state/prefs'
import { get, set, useApp } from '../state/store'
import './theme-settings.css'

/** Writes one appearance field. */
export function setAppearance<K extends keyof Appearance>(key: K, value: Appearance[K]): void {
  set({ appearance: { ...get().appearance, [key]: value } })
}

/** One settings row: icon, label, one line under it, and the control at the right (under it on phones). */
export function SetRow({ icon, label, detail, children, id }: { icon: IconName; label: string; detail?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <div className="set-seg-row ap-row" data-testid={id}>
      <span className="set-seg-text ap-text">
        <Icon name={icon} className="ap-ic" />
        <span>{label}</span>
        {detail ? <small>{detail}</small> : null}
      </span>
      <span className="ap-ctl">{children}</span>
    </div>
  )
}

const ACCENTS: { value: Appearance['accent']; label: string; color: string }[] = [
  { value: 'theme', label: 'Theme default', color: 'conic-gradient(var(--purple) 0 50%, var(--pink) 0)' },
  { value: 'blue', label: 'Blue', color: 'var(--blue)' },
  { value: 'cyan', label: 'Cyan', color: 'var(--cyan)' },
  { value: 'green', label: 'Green', color: 'var(--green)' },
  { value: 'pink', label: 'Pink', color: 'var(--pink)' },
  { value: 'orange', label: 'Orange', color: 'var(--orange)' },
]

export function AccentGroup() {
  const accent = useApp((s) => s.appearance.accent)
  return (
    <div className="set-group">
      <h4>Accent</h4>
      <SetRow icon="color-painting" label="Accent color" detail="Selection, focus and the main button. Theme default uses the theme's own." id="set-accent">
        <span className="ap-swatches" role="radiogroup" aria-label="Accent color">
          {ACCENTS.map((a) => (
            <button key={a.value} type="button" role="radio" aria-checked={accent === a.value} aria-label={a.label} className="ap-swatch" data-on={accent === a.value ? '' : undefined} style={{ background: a.color }} onClick={() => setAppearance('accent', a.value)} {...tipAttrs({ title: a.label })} />
          ))}
        </span>
      </SetRow>
    </div>
  )
}

export function TextSizeSeg({ full, short }: { full?: boolean; short?: boolean }) {
  const size = useApp((s) => s.appearance.textSize)
  const options: { value: Appearance['textSize']; label: string }[] = [
    ...(short ? [] : [{ value: 'small' as const, label: 'Small' }]),
    { value: 'default', label: 'Default' },
    { value: 'large', label: 'Large' },
    { value: 'larger', label: 'Larger' },
  ]
  return <Seg label="Text size" size="sm" full={Boolean(full)} value={size} onChange={(v) => setAppearance('textSize', v)} options={options} />
}

export function ColorVisionSeg({ full }: { full?: boolean }) {
  const v = useApp((s) => s.appearance.colorVision)
  return (
    <Seg
      label="Color vision"
      size="sm"
      full={Boolean(full)}
      value={v}
      onChange={(x) => setAppearance('colorVision', x)}
      options={[
        { value: 'standard', label: 'Standard' },
        { value: 'redgreen', label: 'Red-green' },
        { value: 'blueyellow', label: 'Blue-yellow' },
      ]}
    />
  )
}

export function TextGroup() {
  const a = useApp((s) => s.appearance)
  const fonts = useApp((s) => s.fonts)
  return (
    <div className="set-group">
      <h4>Text</h4>
      <SetRow icon="text" label="Text size" detail={`Body text at ${bodyPx(a.textSize)} px. Every type size scales with it.`} id="set-text-size">
        <TextSizeSeg />
      </SetRow>
      <SetRow icon="text" label="Font weight" detail="Body text weight. Labels and titles step up from it." id="set-font-weight">
        <Seg
          label="Font weight"
          size="sm"
          value={a.fontWeight}
          onChange={(v) => setAppearance('fontWeight', v)}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'regular', label: 'Regular' },
            { value: 'medium', label: 'Medium' },
            { value: 'bold', label: 'Bold' },
          ]}
        />
      </SetRow>
      <SetRow icon="text" label="Interface font" detail="Theme default uses Hanken Grotesk.">
        <Select id="set-font-ui" size="sm" aria-label="Interface font" value={fonts.ui} onChange={(e) => set({ fonts: { ...get().fonts, ui: e.target.value } })}>
          <option value="theme">Theme default</option>
          {UI_FONTS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </Select>
      </SetRow>
      <SetRow icon="cost" label="Numbers and code" detail="Setting values, times and G-code.">
        <Select id="set-font-mono" size="sm" aria-label="Numbers and code font" value={fonts.mono} onChange={(e) => set({ fonts: { ...get().fonts, mono: e.target.value } })}>
          <option value="theme">Theme default</option>
          {MONO_FONTS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </Select>
      </SetRow>
    </div>
  )
}

/** Status chips and toolpath colors in the palette that applies now, so the choice can be judged at once. */
export function ColorVisionDemo() {
  return (
    <span className="ap-demo" aria-hidden="true">
      <span className="ap-pill" data-tone="ok">
        <Icon name="check" size={12} />
        Ready
      </span>
      <span className="ap-pill" data-tone="info">
        <Icon name="printer" size={12} />
        Printing
      </span>
      <span className="ap-pill" data-tone="warn">
        <Icon name="warning" size={12} />
        Overhang
      </span>
      <span className="ap-pill" data-tone="err">
        <Icon name="close" size={12} />
        Failed
      </span>
    </span>
  )
}

export function useMotionChoice(): 'system' | 'full' | 'reduced' {
  const edition = useEdition()
  return useApp((s) => s.motion) ?? edition.firstRun.defaultMotion ?? 'full'
}

export function AccessibilityGroup() {
  const a = useApp((s) => s.appearance)
  const motion = useMotionChoice()
  return (
    <div className="set-group">
      <h4>Accessibility</h4>
      <SetRow icon="contrast" label="Contrast" detail="Higher lifts secondary text to 7:1 and draws borders stronger, in any theme." id="set-contrast">
        <Seg
          label="Contrast"
          size="sm"
          value={a.contrast}
          onChange={(v) => setAppearance('contrast', v)}
          options={[
            { value: 'standard', label: 'Standard' },
            { value: 'higher', label: 'Higher' },
          ]}
        />
      </SetRow>
      <SetRow icon="show" label="Color vision" detail="Status colors, warnings, toolpaths and the legend switch to colors that stay apart. Each status also has an icon." id="set-color-vision">
        <ColorVisionSeg />
      </SetRow>
      <ColorVisionDemo />
      <div {...tipAttrs({ title: 'Motion', body: "Follow system uses your computer's reduce motion setting. Remote Desktop often turns it on. On keeps the animations either way; Reduced stills them." })}>
        <SetRow icon="speed" label="Motion" detail="Follow system uses your computer's reduce motion setting.">
          <Seg
            label="Motion"
            size="sm"
            value={motion}
            onChange={(v) => set({ motion: v })}
            options={[
              { value: 'system', label: 'Follow system' },
              { value: 'full', label: 'On' },
              { value: 'reduced', label: 'Reduced' },
            ]}
          />
        </SetRow>
      </div>
      <SetRow icon="list" label="Density" detail="Spacing in panels and lists. Controls keep their size." id="set-density">
        <Seg
          label="Density"
          size="sm"
          value={a.density}
          onChange={(v) => setAppearance('density', v)}
          options={[
            { value: 'compact', label: 'Compact' },
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'roomy', label: 'Roomy' },
          ]}
        />
      </SetRow>
    </div>
  )
}

/** The three quick reading options of the first-run theme step. */
export function EasierToRead() {
  const motion = useMotionChoice()
  return (
    <section className="ap-easy" aria-labelledby="ap-easy-h">
      <h3 id="ap-easy-h">
        <Icon name="show" />
        Easier to read
      </h3>
      <div className="ap-easy-row">
        <span>Text size</span>
        <TextSizeSeg full short />
      </div>
      <div className="ap-easy-row">
        <span>Color vision</span>
        <ColorVisionSeg full />
      </div>
      <label className="ap-easy-inline" htmlFor="fr-reduce-motion">
        <span>Reduce motion</span>
        <Switch id="fr-reduce-motion" checked={motion === 'reduced'} onChange={(on) => set({ motion: on ? 'reduced' : 'system' })} />
      </label>
      <p className="sx-muted sx-small">Font weight, contrast, accent and density are in Settings, Look and feel.</p>
    </section>
  )
}
