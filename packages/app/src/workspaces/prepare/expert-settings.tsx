// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Advanced and Expert tiers (packages/settings/docs/tiers.md): tabs of named sections that fold to a summary line.
// Advanced lists 42 process keys; Expert adds the rest behind a "more" link per section, and a search reaches every
// one. Edits are plate overrides on top of Easy mode; saved profiles are never written from here.
import type { SettingDef, SettingIntent, SettingValue } from '@slicerx/contracts'
import { EASY_MAP } from '@slicerx/settings'
import { Icon, keepInPlace, LinkButton, Seg, Switch, tipAttrs, type IconName } from '@slicerx/ui'
import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { PrimeTowerRow } from './prime-tower-row'
import './settings-tabs.css'
import { formatValue, resolveConfig, SETTINGS } from '../../adapters/settings'
import { presetOwnValue } from '../../adapters/config'
import { useFilamentCount } from '../../filament/count'
import { fuzzyScore } from '../../commands/fuzzy'
import { effectiveMode, useLayout } from '../../first-run/look'
import { OPTION_TIPS, settingTipAttrs } from '../../lib/tips'
import { variesPerObject } from '../../plate/plate-wide'
import { setPlateSettings } from '../../plate/plates'
import { objectOverrides, sourceId } from '../../plate/object-settings'
import { selectObject } from '../../plate/select'
import { ownKeys, scopeValue, setScoped } from '../../plate/scope'
import { plateSequence } from '../../plate/plate-sequence'
import { get, markStale, set, useApp, type PlateMeta } from '../../state/store'
import { appName } from '../../edition'
import { useScope } from './scope-bar'

import { fixMatch } from './setting-fixes'
import { buildTabs, EDITABLE_PROCESS, offeredTabs, sectionHasRows, sectionOpen, sectionRows, type ViewSection, type ViewTab } from './settings-view'

export { EDITABLE, INTENTS, visibleLevels } from './settings-view'

/** Units as a person reads them; a temperature difference is still in degrees Celsius. */
const UNIT_TEXT: Readonly<Record<string, string>> = { C: '°C', 'delta-C': '°C', deg: '°', mm3: 'mm³', 'mm3/s': 'mm³/s', 'mm/s2': 'mm/s²' }

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

/**
 * A row read through the selection's scope: inherited from the plate, the selection's own, or mixed across it.
 * `locked` says why the setting holds for the whole plate.
 */
export interface FieldScope {
  source: 'own' | 'plate' | 'mixed'
  plateValue: SettingValue | undefined
  locked?: string
}

/** A row's pin: pinned rows also show above the settings tabs. */
export interface FieldPin {
  on: boolean
  toggle: () => void
}

export function Field({ def, value, overridden, onSet = setOverride, idPrefix = 'set', note, scoped, pin, chips }: { def: SettingDef; value: SettingValue | undefined; overridden: boolean; onSet?: (key: string, value: SettingValue | undefined) => void; idPrefix?: string; note?: ReactNode; scoped?: FieldScope; pin?: FieldPin; chips?: ReactNode }) {
  const id = `${idPrefix}-${def.key}`
  const setOverride = onSet
  const mixed = scoped?.source === 'mixed'
  const locked = scoped?.locked
  const lockTip = locked ? { 'data-tip-title': def.label ?? def.key, 'data-tip-reason': locked } : {}
  // The setting's key shows under its label in developer mode only; the row's tooltip carries the note.
  const showKey = useApp((s) => s.settingsMode === 'developer')
  const scalar = Array.isArray(value) ? value[0] : value
  const marks = MARKED[def.key]
  const own = presetOwnValue(def.key)
  let control
  if (def.type === 'bool') {
    control = <Switch id={id} checked={value === true} disabled={Boolean(locked)} onChange={(v) => setOverride(def.key, v)} />
  } else if (def.type === 'enum' && marks) {
    const options = offeredValues(def, scalar).map(({ value: v, label }) => {
      const icon = marks[v]
      const tip = OPTION_TIPS[`${def.key}.${v}`]
      return { value: v, label: icon ? <span className="seg-mark"><Icon name={icon} size={15} />{label}</span> : label, ...(tip ? { title: tip.body } : {}) }
    })
    control = <Seg label={def.label ?? def.key} size="sm" value={String(scalar ?? '')} options={locked ? options.map((o) => ({ ...o, disabled: true })) : options} onChange={(v) => setOverride(def.key, v)} className="tier-seg" />
  } else if (def.type === 'enum') {
    control = (
      <select id={id} className="mini" value={mixed ? '' : String(scalar ?? '')} disabled={Boolean(locked)} {...optionTipAttrs(def.key, scalar)} onChange={(e) => e.currentTarget.value && setOverride(def.key, e.currentTarget.value)}>
        {mixed ? <option value="">Mixed</option> : null}
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
          placeholder={mixed ? 'Mixed' : def.auto ? 'Auto' : undefined}
          disabled={Boolean(locked)}
          defaultValue={mixed || isAuto(def, scalar) ? '' : String(scalar ?? '')}
          onBlur={(e) => {
            const shown = mixed || isAuto(def, scalar) ? '' : String(scalar ?? '')
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
    <li
      className={[overridden ? 'field changed' : 'field', scoped?.source === 'plate' ? 'inherited' : '', locked ? 'locked' : ''].filter(Boolean).join(' ')}
      data-wide={marks ? true : undefined}
      data-testid="slice-setting-row"
      data-key={def.key}
      data-source={scoped ? scoped.source : 'plate'}
      {...settingTipAttrs(def.key)}
      {...lockTip}
    >
      <label htmlFor={id}>
        {def.label}
        {showKey ? <span className="key">{def.key}</span> : null}
        {scoped && !locked ? <span className="scope-from">{scoped.source === 'plate' ? 'from plate' : scoped.source === 'mixed' ? 'differs across the selection' : `plate ${formatValue(def, scoped.plateValue)}`}</span> : null}
      </label>
      {control}
      {!scoped && !overridden && own !== null ? (
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
      {/* The pin sits in the gutter left of the row, out of the grid, so showing it never moves the row. */}
      {pin ? (
        <button type="button" className="row-pin" data-testid="slice-setting-pin" data-key={def.key} aria-pressed={pin.on} aria-label={pin.on ? 'Unpin this setting' : 'Pin this setting'} {...tipAttrs({ title: pin.on ? 'Unpin' : 'Pin', body: 'Pinned settings show above the tabs.' })} onClick={pin.toggle}>
          <Icon name="pin" size={11} />
        </button>
      ) : null}
      {overridden ? (
        <button type="button" className="reset" data-testid="slice-setting-reset" data-key={def.key} onClick={() => setOverride(def.key, undefined)} aria-label={`Reset ${def.label}`} {...tipAttrs({ title: 'Reset', body: scoped ? 'Go back to the plate\'s value.' : 'Go back to the Easy value.' })}>
          <Icon name="rotate" />
        </button>
      ) : (
        <span className="reset" aria-hidden="true" />
      )}
      {/* After the reset, so the reset keeps its place on the row's first line. */}
      {chips ? <p className="obj-chips">{chips}</p> : null}
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

/** The nearest ancestor that scrolls: the sidebar pane. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY
    if (y === 'auto' || y === 'scroll') return p
  }
  return null
}

/** A short line of a section's values, the first few choices and numbers, then the first switch that is on. */
function summaryOf(defs: readonly SettingDef[], config: Record<string, SettingValue>): string {
  const vals = defs.filter((d) => d.type !== 'bool').slice(0, 3).map((d) => formatValue(d, config[d.key]))
  const onSw = defs.find((d) => d.type === 'bool' && on(config[d.key]))
  return [...vals, ...(onSw ? [(onSw.label ?? onSw.key).toLowerCase()] : [])].join(', ')
}

const words = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function ExpertSettings() {
  const easy = useApp((s) => s.easy)
  const overrides = useApp((s) => s.overrides)
  const [query, setQuery] = useState('')
  const [changedOnly, setChangedOnly] = useState(false)
  const [moreOpen, setMoreOpen] = useState<Set<string>>(new Set())
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
  const q = useDeferredValue(query.trim())
  const filamentCount = useFilamentCount()
  const config = useMemo(() => resolveConfig(easy, overrides), [easy, overrides])
  const activeMeta = useApp((s) => s.plates.find((p) => p.id === s.activePlate))
  const seqNote = plateSequenceNote(activeMeta, config)
  // With the selection's scope picked, each row reads and writes the selection's own values over the plate's.
  const { scope, name: scopeName } = useScope()
  const plate = useApp((s) => s.plate)
  const objectSettings = useApp((s) => s.objectSettings)
  const scoped = scope.kind !== 'plate'
  const own = useMemo(() => ownKeys({ plate, objectSettings }, scope), [plate, objectSettings, scope])
  const changed = useMemo(() => (key: string) => key in overrides || own.has(key), [overrides, own])
  const savedSections = useApp((s) => s.settingsSections)
  const pins = useApp((s) => s.settingsPins)
  const togglePin = (key: string) => set((s) => ({ settingsPins: s.settingsPins.includes(key) ? s.settingsPins.filter((k) => k !== key) : [...s.settingsPins, key].slice(-24) }))
  // Objects that print a setting with their own value: a chip on the plate's row says which, and picks the object.
  const objectValues = useMemo(() => {
    const out = new Map<string, { id: string; name: string; value: SettingValue }[]>()
    const seen = new Set<string>()
    for (const e of plate) {
      if (seen.has(sourceId(e))) continue
      seen.add(sourceId(e))
      for (const [k, v] of Object.entries(objectOverrides({ objectSettings }, e))) out.set(k, [...(out.get(k) ?? []), { id: e.id, name: e.name, value: v }])
    }
    return out
  }, [plate, objectSettings])
  const chipsFor = (def: SettingDef): ReactNode => {
    const list = scoped ? undefined : objectValues.get(def.key)
    if (!list?.length) return null
    return (
      <>
        {list.slice(0, 2).map((o) => (
          <button
            key={o.id}
            type="button"
            className="obj-chip"
            data-testid="slice-setting-object-chip"
            data-object={o.id}
            {...tipAttrs({ title: o.name, body: `${o.name} prints with its own ${def.label?.toLowerCase() ?? def.key}. Select it to edit.` })}
            onClick={() => {
              selectObject(o.id, false)
              set({ settingsScope: 'objects' })
            }}
          >
            <span className="obj-chip-name">{o.name}</span> {formatValue(def, o.value)}
          </button>
        ))}
        {list.length > 2 ? <span className="obj-chip-more">{list.length - 2} more</span> : null}
      </>
    )
  }
  const field = (def: SettingDef, o: { idPrefix?: string; note?: ReactNode } = {}) => {
    const pin = { on: pins.includes(def.key), toggle: () => togglePin(def.key) }
    const key = `${o.idPrefix ?? 'set'}-${def.key}`
    const extra = { ...(o.idPrefix ? { idPrefix: o.idPrefix } : {}), ...(o.note ? { note: o.note } : {}) }
    if (scoped) {
      const sv = scopeValue({ plate, objectSettings }, config, def.key, scope)
      const locked = variesPerObject(def) ? undefined : 'Set for the whole plate'
      return <Field key={key} def={def} value={sv.value} overridden={!locked && sv.source !== 'plate'} onSet={(k, v) => setScoped(get(), scope, k, v)} scoped={{ source: sv.source, plateValue: sv.plateValue, ...(locked ? { locked } : {}) }} {...extra} pin={pin} />
    }
    // The prime tower is one switch with atlas's placement under it (prime-tower-row.tsx).
    if (def.key === 'enable_prime_tower' && !o.idPrefix) return <PrimeTowerRow key={key} enabled={on(config[def.key])} onEnable={(v) => setOverride(def.key, v)} />
    const chips = chipsFor(def)
    if (def.key === 'print_sequence') return <Field key={key} def={def} value={config[def.key]} overridden={def.key in overrides} onSet={setSequence} {...extra} note={o.note ?? seqNote} pin={pin} chips={chips} />
    return <Field key={key} def={def} value={config[def.key]} overridden={def.key in overrides} {...extra} pin={pin} chips={chips} />
  }
  const searching = Boolean(q)
  const tabsAll = useMemo(() => buildTabs({ mode, changed, filamentCount, searching }), [mode, changed, filamentCount, searching])
  /** Why a row matched a search: its name, or a problem it helps with. */
  const matchOf = (def: SettingDef): { fix: string | null } | null => {
    if (!q) return { fix: null }
    if (fuzzyScore(q, def.label ?? '') >= 0 || fuzzyScore(q, def.key) >= 0) return { fix: null }
    const fix = fixMatch(def.key, q)
    return fix ? { fix } : null
  }
  const offered = offeredTabs(filamentCount)
  const tabs = tabsAll.filter((t) => offered.some((o) => o.id === t.intent.id))
  const stored = useApp((s) => s.settingsTab)
  const tabId = offered.some((t) => t.id === stored) ? stored : 'quality'
  const tab = tabs.find((t) => t.intent.id === tabId)!
  const totalChanged = tabsAll.reduce((n, t) => n + t.sections.reduce((m, s) => m + [...s.shown, ...s.more].filter((d) => changed(d.key)).length, 0), 0)
  const tabChanged = (t: ViewTab) => t.sections.reduce((n, s) => n + [...s.shown, ...s.more].filter((d) => changed(d.key)).length, 0)
  const flat = searching || changedOnly
  // A search or the Changed chip lists matching rows from every tab, grouped by tab and section.
  const found = flat
    ? tabs
        .map((t) => ({
          t,
          sections: t.sections
            .map((s) => {
              const pick = (d: SettingDef) => (changedOnly ? changed(d.key) : true) && matchOf(d) !== null
              // In any mode a search reaches the Expert rows too; develop rows only in Developer.
              return { s, shown: s.shown.filter(pick), more: s.more.filter(pick) }
            })
            .filter((x) => x.shown.length || x.more.length),
        }))
        .filter((x) => x.sections.length)
    : []
  const count = found.reduce((n, x) => n + x.sections.reduce((m, s) => m + s.shown.length + s.more.length, 0), 0)

  // Every press of a tab or a section header is held in place app wide (keepInPlace in @slicerx/ui). A tab picked under
  // a stuck tab row also shows the new tab from its start, with the row where it is, and the hold restarts from there.
  // Slack under the panel lets the pane scroll that far when the new tab is short.
  const slack = useRef<HTMLDivElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const tabBar = useRef<HTMLDivElement>(null)
  const showTab = (el: HTMLElement | null, change: () => void) => {
    const scroller = scrollParent(el)
    const bar = tabBar.current?.getBoundingClientRect().top
    const at = sentinel.current?.getBoundingClientRect().top
    const stuck = el && scroller && bar !== undefined && at !== undefined && at < bar - 1
    if (!stuck) return change()
    const want = scroller.scrollTop + at - bar
    flushSync(change)
    const max = scroller.scrollHeight - scroller.clientHeight
    if (slack.current && want > max) slack.current.style.height = `${(parseFloat(slack.current.style.height) || 0) + want - max}px`
    scroller.scrollTop = want
    keepInPlace(el)
  }
  // The slack shrinks as the person scrolls up, so it is never more than what keeps the view still.
  useEffect(() => {
    const scroller = scrollParent(slack.current)
    if (!scroller || !slack.current) return
    const onScroll = () => {
      const el = slack.current
      if (el) {
        const h = parseFloat(el.style.height) || 0
        // Only the part of the slack on screen holds the view; the rest goes.
        if (h > 0) el.style.height = `${Math.min(h, Math.max(0, scroller.getBoundingClientRect().bottom - el.getBoundingClientRect().top))}px`
      }
      if (tabBar.current && sentinel.current) tabBar.current.dataset.stuck = String(sentinel.current.getBoundingClientRect().top < tabBar.current.getBoundingClientRect().top - 1)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [])

  const openTab = (id: SettingIntent, el: HTMLElement | null) =>
    showTab(el, () => {
      setQuery('')
      setChangedOnly(false)
      set({ settingsTab: id })
    })
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const by = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? offered.length - 1 : by ? (i + by + offered.length) % offered.length : -1
    if (to < 0) return
    e.preventDefault()
    const next = offered[to]!
    openTab(next.id, e.currentTarget)
    document.getElementById(`set-tab-${next.id}`)?.focus({ preventScroll: true })
  }
  // A row that scrolls sideways (a phone) keeps the open tab in view, by its own scroll only: the page never moves.
  const tabRow = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const row = tabRow.current
    const sel = row?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!row || !sel || row.scrollWidth <= row.clientWidth) return
    if (sel.offsetLeft < row.scrollLeft) row.scrollLeft = sel.offsetLeft
    else if (sel.offsetLeft + sel.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = sel.offsetLeft + sel.offsetWidth - row.clientWidth
  }, [tabId])
  const toggleSection = (s: ViewSection, open: boolean) => set((st) => ({ settingsSections: { ...st.settingsSections, [s.key]: !open } }))
  const toggleMore = (key: string) =>
    setMoreOpen((m) => {
      const next = new Set(m)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const pinned = pins.map((k) => EDITABLE_PROCESS.find((d) => d.key === k)).filter((d): d is SettingDef => Boolean(d))
  const visibleSections = tab.sections.filter((s) => sectionHasRows(s, { mode, changed }))
  const rowCount = visibleSections.reduce((n, s) => n + s.shown.length + sectionRows(s, { mode, changed, moreOpen: true }).more.length + (s.choices && !scoped ? 2 : 0), 0)
  const searchable = EDITABLE_PROCESS.filter((d) => d.mode !== 'hidden' && (d.mode !== 'develop' || mode === 'developer')).length
  return (
    <div id="expert-panel" className="expert tiers" data-mode={mode}>
      {pinned.length ? (
        <section className="set-pins expert-group" aria-label="Pinned settings" data-testid="slice-settings-pins">
          <h4>
            <span className="tier-h">
              <Icon name="pin" size={14} />
              Pinned
            </span>
          </h4>
          <ul>{pinned.map((d) => field(d, { idPrefix: 'pin' }))}</ul>
        </section>
      ) : null}
      <div className="search-in">
        <Icon name="search" />
        <label className="sr-only" htmlFor="expert-search">
          Search settings
        </label>
        <input id="expert-search" className="bare" placeholder={`Search ${searchable} settings or a problem, like stringing`} value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
      </div>
      <div className="expert-opts">
        <button type="button" className="set-changed" data-testid="slice-settings-changed" aria-pressed={changedOnly} disabled={!totalChanged && !changedOnly} onClick={() => setChangedOnly((v) => !v)}>
          <span className="dot" aria-hidden="true" />
          {totalChanged} changed
        </button>
        <span className="sx-small sx-muted">{scoped ? `${scopeName} only, over the plate` : flat ? (searching ? `${count} found in every tab${expert ? '' : ', Expert too'}` : 'Your changes in every tab') : 'Plate: every object'}</span>
      </div>
      <div ref={sentinel} aria-hidden="true" />
      <div className="set-tabs-bar" ref={tabBar} hidden={flat}>
        <div className="set-tabs" role="tablist" aria-label="Setting groups" ref={tabRow}>
          {offered.map((t, i) => {
            const n = tabChanged(tabsAll.find((x) => x.intent.id === t.id)!)
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`set-tab-${t.id}`}
                data-testid={`slice-settings-tab-${t.id}`}
                className="set-tab"
                data-tab={t.id}
                aria-selected={!flat && t.id === tabId}
                aria-controls="set-tab-panel"
                aria-label={n ? `${t.label}, ${words(n, 'change')}` : t.label}
                tabIndex={t.id === tabId ? 0 : -1}
                {...tipAttrs({ title: t.label, body: n ? `${t.blurb}. ${words(n, 'setting')} changed.` : t.blurb })}
                onClick={(e) => openTab(t.id, e.currentTarget)}
                onKeyDown={(e) => onTabKey(e, i)}
              >
                <Icon name={t.icon} size={18} />
                {n ? <span className="set-tab-count" data-testid="slice-settings-tab-count">{n}</span> : null}
              </button>
            )
          })}
        </div>
      </div>
      {flat && !count ? <p className="sx-muted sx-small">{changedOnly ? 'Nothing changed yet.' : `No setting matches "${query}"`}</p> : null}
      <div id="set-tab-panel" role="tabpanel" aria-labelledby={flat ? undefined : `set-tab-${tabId}`} aria-label={flat ? (searching ? 'Search results' : 'Changed settings') : undefined}>
        {flat
          ? found.map(({ t, sections }) => (
              <section key={t.intent.id} className="expert-group tier-group" data-intent={t.intent.id} aria-label={t.intent.label}>
                <h4>
                  <span className="tier-h">
                    <Icon name={t.intent.icon} size={14} />
                    {t.intent.label}
                  </span>
                  <span className="sx-mono">{sections.reduce((n, s) => n + s.shown.length + s.more.length, 0)}</span>
                </h4>
                {sections.map(({ s, shown, more }) => (
                  <div key={s.id} className="set-sec" data-section={s.key}>
                    <div className="set-sec-sub">{s.label}</div>
                    <ul>
                      {shown.map((d) => field(d, { note: fixNote(d) }))}
                      {more.length ? <li className="tier-divider" aria-hidden="true">Expert</li> : null}
                      {more.map((d) => field(d, { note: fixNote(d) }))}
                    </ul>
                  </div>
                ))}
              </section>
            ))
          : (
              <section key={tab.intent.id} className="expert-group tier-group" data-intent={tab.intent.id} aria-label={tab.intent.label}>
                <h4>
                  <span className="tier-h">
                    <Icon name={tab.intent.icon} size={14} />
                    {tab.intent.label}
                  </span>
                  <span className="sx-small">{`${words(rowCount, 'setting')} in ${words(visibleSections.length, 'section')}`}</span>
                </h4>
                {visibleSections.map((s) => {
                  const open = sectionOpen(savedSections, tab, s, { mode, changed })
                  const rows = sectionRows(s, { mode, changed, moreOpen: moreOpen.has(s.key) })
                  const all = [...s.shown, ...rows.more]
                  const n = [...s.shown, ...s.more].filter((d) => changed(d.key)).length
                  const listed = open ? rows : { shown: s.shown.filter((d) => changed(d.key)), more: rows.more.filter((d) => changed(d.key)), hidden: 0 }
                  const choices = s.choices && !scoped && open
                  return (
                    <div key={s.key} className="set-sec" data-section={s.key} data-open={open}>
                      <button type="button" className="set-sec-h" data-testid="slice-settings-section" data-section={s.key} aria-expanded={open} onClick={() => toggleSection(s, open)}>
                        <Icon name="chevron-right" size={14} className="chev" />
                        <span className="t">{s.label}</span>
                        <span className="n">{n ? `${n} changed` : ''}</span>
                        <span className="sum">{summaryOf(all, config)}</span>
                      </button>
                      {choices || listed.shown.length || listed.more.length ? (
                        <ul>
                          {choices ? (
                            <>
                              <ChoiceRow name="overhangSlowdown" config={config} overrides={overrides} />
                              <ChoiceRow name="unsupportedOverhangs" config={config} overrides={overrides} />
                            </>
                          ) : null}
                          {listed.shown.map((d) => field(d))}
                          {listed.more.length ? <li className="tier-divider" aria-hidden="true">Expert</li> : null}
                          {listed.more.map((d) => field(d))}
                        </ul>
                      ) : null}
                      {open && expert && (rows.hidden > 0 || moreOpen.has(s.key)) ? (
                        <button type="button" className="tier-more" aria-expanded={moreOpen.has(s.key)} onClick={() => toggleMore(s.key)}>
                          <Icon name={moreOpen.has(s.key) ? 'chevron-up' : 'chevron-down'} size={14} />
                          {moreOpen.has(s.key) ? 'Fewer' : `${rows.hidden} more`}
                        </button>
                      ) : null}
                    </div>
                  )
                })}
              </section>
            )}
      </div>
      {/* Print sequence's note still shows when its row is not listed and the plate prints otherwise. */}
      {seqNote && !(tabId === 'output' && !flat) ? <p className="app-note">{seqNote}</p> : null}
      {scoped ? <p className="app-note">Changes apply to {scopeName} only, over the plate's settings.</p> : null}
      <p className="app-note" hidden={scoped}>Changes apply to this plate. Saved profiles stay as they are.</p>
      <div ref={slack} className="set-slack" aria-hidden="true" />
    </div>
  )

  function fixNote(d: SettingDef): ReactNode {
    const m = matchOf(d)
    return m?.fix ? `Helps with ${m.fix}` : undefined
  }
}
