// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// norn, edit from Preview. A click on a toolpath opens a card beside it with the settings that made
// that path, editable in place. The first change keeps the slice as it was; once the new slice is in,
// the bar at the top of the view says what the change cost in time and filament, and can show the old
// paths as a faint layer under the new ones. Keep closes the comparison, Undo puts the settings back.
import type { SettingDef, SettingValue } from '@slicerx/contracts'
import { Button, Icon } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { loadSettings, settingsIfLoaded, type SettingsApi } from '../adapters/load'
import { resolveConfig } from '../adapters/config'
import { useHost } from '../host'
import { formatDuration, formatGrams } from '../lib/preview-stats'
import { objectOverrides, setObjectSetting } from '../plate/object-settings'
import { slicePlate } from '../state/actions'
import { get, markStale, set, useApp } from '../state/store'
import { Field } from '../workspaces/prepare/expert-settings'
import { diffText, settingsFor } from './norn-map'
import './norn.css'

const CARD_W = 300

function NornCard({ schema }: { schema: SettingsApi }) {
  const host = useHost()
  const pick = useApp((s) => s.norn.pick)
  const easy = useApp((s) => s.easy)
  const overrides = useApp((s) => s.overrides)
  const objectSettings = useApp((s) => s.objectSettings)
  const plate = useApp((s) => s.plate)
  const [scope, setScope] = useState<'object' | 'plate'>('object')
  if (!pick) return null
  // A path of one object on a plate of several can change that object alone.
  const entry = pick.objectId && plate.filter((p) => p.printable !== false).length > 1 ? plate.find((p) => p.id === pick.objectId) : undefined
  const own = entry && scope === 'object' ? objectOverrides({ objectSettings }, entry) : null
  const config = { ...resolveConfig(easy, overrides), ...(own ?? {}) } as Record<string, SettingValue | undefined>
  const feature = settingsFor(pick.feature)
  const defs = feature.keys.map((k) => schema.settingDef(k)).filter((d): d is SettingDef => Boolean(d))
  const change = (key: string, value: SettingValue | undefined) => {
    const s = get()
    // The first change from Preview keeps the slice as it is now, for the comparison.
    const before = s.norn.before ?? (s.slice.status === 'done' && s.preview ? { timeS: s.slice.result.stats.timeS, grams: s.slice.result.stats.filamentG.reduce((a, b) => a + b, 0), preview: s.preview, overrides: s.overrides, objectSettings: s.objectSettings } : null)
    if (entry && own) {
      setObjectSetting(entry.id, key, value)
      set({ norn: { ...get().norn, before } })
    } else {
      const next = { ...s.overrides }
      if (value === undefined) delete next[key]
      else next[key] = value
      set({ overrides: next, norn: { ...s.norn, before } })
      markStale()
    }
    // With Auto slice on the background slice picks the change up; without it, this is the Slice press.
    if (!get().autoSlice) void slicePlate(host)
  }
  // Beside the click, kept inside the view.
  const left = Math.max(12, pick.screen[0] + 18)
  const top = Math.max(64, pick.screen[1] - 40)
  return (
    <aside className="norn-card sx-overlay" style={{ left: `min(${left}px, calc(100% - ${CARD_W + 12}px))`, top: `min(${top}px, calc(100% - 340px))`, width: CARD_W }} aria-label={`Settings that made this ${feature.name.toLowerCase()}`}>
      <header className="norn-head">
        <div>
          <b>{feature.name}</b>
          <span className="sx-mono">
            Layer {pick.layer + 1}
            {pick.gcodeLine > 0 ? `, G-code line ${pick.gcodeLine.toLocaleString('en-US')}` : ''}
          </span>
        </div>
        <Button size="sm" variant="ghost" icon="close" aria-label="Close" onClick={() => set((s) => ({ norn: { ...s.norn, pick: null } }))} />
      </header>
      {entry && defs.length ? (
        <div className="norn-scope" role="group" aria-label="Apply changes to">
          <Button size="sm" variant="ghost" pressed={scope === 'object'} onClick={() => setScope('object')}>
            {entry.name}
          </Button>
          <Button size="sm" variant="ghost" pressed={scope === 'plate'} onClick={() => setScope('plate')}>
            Whole plate
          </Button>
        </div>
      ) : null}
      {defs.length ? (
        <div className="norn-fields">
          {defs.map((d) => (
            <Field key={d.key} def={d} value={config[d.key]} overridden={own ? d.key in own : d.key in overrides} onSet={change} idPrefix="norn" />
          ))}
        </div>
      ) : (
        <p className="sx-small sx-muted">{feature.name === 'Custom G-code' ? 'This path comes from G-code you added, so no setting shapes it.' : 'No setting is linked to this kind of path yet.'}</p>
      )}
      <p className="norn-foot sx-small sx-muted">{own && entry ? `A change here applies to ${entry.name} only and slices again.` : 'A change here applies to the whole plate and slices again.'}</p>
    </aside>
  )
}

/** The bar at the top of Preview after a change: what it cost in time and filament, the ghost toggle, Undo and Keep. */
export function NornBar() {
  const host = useHost()
  const before = useApp((s) => s.norn.before)
  const ghost = useApp((s) => s.norn.ghost)
  const slice = useApp((s) => s.slice)
  if (!before) return null
  const fresh = slice.status === 'done' && !slice.stale
  const now = fresh ? { timeS: slice.result.stats.timeS, grams: slice.result.stats.filamentG.reduce((a, b) => a + b, 0) } : null
  const keep = () => set((s) => ({ norn: { ...s.norn, before: null, ghost: false } }))
  const undo = () => {
    set((s) => ({ overrides: before.overrides, objectSettings: before.objectSettings, norn: { ...s.norn, before: null, ghost: false } }))
    markStale()
    // As with a change: without Auto slice, putting the settings back slices again too.
    if (!get().autoSlice) void slicePlate(host)
  }
  return (
    <div className="norn-bar sx-overlay" role="status" aria-label="Before and after your change">
      {now ? (
        <>
          <span className="norn-stat">
            <Icon name="time" size={15} /> <b className="sx-mono">{formatDuration(now.timeS)}</b>
            <small>{diffText(before.timeS, now.timeS, formatDuration, 30)}</small>
          </span>
          <span className="norn-stat">
            <Icon name="weight" size={15} /> <b className="sx-mono">{formatGrams(now.grams)}</b>
            <small>{diffText(before.grams, now.grams, formatGrams, 0.05)}</small>
          </span>
        </>
      ) : (
        <span className="norn-stat">
          <Icon name="slice" size={15} /> {slice.status === 'error' ? 'The slice with your change failed' : 'Slicing with your change'}
        </span>
      )}
      <Button size="sm" variant="ghost" icon={ghost ? 'hide' : 'show'} pressed={ghost} disabled={!now} onClick={() => set((s) => ({ norn: { ...s.norn, ghost: !s.norn.ghost } }))}>
        {ghost ? 'Hide the old paths' : 'Show the old paths'}
      </Button>
      <Button size="sm" variant="ghost" icon="undo" onClick={undo}>
        Undo change
      </Button>
      <Button size="sm" variant="primary" icon="check" onClick={keep}>
        Keep
      </Button>
    </div>
  )
}

export function NornLayer() {
  const [schema, setSchema] = useState<SettingsApi | null>(settingsIfLoaded)
  useEffect(() => {
    if (!schema) void loadSettings().then(setSchema)
  }, [schema])
  return (
    <>
      <NornBar />
      {schema ? <NornCard schema={schema} /> : null}
    </>
  )
}
