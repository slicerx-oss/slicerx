// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Advanced and Expert tiers (packages/settings/docs/tiers.md). Advanced lists 82 process keys
// grouped by what they are for; Expert keeps those groups and puts the other 291 behind search,
// with a "more" link per group. Edits are plate overrides on top of Easy mode; saved profiles are
// never written from here.
import type { SettingDef, SettingIntent, SettingValue } from '@slicerx/contracts'
import { EASY_MAP } from '@slicerx/settings'
import { Icon, LinkButton, Seg, Switch, tipAttrs, type IconName } from '@slicerx/ui'
import { useDeferredValue, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { PrimeTowerRow } from './prime-tower-row'
import './settings-tabs.css'
import { formatValue, isVisible, resolveConfig, SETTINGS } from '../../adapters/settings'
import { presetOwnValue } from '../../adapters/config'
import { useFilamentCount } from '../../filament/count'
import { fuzzyScore } from '../../commands/fuzzy'
import { effectiveMode, useLayout } from '../../first-run/look'
import { OPTION_TIPS, settingTipAttrs } from '../../lib/tips'
import { setPlateSettings } from '../../plate/plates'
import { plateSequence } from '../../plate/plate-sequence'
import { get, markStale, set, useApp, type PlateMeta, type SettingsMode } from '../../state/store'
import { appName } from '../../edition'

export const EDITABLE = new Set(['float', 'int', 'percent', 'bool', 'enum', 'floats', 'ints', 'percents', 'floatOrPercent'])

/** The intents in the order the panel shows them. Output (G-code and file keys) is Expert only. */
export const INTENTS: readonly { id: SettingIntent; label: string; icon: IconName; blurb: string }[] = [
  { id: 'quality', label: 'Quality', icon: 'tab-quality', blurb: 'Surfaces, walls, seams and dimensional accuracy' },
  { id: 'strength', label: 'Strength', icon: 'tab-strength', blurb: 'Shells and infill' },
  { id: 'speed', label: 'Speed', icon: 'tab-speed', blurb: 'How fast each feature prints' },
  { id: 'supports', label: 'Supports', icon: 'support', blurb: 'Where supports go and how they touch the part' },
  { id: 'adhesion', label: 'Adhesion', icon: 'tab-adhesion', blurb: 'Brim, skirt and raft' },
  { id: 'multicolor', label: 'Color', icon: 'tab-color', blurb: 'Prime tower, flushing and which filament prints what' },
  { id: 'effects', label: 'Surface', icon: 'tab-surface', blurb: 'Ironing, fuzzy skin and spiral vase' },
  { id: 'output', label: 'Output and print order', icon: 'tab-output', blurb: 'Print order, G-code and file options' },
]

/** Units as a person reads them; a temperature difference is still in degrees Celsius. */
const UNIT_TEXT: Readonly<Record<string, string>> = { C: '°C', 'delta-C': '°C', deg: '°', mm3: 'mm³', 'mm3/s': 'mm³/s', 'mm/s2': 'mm/s²' }

/** Settings the prime tower row's atlas line sets: they are not listed as rows. */
const ATLAS_KEYS = new Set(['prime_tower_auto_position', 'wipe_tower_x', 'wipe_tower_y'])

/** A switch setting's value as on or off: engine values come as booleans, numbers or strings. */
function on(v: SettingValue | undefined): boolean {
  const x = Array.isArray(v) ? v[0] : v
  return x === true || x === 1 || x === '1' || x === 'true'
}

function setOverride(key: string, value: SettingValue | undefined): void {
  set((s) => {
    const next = { ...s.overrides }
    if (value === undefined) delete next[key]
    else next[key] = value
    return { overrides: next }
  })
  markStale()
}

/** Keys where 0 means "automatic" accept an empty field or "auto" as 0. */
function isAuto(def: SettingDef, v: SettingValue | undefined): boolean {
  return def.auto === true && (v === 0 || v === '0')
}

function parseInput(def: SettingDef, raw: string): SettingValue | undefined {
  const text = raw.trim()
  if (def.auto && (text === '' || /^auto$/i.test(text) || text === '0')) return def.type === 'floatOrPercent' ? '0' : 0
  if (def.type === 'floatOrPercent') return /^\d+(\.\d+)?%?$/.test(text) ? text : undefined
  const n = Number(text)
  if (text === '' || !Number.isFinite(n)) return undefined
  const lo = def.orcaMin ?? def.min ?? -Infinity
  const hi = def.orcaMax ?? def.max ?? Infinity
  const v = Math.min(hi, Math.max(lo, def.type === 'int' || def.type === 'ints' ? Math.round(n) : n))
  return def.type.endsWith('s') ? [v] : v
}

/** The enum values a picker offers. Values the engine cannot print yet are left out; one the setting already holds (an imported project) stays, flagged. */
export function offeredValues(def: Pick<SettingDef, 'enumValues' | 'enumLabels' | 'unavailableValues'>, current: unknown): { value: string; label: string; gone: boolean }[] {
  const out: { value: string; label: string; gone: boolean }[] = []
  ;(def.enumValues ?? []).forEach((v, i) => {
    const gone = def.unavailableValues?.includes(v) ?? false
    if (gone && v !== String(current ?? '')) return
    out.push({ value: v, label: def.enumLabels?.[i] ?? v, gone })
  })
  return out
}

function optionTipAttrs(key: string, value: unknown): Record<string, string> {
  const tip = OPTION_TIPS[`${key}.${String(value ?? '')}`]
  return tip ? { 'data-tip-title': tip.title, 'data-tip-body': tip.body } : {}
}

/** Named marks for the values that carry one: aegis in the wall generator, shown as a segmented picker. */
const MARKED: Record<string, Partial<Record<string, IconName>>> = { wall_generator: { aegis: 'aegis' } }

export function Field({ def, value, overridden, onSet = setOverride, idPrefix = 'set', note }: { def: SettingDef; value: SettingValue | undefined; overridden: boolean; onSet?: (key: string, value: SettingValue | undefined) => void; idPrefix?: string; note?: ReactNode }) {
  const id = `${idPrefix}-${def.key}`
  const setOverride = onSet
  // The setting's key shows under its label in developer mode only; the row's tooltip carries the note.
  const showKey = useApp((s) => s.settingsMode === 'developer')
  const scalar = Array.isArray(value) ? value[0] : value
  const marks = MARKED[def.key]
  const own = presetOwnValue(def.key)
  let control
  if (def.type === 'bool') {
    control = <Switch id={id} checked={value === true} onChange={(v) => setOverride(def.key, v)} />
  } else if (def.type === 'enum' && marks) {
    const options = offeredValues(def, scalar).map(({ value: v, label }) => {
      const icon = marks[v]
      const tip = OPTION_TIPS[`${def.key}.${v}`]
      return { value: v, label: icon ? <span className="seg-mark"><Icon name={icon} size={15} />{label}</span> : label, ...(tip ? { title: tip.body } : {}) }
    })
    control = <Seg label={def.label ?? def.key} size="sm" value={String(scalar ?? '')} options={options} onChange={(v) => setOverride(def.key, v)} className="tier-seg" />
  } else if (def.type === 'enum') {
    control = (
      <select id={id} className="mini" value={String(scalar ?? '')} {...optionTipAttrs(def.key, scalar)} onChange={(e) => setOverride(def.key, e.currentTarget.value)}>
        {offeredValues(def, scalar).map(({ value: v, label, gone }) => (
          <option key={v} value={v}>
            {label}
            {gone ? ' (not supported yet, prints with the default)' : ''}
          </option>
        ))}
      </select>
    )
  } else {
    control = (
      <span className="num">
        <input
          id={id}
          key={String(scalar)}
          className="mini sx-mono"
          inputMode="decimal"
          placeholder={def.auto ? 'Auto' : undefined}
          defaultValue={isAuto(def, scalar) ? '' : String(scalar ?? '')}
          onBlur={(e) => {
            const shown = isAuto(def, scalar) ? '' : String(scalar ?? '')
            if (e.currentTarget.value === shown) return
            const v = parseInput(def, e.currentTarget.value)
            if (v !== undefined) setOverride(def.key, v)
            else e.currentTarget.value = shown
          }}
          onFocus={(e) => e.currentTarget.select()}
          onMouseUp={(e) => {
            // The click that focuses the field would drop the selection again.
            if (e.currentTarget.dataset.sel === '1') e.preventDefault()
            delete e.currentTarget.dataset.sel
          }}
          onMouseDown={(e) => {
            if (document.activeElement !== e.currentTarget) e.currentTarget.dataset.sel = '1'
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span className="unit">{def.unit && def.unit !== '%' ? (UNIT_TEXT[def.unit] ?? def.unit) : def.type === 'percent' ? '%' : ''}</span>
      </span>
    )
  }
  return (
    <li className={overridden ? 'field changed' : 'field'} data-wide={marks ? true : undefined} {...settingTipAttrs(def.key)}>
      <label htmlFor={id}>
        {def.label}
        {showKey ? <span className="key">{def.key}</span> : null}
      </label>
      {control}
      {!overridden && own !== null ? (
        <p className="sx-small sx-muted slicerx-default" style={{ gridColumn: '1 / -1', margin: 0 }}>
          {appName()} default. This printer's preset says {String(Array.isArray(own) ? own[0] : own)}.{' '}
          <LinkButton onClick={() => setOverride(def.key, own)}>Use this preset's own ({String(Array.isArray(own) ? own[0] : own)})</LinkButton>
        </p>
      ) : null}
      {note ? (
        <p className="sx-small sx-muted plate-own" style={{ gridColumn: '1 / -1', margin: 0 }}>
          {note}
        </p>
      ) : null}
      {overridden ? (
        <button type="button" className="reset" onClick={() => setOverride(def.key, undefined)} aria-label={`Reset ${def.label}`} {...tipAttrs({ title: 'Reset', body: 'Go back to the Easy value.' })}>
          <Icon name="rotate" />
        </button>
      ) : (
        <span className="reset" aria-hidden="true" />
      )}
    </li>
  )
}

const SEQUENCE_WORDS = { 'by-layer': 'by layer', 'by-object': 'by object' } as const

/**
 * Print sequence in the panel and the plate's own sequence are one value for the plate shown: a change here also
 * drops the plate's own choice, so the plate follows it.
 */
function setSequence(key: string, value: SettingValue | undefined): void {
  setOverride(key, value)
  const s = get()
  const meta = s.plates.find((p) => p.id === s.activePlate)
  if (meta?.settings.sequence) {
    const { sequence: _drop, ...rest } = meta.settings
    setPlateSettings(meta.id, rest, true)
  }
}

/** Says when the plate shown prints in another sequence than Print sequence here, and offers to follow it. */
function plateSequenceNote(meta: PlateMeta | undefined, config: Record<string, SettingValue>): ReactNode {
  const own = meta?.settings.sequence
  const global = plateSequence(undefined, config)
  if (!meta || !own || own === global) return null
  const { sequence: _drop, ...rest } = meta.settings
  return (
    <>
      {meta.name} prints {SEQUENCE_WORDS[own]}, set in its plate settings, and that wins over this setting.{' '}
      <LinkButton onClick={() => setPlateSettings(meta.id, rest, true)}>Print {meta.name} {SEQUENCE_WORDS[global]}</LinkButton>
    </>
  )
}

/** The two Advanced choices from easy-map.json that set several keys at once (overhang slowdown, unsupported overhangs). */
function ChoiceRow({ name, config, overrides }: { name: string; config: Record<string, SettingValue>; overrides: Record<string, SettingValue> }) {
  const showKey = useApp((s) => s.settingsMode === 'developer')
  const choice = EASY_MAP.choices[name]
  if (!choice) return null
  const first = (v: SettingValue | undefined) => (Array.isArray(v) ? v[0] : v)
  const current = Object.entries(choice.values).find(([, keys]) => Object.entries(keys).every(([k, v]) => String(first(config[k]) ?? '') === String(v)))?.[0] ?? ''
  const options = Object.keys(choice.values).map((v) => ({ value: v, label: choice.labels[v] ?? v, title: choice.hints[v] ?? '' }))
  const pick = (v: string) => {
    const keys = choice.values[v] ?? {}
    set((s) => {
      const next = { ...s.overrides }
      for (const [k, val] of Object.entries(keys)) {
        const was = s.overrides[k] ?? config[k]
        next[k] = Array.isArray(was) ? [val as never] : (val as SettingValue)
      }
      return { overrides: next }
    })
    markStale()
  }
  const touched = Object.values(choice.values).some((keys) => Object.keys(keys).some((k) => k in overrides))
  return (
    <li className={touched ? 'field changed' : 'field'} data-wide>
      <label {...tipAttrs({ title: choice.label, body: Object.values(choice.hints).join(' ') })}>
        {choice.label}
        {showKey ? <span className="key">{Object.keys(Object.values(choice.values)[0] ?? {}).join(', ')}</span> : null}
      </label>
      <Seg label={choice.label} size="sm" value={current} options={options} onChange={pick} className="tier-seg" />
      <span className="reset" aria-hidden="true" />
    </li>
  )
}

/**
 * Schema levels shown for an app settings mode: Simple shows simple, Advanced adds advanced, Expert adds expert
 * and Developer adds develop.
 */
export function visibleLevels(mode: SettingsMode, _layout?: unknown): ReadonlySet<SettingDef['mode']> {
  if (mode === 'developer') return new Set(['simple', 'advanced', 'expert', 'develop'])
  if (mode === 'expert') return new Set(['simple', 'advanced', 'expert'])
  if (mode === 'advanced') return new Set(['simple', 'advanced'])
  return new Set(['simple'])
}

interface Group {
  intent: (typeof INTENTS)[number]
  /** Advanced keys, always listed. */
  shown: SettingDef[]
  /** Expert keys of this intent, listed when the group is opened or a search matches. */
  more: SettingDef[]
}

export function ExpertSettings() {
  const easy = useApp((s) => s.easy)
  const overrides = useApp((s) => s.overrides)
  const [query, setQuery] = useState('')
  const [opened, setOpened] = useState<Set<SettingIntent>>(new Set())
  // The command bar can send someone to a setting: search for it and bring it into view.
  const focus = useApp((s) => s.settingFocus)
  useEffect(() => {
    if (!focus || !SETTINGS.some((d) => d.key === focus.key && d.section === 'process')) return
    setQuery(focus.label)
    const t = window.setTimeout(() => {
      document.getElementById(`set-${focus.key}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      document.getElementById(`set-${focus.key}`)?.focus({ preventScroll: true })
      set({ settingFocus: null })
    }, 150)
    return () => window.clearTimeout(t)
  }, [focus])
  const layout = useLayout()
  const mode = effectiveMode(useApp((s) => s.settingsMode), layout)
  const expert = mode === 'expert' || mode === 'developer'
  const levels = useMemo(() => visibleLevels(mode), [mode])
  const q = useDeferredValue(query.trim())
  const filamentCount = useFilamentCount()
  const config = useMemo(() => resolveConfig(easy, overrides), [easy, overrides])
  const activeMeta = useApp((s) => s.plates.find((p) => p.id === s.activePlate))
  const seqNote = plateSequenceNote(activeMeta, config)
  const field = (def: SettingDef) =>
    // The prime tower is one switch with atlas's placement under it (prime-tower-row.tsx).
    def.key === 'enable_prime_tower' ? (
      <PrimeTowerRow key={def.key} enabled={on(config[def.key])} onEnable={(v) => setOverride(def.key, v)} />
    ) : def.key === 'print_sequence' ? (
      <Field key={def.key} def={def} value={config[def.key]} overridden={def.key in overrides} onSet={setSequence} note={seqNote} />
    ) : (
      <Field key={def.key} def={def} value={config[def.key]} overridden={def.key in overrides} />
    )
  const editable = useMemo(() => SETTINGS.filter((d) => EDITABLE.has(d.type) && d.section === 'process'), [])
  const matches = (def: SettingDef) => !q || fuzzyScore(q, def.label) >= 0 || fuzzyScore(q, def.key) >= 0
  const groups = useMemo((): Group[] => {
    const out: Group[] = INTENTS.map((intent) => ({ intent, shown: [], more: [] }))
    for (const def of editable) {
      const changed = def.key in overrides
      // Profile keys show nowhere, and multi-color keys only with two or more filaments (a key the person already changed stays listed).
      if (!changed && !isVisible(def, { filamentCount })) continue
      // The tower's place is atlas's, under the Prime tower switch (prime-tower-row.tsx), not a row of its own.
      if (ATLAS_KEYS.has(def.key)) continue
      // Print sequence (all together or one object at a time) is print order: it heads Output, not Surface.
      const intent = def.key === 'print_sequence' ? 'output' : def.intent
      const g = out.find((x) => x.intent.id === intent)
      if (!g) continue
      if (def.key === 'print_sequence' && (def.mode === 'simple' || def.mode === 'advanced' || (expert && levels.has(def.mode)))) {
        g.shown.push(def)
        continue
      }
      // Simple keys are the Easy controls above; they are listed once changed by hand, or when a search asks for them
      // (the command palette jumps here with the setting's name as the search).
      if (def.mode === 'simple' && !changed && !q) continue
      if (def.mode === 'advanced' || def.mode === 'simple') g.shown.push(def)
      else if (expert && levels.has(def.mode)) g.more.push(def)
    }
    // The prime tower switch heads the Color tab, with atlas's placement under it, and print sequence heads Output.
    for (const g of out) {
      for (const key of ['enable_prime_tower', 'print_sequence']) {
        const i = g.shown.findIndex((d) => d.key === key)
        if (i > 0) g.shown.unshift(...g.shown.splice(i, 1))
      }
    }
    return out
  }, [editable, overrides, filamentCount, expert, levels, q])
  const visible = groups
    .map((g) => {
      const open = Boolean(q) || opened.has(g.intent.id)
      const shown = g.shown.filter(matches)
      const more = (open ? g.more : g.more.filter((d) => d.key in overrides)).filter(matches)
      return { ...g, open, shown, more, hidden: open ? 0 : g.more.length - g.more.filter((d) => d.key in overrides).length }
    })
    .filter((g) => g.shown.length || g.more.length || (!q && g.hidden))
  const count = visible.reduce((n, g) => n + g.shown.length + g.more.length, 0)
  // The tabs: one per group, Color only with two or more filaments. A search looks through every tab.
  const tabs = INTENTS.filter((i) => i.id !== 'multicolor' || filamentCount >= 2)
  const stored = useApp((s) => s.settingsTab)
  const tab = tabs.some((t) => t.id === stored) ? stored : 'quality'
  const shownGroups = q ? visible : visible.filter((g) => g.intent.id === tab)
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const by = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : by ? (i + by + tabs.length) % tabs.length : -1
    if (to < 0) return
    e.preventDefault()
    const next = tabs[to]!
    set({ settingsTab: next.id })
    document.getElementById(`set-tab-${next.id}`)?.focus()
  }
  const toggle = (id: SettingIntent) =>
    setOpened((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return (
    <div id="expert-panel" className="expert tiers" data-mode={mode}>
      <div className="search-in">
        <Icon name="search" />
        <label className="sr-only" htmlFor="expert-search">
          Search settings
        </label>
        <input id="expert-search" className="bare" placeholder={expert ? `Search all ${editable.length} process settings` : `Search ${groups.reduce((n, g) => n + g.shown.length, 0)} advanced settings`} value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
      </div>
      <div className="set-tabs" role="tablist" aria-label="Setting groups">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`set-tab-${t.id}`}
            data-testid={`slice-settings-tab-${t.id}`}
            className="set-tab"
            data-tab={t.id}
            aria-selected={!q && t.id === tab}
            aria-controls="set-tab-panel"
            aria-label={t.label}
            tabIndex={t.id === tab ? 0 : -1}
            {...tipAttrs({ title: t.label, body: t.blurb })}
            onClick={() => {
              setQuery('')
              set({ settingsTab: t.id })
            }}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            <Icon name={t.icon} size={18} />
          </button>
        ))}
      </div>
      {/* The open tab names itself in its heading; a search says how many it found across the tabs. */}
      {q ? (
        <div className="expert-opts">
          <span className="sx-mono sx-small sx-dim">{count} found</span>
          <span className="sx-small sx-muted">{expert ? 'In every tab, the expert settings too.' : 'In every tab. Expert adds the rest.'}</span>
        </div>
      ) : null}
      {q && visible.length === 0 ? <p className="sx-muted sx-small">No setting matches "{query}"</p> : null}
      <div id="set-tab-panel" role="tabpanel" aria-labelledby={q ? undefined : `set-tab-${tab}`} aria-label={q ? 'Search results' : undefined}>
      {shownGroups.map((g) => (
        <section key={g.intent.id} className="expert-group tier-group" data-intent={g.intent.id} aria-label={g.intent.label}>
          <h4>
            <span className="tier-h">
              <Icon name={g.intent.icon} size={14} />
              {g.intent.label}
            </span>
            <span className="sx-mono">{g.shown.length + g.more.length}</span>
          </h4>
          {!q ? <p className="tier-blurb">{g.intent.blurb}</p> : null}
          <ul>
            {g.intent.id === 'quality' && !q ? (
              <>
                <ChoiceRow name="overhangSlowdown" config={config} overrides={overrides} />
                <ChoiceRow name="unsupportedOverhangs" config={config} overrides={overrides} />
              </>
            ) : null}
            {g.shown.map(field)}
            {g.more.length && g.shown.length ? <li className="tier-divider" aria-hidden="true">Expert</li> : null}
            {g.more.map(field)}
          </ul>
          {expert && !q && g.hidden + (g.open ? g.more.length : 0) > 0 ? (
            <button type="button" className="tier-more" aria-expanded={g.open} onClick={() => toggle(g.intent.id)}>
              <Icon name={g.open ? 'chevron-up' : 'chevron-down'} size={14} />
              {g.open ? 'Fewer' : `${g.hidden} more`}
            </button>
          ) : null}
        </section>
      ))}
      </div>
      {/* Print sequence is an Expert row; below Expert the note still shows when the plate prints otherwise. */}
      {!expert && seqNote ? <p className="app-note">{seqNote}</p> : null}
      <p className="app-note">Changes apply to this plate. Saved profiles stay as they are. {Object.keys(overrides).length ? `${Object.keys(overrides).length} changed: ${Object.keys(overrides).slice(0, 3).map((k) => { const d = SETTINGS.find((x) => x.key === k); return `${d?.label ?? k} ${formatValue(d, config[k])}` }).join(', ')}` : ''}</p>
    </div>
  )
}
