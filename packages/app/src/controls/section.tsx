// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Controls: every mouse and keyboard binding, starting from the look chosen at setup. Mouse
// buttons and wheel, then a searchable shortcut list where any key can be changed, cleared or put back.
// Changes are stored next to the look choice and apply at once.
import type { LookAndFeelChoice } from '@slicerx/contracts'
import { Button, Select, Seg, Switch, tipAttrs } from '@slicerx/ui'
import { controlsPreset, withGizmo, withRemap, type ButtonRemap, type GizmoOverrides, type ModKey } from '@slicerx/viewport'
import { useEffect, useMemo, useState } from 'react'
import { controlOverrides, controlsFor, withControlOverrides, type ControlOverrides } from '../first-run/controls'
import { BUTTON_LABELS, plainAction, REMAP_OPTIONS } from '../first-run/slicer-step'
import { useLookChoice, useTabLabel } from '../first-run/look'
import { formatShortcut, isMac } from '../lib/keys'
import { set } from '../state/store'
import { ACTION_LABEL, actionLabel, chordOf, groupLabel, FIXED_KEYS, GROUPS, KEY_ACTIONS, keymapFor, type ActionGroup } from './actions'
import { keymapConflicts, type KeyAction } from '@slicerx/ui'

const API = { controlsPreset, withRemap, withGizmo }
type Button3 = 'left' | 'middle' | 'right'

/** The choice with one key changed. A chord equal to the preset's is dropped so "reset" stays clean. */
export function withKey(choice: LookAndFeelChoice, action: KeyAction, chord: string | null | undefined): LookAndFeelChoice {
  const keys = { ...(choice.overrides?.keys ?? {}) }
  const preset = keymapFor(choice.id)[action]
  if (chord === undefined || chord === preset || (chord === '' && preset === null)) delete keys[action]
  else keys[action] = chord ?? ''
  const { keys: _old, ...rest } = choice.overrides ?? {}
  const overrides = Object.keys(keys).length ? { ...rest, keys } : rest
  return Object.keys(overrides).length ? { id: choice.id, overrides } : { id: choice.id }
}

function Mouse({ choice, onChange }: { choice: LookAndFeelChoice; onChange: (c: LookAndFeelChoice) => void }) {
  const o = controlOverrides(choice)
  const map = controlsFor(API, choice)
  const update = (patch: Partial<ControlOverrides>) => onChange(withControlOverrides(choice, { ...o, ...patch }))
  const setButton = (b: Button3, v: 'none' | 'pan' | 'rotate') => {
    const preset = plainAction(controlsPreset(choice.id), b)
    const remap: ButtonRemap = { ...o.remap }
    if (v === preset) delete remap[b]
    else remap[b] = v === 'none' ? null : v
    update({ remap })
  }
  const changed = Boolean(Object.keys(o).length)
  return (
    <section aria-labelledby="ctl-mouse">
      <h4 id="ctl-mouse" className="set-sub">
        Mouse
      </h4>
      {(['left', 'middle', 'right'] as const).map((b) => (
        <div className="fr-mouse-row" key={b}>
          <span>{BUTTON_LABELS[b]} drag</span>
          <Seg label={`${BUTTON_LABELS[b]} drag`} size="sm" value={plainAction(map, b)} options={REMAP_OPTIONS} onChange={(v) => setButton(b, v)} />
        </div>
      ))}
      <div className="sx-switchrow">
        <label htmlFor="ctl-invert">Invert zoom</label>
        <Switch id="ctl-invert" checked={map.wheel.invert} onChange={(v) => update({ invert: v })} />
      </div>
      <div className="sx-switchrow">
        <label htmlFor="ctl-cursor">Zoom to cursor</label>
        <Switch id="ctl-cursor" checked={map.wheel.zoomToCursor} onChange={(v) => update({ zoomToCursor: v })} />
      </div>
      <div className="sx-switchrow">
        <label htmlFor="ctl-free">
          Free camera
          <small>Orbit around the point under the cursor instead of the plate.</small>
        </label>
        <Switch id="ctl-free" checked={map.freeCamera} onChange={(v) => update({ freeCamera: v })} />
      </div>
      {changed ? (
        <Button size="sm" variant="ghost" onClick={() => onChange(withControlOverrides(choice, {}))}>
          Mouse back to the preset
        </Button>
      ) : null}
    </section>
  )
}

type KeyPath = ['move', 'snapKey'] | ['rotate', 'snapKey'] | ['scale', 'pinKey'] | ['scale', 'snapKey'] | ['paint', 'eraseKey'] | ['paint', 'wheelParamKey'] | ['paint', 'wheelClipKey']

const GIZMO_ROWS: { path: KeyPath; label: string; hint: string; optional: boolean }[] = [
  { path: ['move', 'snapKey'], label: 'Snap a move', hint: 'Hold while moving to step by 1 mm.', optional: true },
  { path: ['rotate', 'snapKey'], label: 'Snap a rotation', hint: 'Hold while dragging a rotate ring to turn in 15° steps.', optional: true },
  { path: ['scale', 'pinKey'], label: 'Scale from the opposite side', hint: 'Hold while dragging a scale handle to keep the opposite handle in place.', optional: true },
  { path: ['scale', 'snapKey'], label: 'Snap a scale', hint: 'Hold while scaling to step the factor.', optional: true },
  { path: ['paint', 'eraseKey'], label: 'Erase while painting', hint: 'Hold while painting to erase.', optional: true },
  { path: ['paint', 'wheelParamKey'], label: 'Wheel changes the brush', hint: 'Hold and use the wheel to change brush size, height band, fill angle or gap area.', optional: false },
  { path: ['paint', 'wheelClipKey'], label: 'Wheel moves the clipping plane', hint: 'Hold and use the wheel to move the section plane while painting.', optional: false },
]

const MOD_OPTIONS: { value: ModKey | 'none'; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'shift', label: 'Shift' },
  { value: 'ctrl', label: isMac() ? 'Command' : 'Ctrl' },
  { value: 'alt', label: isMac() ? 'Option' : 'Alt' },
]

function getKey(map: { gizmo: Record<string, Record<string, unknown>> }, path: KeyPath): ModKey | null {
  return (map.gizmo[path[0]]?.[path[1]] as ModKey | null | undefined) ?? null
}

/** Modifier keys of the move, rotate, scale and paint tools, from the look's own values. */
function Gizmo({ choice, onChange }: { choice: LookAndFeelChoice; onChange: (c: LookAndFeelChoice) => void }) {
  const o = controlOverrides(choice)
  const map = controlsFor(API, choice) as unknown as { gizmo: Record<string, Record<string, unknown>> }
  const preset = controlsPreset(choice.id) as unknown as { gizmo: Record<string, Record<string, unknown>> }
  const set = (path: KeyPath, value: ModKey | 'none') => {
    const next = structuredClone(o.gizmo ?? {}) as Record<string, Record<string, unknown>>
    const base = getKey(preset, path)
    const v = value === 'none' ? null : value
    const group = { ...(next[path[0]] ?? {}) }
    if (v === base) delete group[path[1]]
    else group[path[1]] = v
    if (Object.keys(group).length) next[path[0]] = group
    else delete next[path[0]]
    onChange(withControlOverrides(choice, { ...o, gizmo: next as GizmoOverrides }))
  }
  const changed = Boolean(o.gizmo && Object.keys(o.gizmo).length)
  return (
    <section aria-labelledby="ctl-gizmo">
      <h4 id="ctl-gizmo" className="set-sub">
        Move, rotate, scale and paint keys
      </h4>
      {GIZMO_ROWS.map((r) => {
        const cur = getKey(map, r.path) ?? 'none'
        const id = `gz-${r.path.join('-')}`
        return (
          <div className="fr-mouse-row" key={id}>
            <label htmlFor={id} {...tipAttrs(r.hint ? { title: r.label ?? r.hint, body: r.hint } : undefined)}>
              {r.label}
            </label>
            <Select id={id} size="sm" value={cur} onChange={(e) => set(r.path, e.target.value as ModKey | 'none')}>
              {MOD_OPTIONS.filter((m) => r.optional || m.value !== 'none').map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
        )
      })}
      {changed ? (
        <Button size="sm" variant="ghost" onClick={() => onChange(withControlOverrides(choice, (({ gizmo: _g, ...rest }) => rest)(o)))}>
          Tool keys back to the preset
        </Button>
      ) : null}
    </section>
  )
}

function Row({ action, choice, onChange, capturing, setCapturing }: { action: KeyAction; choice: LookAndFeelChoice; onChange: (c: LookAndFeelChoice) => void; capturing: KeyAction | null; setCapturing: (a: KeyAction | null) => void }) {
  const map = keymapFor(choice.id, choice.overrides?.keys ?? {})
  const preset = keymapFor(choice.id)[action]
  const cur = map[action]
  const edited = cur !== preset
  const on = capturing === action
  const tab = useTabLabel('prepare')
  const label = actionLabel(action, tab)
  return (
    <li className="key-row" data-edited={edited ? 'true' : undefined}>
      <span className="key-label">{label}</span>
      <kbd className="key-chord sx-mono" aria-label={`${label}: ${cur ? formatShortcut(cur) : 'no key'}`}>
        {on ? 'Press a key' : cur ? formatShortcut(cur) : 'None'}
      </kbd>
      <span className="key-act">
        <Button size="sm" variant="ghost" aria-label={`Change the key for ${label}`} aria-pressed={on} onClick={() => setCapturing(on ? null : action)}>
          {on ? 'Cancel' : 'Change'}
        </Button>
        <Button size="sm" variant="ghost" aria-label={`Clear the key for ${label}`} disabled={!cur} onClick={() => onChange(withKey(choice, action, ''))}>
          Clear
        </Button>
        <Button size="sm" variant="ghost" aria-label={`Put the key for ${label} back`} disabled={!edited} onClick={() => onChange(withKey(choice, action, undefined))}>
          Reset
        </Button>
      </span>
    </li>
  )
}

export function ControlsSection() {
  const choice = useLookChoice()
  const tab = useTabLabel('prepare')
  const [query, setQuery] = useState('')
  const [capturing, setCapturing] = useState<KeyAction | null>(null)
  const [note, setNote] = useState('')
  const change = (c: LookAndFeelChoice) => set({ lookAndFeel: c })
  const map = keymapFor(choice.id, choice.overrides?.keys ?? {})
  const conflicts = useMemo(() => keymapConflicts(map), [map])
  const editedCount = Object.keys(choice.overrides?.keys ?? {}).length

  // While a row waits for a key, the next key press becomes its binding. Escape cancels.
  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setCapturing(null)
      const c = chordOf(e, isMac())
      if (!c) return
      const clash = KEY_ACTIONS.find((a) => a !== capturing && map[a]?.toLowerCase() === c.toLowerCase())
      setNote(clash ? `${formatShortcut(c)} is also used for "${actionLabel(clash, tab)}". Change one of them.` : '')
      change(withKey(choice, capturing, c))
      setCapturing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, choice, map, tab])

  const q = query.trim().toLowerCase()
  const visible = (a: KeyAction) => !q || actionLabel(a, tab).toLowerCase().includes(q) || (map[a] ?? '').toLowerCase().includes(q) || a.toLowerCase().includes(q)
  return (
    <section className="set-sec" aria-labelledby="controls-h">
      <h3 id="controls-h">Controls</h3>
      <p className="sx-small sx-muted">Everything starts from the look you chose at setup. Changes here stay with it.</p>
      <Mouse choice={choice} onChange={change} />
      <Gizmo choice={choice} onChange={change} />
      <h4 className="set-sub">Keyboard</h4>
      <div className="key-tools">
        <label className="sr-only" htmlFor="key-search">
          Search shortcuts
        </label>
        <input id="key-search" className="sx-input" placeholder="Search shortcuts by name or key" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button size="sm" variant="ghost" disabled={editedCount === 0} onClick={() => { setCapturing(null); setNote(''); change({ ...choice, overrides: (({ keys: _k, ...rest }) => rest)(choice.overrides ?? {}) } as LookAndFeelChoice) }}>
          Reset keys to the preset
        </Button>
      </div>
      {note ? <p className="sx-small app-err" role="status">{note}</p> : null}
      {conflicts.length ? <p className="sx-small app-err" role="status">{conflicts.length} keys are used twice: {conflicts.slice(0, 3).map(([a, b]) => `${actionLabel(a, tab)} and ${actionLabel(b, tab)}`).join('; ')}.</p> : null}
      {GROUPS.map((g: ActionGroup) => {
        const rows = KEY_ACTIONS.filter((a) => ACTION_LABEL[a].group === g && visible(a))
        if (rows.length === 0) return null
        return (
          <div key={g} role="group" aria-label={`${groupLabel(g, tab)} shortcuts`}>
            <h5 className="key-group">{groupLabel(g, tab)}</h5>
            <ul className="key-list">
              {rows.map((a) => (
                <Row key={a} action={a} choice={choice} onChange={change} capturing={capturing} setCapturing={setCapturing} />
              ))}
            </ul>
          </div>
        )
      })}
      <div role="group" aria-label="Keys that do not change">
        <h5 className="key-group">Fixed in every look</h5>
        <ul className="key-list">
          {FIXED_KEYS.filter((k) => !q || k.label.toLowerCase().includes(q) || k.chord.toLowerCase().includes(q)).map((k) => (
            <li className="key-row" key={k.chord}>
              <span className="key-label">{k.label}</span>
              <kbd className="key-chord sx-mono">{formatShortcut(k.chord)}</kbd>
              <span className="key-act" />
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
