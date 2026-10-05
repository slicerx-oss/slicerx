// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings for the selected object, over the plate's settings, as in the object list of Bambu
// Studio and OrcaSlicer: add a setting, change it, reset it. Only process settings, and only the
// levels the look's settings mode shows; search finds the rest.
import type { SettingValue } from '@slicerx/contracts'
import { LinkButton } from '@slicerx/ui'
import { useDeferredValue, useMemo, useState } from 'react'
import { isVisible, resolveConfig, SETTINGS } from '../../adapters/settings'
import { useFilamentCount } from '../../filament/count'
import { fuzzyScore } from '../../commands/fuzzy'
import { effectiveMode, useLayout } from '../../first-run/look'
import { objectOverrides, partOverridesOf, setObjectSetting, setPartSetting } from '../../plate/object-settings'
import { useApp } from '../../state/store'
import { EDITABLE, Field, visibleLevels } from './expert-settings'

export function ObjectSettings() {
  const entry = useApp((s) => s.plate.find((p) => p.id === s.selection))
  const objectSettings = useApp((s) => s.objectSettings)
  const plate = useApp((s) => s.plate)
  const easy = useApp((s) => s.easy)
  const overrides = useApp((s) => s.overrides)
  const layout = useLayout()
  const mode = effectiveMode(useApp((s) => s.settingsMode), layout)
  const [adding, setAdding] = useState(false)
  const [target, setTarget] = useState('')
  const [query, setQuery] = useState('')
  const q = useDeferredValue(query.trim())
  const config = useMemo(() => resolveConfig(easy, overrides), [easy, overrides])
  const levels = useMemo(() => visibleLevels(mode, layout), [mode, layout])
  // The target is the whole object, or one of its parts: a part prints with its own settings in its own area.
  const partNames = entry && !entry.instanceOf ? entry.parts.map((p) => p.name) : []
  const part = partNames.includes(target) ? target : ''
  const own = entry ? (part ? (partOverridesOf(plate, entry)[part] ?? {}) : objectOverrides({ objectSettings }, entry)) : {}
  const setOwn = (key: string, v: SettingValue | undefined) => (entry ? (part ? setPartSetting(entry.id, part, key, v) : setObjectSetting(entry.id, key, v)) : undefined)
  const filamentCount = useFilamentCount()
  const hits = useMemo(() => {
    if (!q) return []
    return SETTINGS.filter((d) => d.section === 'process' && EDITABLE.has(d.type) && isVisible(d, { filamentCount }) && !(d.key in own) && (levels.has(d.mode) || q.length > 2))
      .map((d) => ({ d, score: Math.max(fuzzyScore(q, d.label), fuzzyScore(q, d.key)) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.d)
  }, [q, own, levels, filamentCount])
  if (!entry || mode === 'simple') return null
  const keys = Object.keys(own)
  return (
    <div className="obj-set" data-section="object-settings">
      <div className="obj-set-h">
        <span>{part ? 'Part settings' : 'Object settings'}</span>
        <LinkButton icon="plus" expanded={adding} onClick={() => setAdding(!adding)}>
          Add setting
        </LinkButton>
      </div>
      {partNames.length > 1 ? (
        <label className="obj-set-target">
          <span className="sx-small sx-muted">Applies to</span>
          <select className="mini" aria-label="Settings apply to" value={part} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Whole object</option>
            {partNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {keys.length ? (
        <ul className="expert obj-set-list">
          {keys.map((k) => {
            const def = SETTINGS.find((d) => d.key === k)
            return def ? <Field key={k} def={def} value={own[k]} overridden idPrefix="obj" onSet={(key, v) => setOwn(key, v)} /> : null
          })}
        </ul>
      ) : (
        <p className="sx-small sx-muted">{part ? 'This part prints with the object\'s settings.' : 'This object prints with the plate\'s settings.'}</p>
      )}
      {adding ? (
        <div className="obj-set-add">
          <label className="sr-only" htmlFor="obj-set-search">
            Find a setting to change for this object
          </label>
          <input id="obj-set-search" className="sx-input" placeholder="Find a setting, such as wall loops" value={query} autoFocus onChange={(e) => setQuery(e.target.value)} />
          <ul className="obj-set-hits" aria-label="Settings you can add">
            {hits.map((d) => (
              <li key={d.key}>
                <button type="button" onClick={() => { setOwn(d.key, config[d.key] ?? d.default); setQuery(''); setAdding(false) }}>
                  {d.label} <span className="sx-mono sx-dim">{d.key}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
