// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Presets: the printer, filament and process presets you saved. Save what you changed under a
// name, apply, rename, delete, export (our JSON, or an Orca and Bambu Studio profile) and import.
import { Button, Input } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { useHost } from '../host'
import { toast, useApp } from '../state/store'
import { applyPreset, capture, deletePreset, exportOrcaJson, exportPresetJson, KIND_LABEL, KINDS, loadPresets, mergeSyncText, renamePreset, reportPresetError, savePreset, saveSyncFile, updatePreset } from './presets'
import type { ImportResult } from './import-result'
import { ImportReportView } from './import-report'
import { describeChange } from './sync'
import { ComparePanel } from './compare-panel'
import type { PresetKind, UserPreset } from './store'
import { appName } from '../edition'

function Row({ p, active }: { p: UserPreset; active: boolean }) {
  const host = useHost()
  const [name, setName] = useState<string | null>(null)
  const changed = Object.keys(p.values).length
  const save = (data: string, file: string) => void host.files.save(file, new Blob([data], { type: 'application/json' }), { accept: ['.json'] }).catch(reportPresetError)
  const fileBase = p.name.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '_') || 'preset'
  return (
    <li className="preset-row" data-active={active ? 'true' : undefined}>
      {name === null ? (
        <span className="preset-name">
          <b>{p.name}</b>
          <small>
            {changed} {changed === 1 ? 'setting' : 'settings'}
            {p.printer ? <span className="preset-for">, for {p.printer}</span> : null}
            {active ? ', in use' : ''}
          </small>
        </span>
      ) : (
        <Input id={`pn-${p.id}`} aria-label={`New name for ${p.name}`} value={name} autoFocus maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => {
          if (e.key === 'Enter') void renamePreset(p.id, name).then(() => setName(null)).catch(reportPresetError)
          if (e.key === 'Escape') setName(null)
        }} />
      )}
      <span className="preset-act">
        <Button size="sm" variant="ghost" disabled={active} onClick={() => applyPreset(p.id)}>
          Use
        </Button>
        <Button size="sm" variant="ghost" tip="preset.update" onClick={() => void updatePreset(p.id).then(() => toast(`Updated ${p.name}`, 'ok')).catch(reportPresetError)}>
          Update
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setName(name === null ? p.name : null)}>
          Rename
        </Button>
        <Button size="sm" variant="ghost" onClick={() => save(exportPresetJson(p), `${fileBase}.slicerx-preset.json`)}>
          Export
        </Button>
        <Button size="sm" variant="ghost" tip="preset.export" onClick={() => save(exportOrcaJson(p), `${fileBase}.json`)}>
          Export for Orca
        </Button>
        <Button size="sm" variant="ghost" icon="delete" aria-label={`Delete ${p.name}`} onClick={() => void deletePreset(p.id).catch(reportPresetError)} />
      </span>
    </li>
  )
}

function Group({ kind }: { kind: PresetKind }) {
  const presets = useApp((s) => s.userPresets)
  const activeId = useApp((s) => s.activePresets[kind])
  const changed = useApp((s) => Object.keys(capture(kind, s).values).length)
  const [name, setName] = useState('')
  const list = presets.filter((p) => p.kind === kind)
  return (
    <section className="preset-group" aria-label={`${KIND_LABEL[kind]} presets`}>
      <h4 className="set-sub">{KIND_LABEL[kind]} presets</h4>
      {list.length ? (
        <ul className="preset-list">
          {list.map((p) => (
            <Row key={p.id} p={p} active={p.id === activeId} />
          ))}
        </ul>
      ) : (
        <p className="sx-small sx-muted">None saved yet.</p>
      )}
      <form
        className="preset-save"
        onSubmit={(e) => {
          e.preventDefault()
          void savePreset(kind, name).then((p) => {
            setName('')
            toast(`Saved ${p.name}`, 'ok')
          }, reportPresetError)
        }}
      >
        <label className="sr-only" htmlFor={`ps-${kind}`}>
          Name for a new {kind} preset
        </label>
        <Input id={`ps-${kind}`} placeholder={`Name, for the ${changed} changed ${kind === 'process' ? 'print' : kind} ${changed === 1 ? 'setting' : 'settings'}`} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" size="sm" disabled={changed === 0 && kind !== 'process'}>
          Save
        </Button>
      </form>
    </section>
  )
}

export function PresetsSection() {
  const host = useHost()
  const [imported, setImported] = useState<ImportResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void loadPresets().catch(reportPresetError)
  }, [])
  const importFiles = async () => {
    setBusy(true)
    try {
      const { importPickedFiles } = await import('../first-run/preset-import')
      const results = await importPickedFiles(host, null)
      if (results.length) setImported(results)
    } catch (e) {
      reportPresetError(e)
    } finally {
      setBusy(false)
    }
  }
  const sync = useApp((s) => s.presetSync)
  const [applied, setApplied] = useState<string[] | null>(null)
  const mergeFile = async () => {
    try {
      const [ref] = await host.files.open({ accept: ['.json'] })
      if (!ref) return
      const changes = await mergeSyncText(new TextDecoder().decode(await host.files.read(ref)))
      setApplied(changes.map(describeChange))
    } catch (e) {
      reportPresetError(e)
    }
  }
  return (
    <section className="set-sec" aria-labelledby="presets-h">
      <h3 id="presets-h">Presets</h3>
      <p className="sx-small sx-muted">A preset keeps the settings you changed, under a name. Presets stay on this device.</p>
      <div className="preset-import">
        <Button size="sm" icon="import" disabled={busy} onClick={() => void importFiles()}>
          {busy ? 'Importing' : 'Import presets'}
        </Button>
        <span className="sx-small sx-muted">{appName()}, OrcaSlicer, Bambu Studio and PrusaSlicer presets, and OrcaSlicer and Bambu Studio preset bundles.</span>
      </div>
      {imported ? <ImportReportView results={imported} /> : null}
      {KINDS.map((k) => (
        <Group key={k} kind={k} />
      ))}
      <ComparePanel />
      <section className="preset-group" aria-labelledby="presets-sync-h">
        <h4 className="set-sub" id="presets-sync-h">Sync without an account</h4>
        <p className="sx-small sx-muted">
          Save your presets to a sync file and keep it anywhere you like: a git repository, a synced folder or your own server. Merge the file on another computer. The newer edit of each preset wins, and every change is written down below.
        </p>
        <div className="preset-import">
          <Button size="sm" icon="export" onClick={() => void saveSyncFile(host).catch(reportPresetError)}>
            Save sync file
          </Button>
          <Button size="sm" icon="import" onClick={() => void mergeFile()}>
            Merge a sync file
          </Button>
        </div>
        {applied ? (
          <p className="sx-small" role="status">
            {applied.length ? applied.join(' ') : 'Nothing to change. Both sides already match.'}
          </p>
        ) : null}
        {sync.changes.length ? (
          <details className="preset-notes">
            <summary>Change notes ({sync.changes.length})</summary>
            <ul className="sx-small">
              {[...sync.changes].reverse().slice(0, 30).map((c, i) => (
                <li key={`${c.at}-${c.id}-${i}`}>
                  <span className="sx-mono sx-dim">{new Date(c.at).toLocaleDateString()}</span> {describeChange(c)}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>
    </section>
  )
}
