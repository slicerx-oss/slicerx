// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Volumes of the selected object: negative volumes (cut away), support blockers and support enforcers.
// Add one from a shape or from another object on the plate, list them under the object, and move and
// size the one you pick.
import { Button, LinkButton, Select, VectorField } from '@slicerx/ui'
import { useMemo, useState } from 'react'
import { useHost } from '../../host'
import { copyVolume } from '../../plate/clipboard'
import type { PrimitiveShape } from '../../plate/mesh-ops'
import { addPrimitiveVolume, removeVolume, ROLE_LABEL, setModifierSetting, setVolumeRole, setVolumeSize, setVolumeTrs, useObjectAsVolume, volumeSize } from '../../plate/volumes'
import { plateScrub } from '../../plate/scrub'
import { decompose } from '../../plate/transform'
import { toast, useApp, type PlateVolumeEntry, type VolumeRole } from '../../state/store'
import { isVisible, resolveConfig, SETTINGS } from '../../adapters/settings'
import { useFilamentCount } from '../../filament/count'
import { fuzzyScore } from '../../commands/fuzzy'
import { EDITABLE, Field, visibleLevels } from './expert-settings'
import { effectiveMode, useLayout } from '../../first-run/look'
import './object-volumes.css'

const ROLES = Object.keys(ROLE_LABEL) as VolumeRole[]
const SHAPES: { value: PrimitiveShape; label: string }[] = [
  { value: 'box', label: 'Box' },
  { value: 'cylinder', label: 'Cylinder' },
  { value: 'sphere', label: 'Sphere' },
  { value: 'cone', label: 'Cone' },
]
const DOT: Record<VolumeRole, string> = { negative: 'var(--red)', support_blocker: 'var(--orange)', support_enforcer: 'var(--green)', modifier: 'var(--cyan)' }

/** The walls, infill, speed and flow settings a modifier changes inside its shape. Anything else the engine does not apply by region. */
const MODIFIER_GROUPS = new Set(['strength', 'speed', 'quality', 'extrusion'])

function ModifierSettings({ objectId, v }: { objectId: string; v: PlateVolumeEntry }) {
  const easy = useApp((s) => s.easy)
  const overrides = useApp((s) => s.overrides)
  const layout = useLayout()
  const mode = effectiveMode(useApp((s) => s.settingsMode), layout)
  const levels = useMemo(() => visibleLevels(mode, layout), [mode, layout])
  const config = useMemo(() => resolveConfig(easy, overrides), [easy, overrides])
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const own = v.settings ?? {}
  const pool = useMemo(() => SETTINGS.filter((d) => d.section === 'process' && EDITABLE.has(d.type) && MODIFIER_GROUPS.has(d.group)), [])
  const filamentCount = useFilamentCount()
  const hits = useMemo(() => {
    const q = query.trim()
    return pool
      .filter((d) => isVisible(d, { filamentCount }) && !(d.key in own) && (levels.has(d.mode) || q.length > 2) && (!q || fuzzyScore(q, d.label) >= 0 || fuzzyScore(q, d.key) >= 0))
      .slice(0, 8)
  }, [pool, own, query, levels, filamentCount])
  return (
    <div className="vol-mod" data-section="modifier-settings">
      <p className="sx-small sx-muted">The object prints with these settings inside this shape.</p>
      {Object.keys(own).length ? (
        <ul className="expert obj-set-list">
          {Object.keys(own).map((k) => {
            const def = SETTINGS.find((d) => d.key === k)
            return def ? <Field key={k} def={def} value={own[k]} overridden idPrefix={`mod-${v.id}`} onSet={(key, val) => setModifierSetting(objectId, v.id, key, val)} /> : null
          })}
        </ul>
      ) : null}
      <LinkButton icon="plus" expanded={adding} onClick={() => setAdding(!adding)}>
        Add setting
      </LinkButton>
      {adding ? (
        <div className="obj-set-add">
          <label className="sr-only" htmlFor={`mod-search-${v.id}`}>
            Find a setting for the modifier
          </label>
          <input id={`mod-search-${v.id}`} className="sx-input" placeholder="Wall loops, infill density, speed" value={query} autoFocus onChange={(e) => setQuery(e.target.value)} />
          <ul className="obj-set-hits" aria-label="Settings you can add">
            {hits.map((d) => (
              <li key={d.key}>
                <button type="button" onClick={() => { setModifierSetting(objectId, v.id, d.key, config[d.key] ?? d.default); setQuery(''); setAdding(false) }}>
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

function VolumeFields({ objectId, v }: { objectId: string; v: PlateVolumeEntry }) {
  const t = decompose(v.local)
  const size = volumeSize(v)
  const scrub = (apply: (i: number, x: number) => unknown) => ({
    onCommit: (i: number, x: number) => plateScrub(objectId, (y) => apply(i, y)).onCommit(x),
    onPreview: (i: number, x: number) => plateScrub(objectId, (y) => apply(i, y)).onPreview(x),
    onCancel: () => plateScrub(objectId, () => undefined).onCancel(),
  })
  return (
    <div className="vol-fields">
      {v.role === 'modifier' ? <ModifierSettings objectId={objectId} v={v} /> : null}
      <VectorField className="tf-row" id={`vp-${v.id}`} label="Position" ariaLabel="Volume position" unit="mm" values={t.position} {...scrub((i, x) => setVolumeTrs(objectId, v.id, { position: t.position.map((p, k) => (k === i ? x : p)) as [number, number, number] }))} />
      <VectorField className="tf-row" id={`vs-${v.id}`} label="Size" ariaLabel="Volume size" unit="mm" min={0.01} values={size} {...scrub((i, x) => setVolumeSize(objectId, v.id, i as 0 | 1 | 2, x, false))} />
    </div>
  )
}

export function ObjectVolumes() {
  const host = useHost()
  const entry = useApp((s) => s.plate.find((p) => p.id === s.selection))
  const plate = useApp((s) => s.plate)
  const selection = useApp((s) => s.selection)
  const others = useMemo(() => plate.filter((p) => p.id !== selection && !p.instanceOf), [plate, selection])
  const [role, setRole] = useState<VolumeRole>('negative')
  const [shape, setShape] = useState<PrimitiveShape>('box')
  const [open, setOpen] = useState<string | null>(null)
  if (!entry) return null
  const volumes = entry.volumes ?? []
  const run = (fn: () => Promise<string>) => void fn().then(setOpen).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'))
  return (
    <section className="obj-volumes" aria-label="Volumes" data-section="volumes">
      <h4 className="obj-volumes-h">Volumes</h4>
      {volumes.length === 0 ? <p className="sx-small sx-muted">Cut a hole, keep support out of a spot or force it in. Add a volume from a shape.</p> : null}
      <ul className="vol-list">
        {volumes.map((v) => (
          <li key={v.id}>
            <div className="vol-row">
              <i className="vol-dot" style={{ background: DOT[v.role] }} aria-hidden="true" />
              <button type="button" className="vol-name" aria-expanded={open === v.id} onClick={() => setOpen(open === v.id ? null : v.id)}>
                {v.name}
              </button>
              <Select id={`vr-${v.id}`} size="sm" aria-label={`Role of ${v.name}`} value={v.role} onChange={(e) => setVolumeRole(entry.id, v.id, e.target.value as VolumeRole)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </Select>
              <Button size="sm" variant="ghost" icon="copy" aria-label={`Copy ${v.name}`} tip="volume.copy" onClick={() => { copyVolume(entry.id, v.id); toast(`Copied ${v.name}`, 'info') }} />
              <Button size="sm" variant="ghost" icon="delete" aria-label={`Remove ${v.name}`} onClick={() => removeVolume(entry.id, v.id)} />
            </div>
            {open === v.id ? <VolumeFields objectId={entry.id} v={v} /> : null}
          </li>
        ))}
      </ul>
      <div className="vol-add">
        <Select id="vol-role" size="sm" aria-label="Volume type" value={role} onChange={(e) => setRole(e.target.value as VolumeRole)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </Select>
        <Select id="vol-shape" size="sm" aria-label="Volume shape" value={shape} onChange={(e) => setShape(e.target.value as PrimitiveShape)}>
          {SHAPES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
        <Button size="sm" icon="plus" onClick={() => run(() => addPrimitiveVolume(host.slicer, role, shape, entry.id))}>
          Add
        </Button>
      </div>
      {others.length ? (
        <div className="vol-add">
          <Select id="vol-from" size="sm" aria-label="Use another object as a volume" value="" onChange={(e) => e.target.value && run(() => useObjectAsVolume(host.slicer, role, e.target.value, entry.id))}>
            <option value="">Use another object as this type</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
    </section>
  )
}
