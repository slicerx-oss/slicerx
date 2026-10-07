// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { spoolFor, spoolLabel, shortfalls, useSpools } from '../../inventory/spools'
import { MoreButton, useMore } from '../../shell/more'
import { SLICE_STAGES, type FeatureId } from '@slicerx/contracts'
import { Block, Button, Icon, LinkButton, tipAttrs } from '@slicerx/ui'
import { useEffect, useMemo, useState } from 'react'
import { resolveConfig } from '../../adapters/config'
import { loadSettings, settingsIfLoaded, type SettingsApi } from '../../adapters/load'
import { useHost } from '../../host'
import { formatCost, formatDuration, formatGrams, previewStats, timeRows } from '../../lib/preview-stats'
import { Swatch } from '../../parts'
import { printBlock } from '../../plate/heimdall'
import { resolveSlots } from '../../filament/slots'
import { exportGcode, recordSpoolUse, sendToPrinter } from '../../state/actions'
import { setWorkspace, shownSlice, useApp } from '../../state/store'
import { useTabLabel } from '../../first-run/look'
import { usePrinter } from '../prepare/prepare-panes'
import { printTarget } from '../../lib/use-printer'
import { isExportOnly } from '../../lib/hand-printers'
import { featureStyle } from './preview-hud'
import { fixApplies, jumpToWarning, runWarningFix, warningFix } from '../../lib/warning-actions'
import { repairSelected } from '../../plate/geom-ops'
import { closeGcodeFile, setGcodePanel, useGcodeView } from './gcode-file'
import { CollisionList } from './strike-slots'

/** A G-code file opened on its own: what it is, and the way back to the plate. */
function GcodeFileBlock() {
  const file = useGcodeView((s) => s.file)
  const preview = useApp((s) => s.preview)
  if (!file) return null
  const meters = file.filamentMm.reduce((a, b) => a + b, 0) / 1000
  return (
    <Block title="G-code file" aside={<span className="app-tag">Viewing</span>} data-section="result">
      <p className="result-line">
        <Icon name="list" />
        <span {...tipAttrs({ title: file.name })}>{file.name}</span>
      </p>
      <p className="app-note">
        {preview ? `${preview.layerCount} layers, ` : ''}
        {file.lines.toLocaleString('en-US')} lines, {(file.bytes / 1e6).toFixed(1)} MB. About {formatDuration(file.timeS)} and {meters.toFixed(2)} m of filament, estimated from the moves without acceleration.
      </p>
      <div className="app-row gap8">
        <Button size="sm" icon="list" onClick={() => setGcodePanel(true)}>
          Show the G-code
        </Button>
        <Button size="sm" variant="ghost" icon="close" onClick={() => void closeGcodeFile()}>
          Close the file
        </Button>
      </div>
    </Block>
  )
}

/** Key, label, and how the slicer's warnings name it when it could not apply the setting. */
const USED: [string, string, RegExp | null][] = [
  ['layer_height', 'Layer height', null],
  ['wall_loops', 'Walls', null],
  ['sparse_infill_density', 'Sparse infill', null],
  ['sparse_infill_pattern', 'Infill pattern', /infill/i],
  ['outer_wall_speed', 'Outer wall speed', null],
  ['brim_width', 'Brim', null],
  ['enable_support', 'Supports', /support/i],
]

/** What the slicer actually used when a warning says it fell back ("... using rectilinear"). */
function effective(message: string): string {
  const using = /using ([\w -]+?)(?:[.;,]|$)/i.exec(message)?.[1]
  if (using) return using
  return /not generated|not available|ignored/i.test(message) ? 'not applied' : 'changed'
}

export function PreviewLeft() {
  const host = useHost()
  const tab = useTabLabel('prepare')
  const slice = useApp((s) => s.slice)
  const preview = useApp((s) => s.preview)
  const resume = useApp((s) => s.resume)
  const easy = useApp((s) => s.easy)
  const overrides = useApp((s) => s.overrides)
  const config = useMemo(() => resolveConfig(easy, overrides), [easy, overrides])
  // Names and units of settings come from the full schema, which loads the first time a warning needs them.
  const [schema, setSchema] = useState<SettingsApi | null>(settingsIfLoaded)
  useEffect(() => {
    if (!schema) void loadSettings().then(setSchema)
  }, [schema])
  const more = useMore('preview')
  useApp((s) => s.appearance.colorVision)
  const show = (key: string, c: typeof config) => (schema ? schema.show(key, c) : String((c as Record<string, unknown>)[key] ?? ''))
  const file = useGcodeView((s) => s.file)
  if (file) return <GcodeFileBlock />
  const shown = shownSlice(slice)
  if (!shown || !preview) {
    return (
      <Block title="Sliced plate" data-section="result">
        <p className="sx-muted sx-small">{slice.status === 'running' ? 'Slicing now.' : 'Nothing sliced yet.'}</p>
      </Block>
    )
  }
  const r = shown.result
  const stats = previewStats(preview)
  // The rows add up to the estimate: the printing split by feature, and the start before the first layer.
  const rows = timeRows(stats.features, r.stats.timeS, r.stats.prepareS).map((row) =>
    row.key === 'start'
      ? { ...row, color: 'var(--dim)', label: 'Heating, homing and purge' }
      : { ...row, color: featureStyle(Number(row.key) as FeatureId).color, label: featureStyle(Number(row.key) as FeatureId).label },
  )
  const totalStage = SLICE_STAGES.reduce((a, st) => a + (r.stageMicros[st] ?? 0), 0) || 1
  return (
    <>
      <CollisionList />
      <Block title="Sliced plate" aside={<span className="fil-aside"><span className={shown.stale ? 'app-tag stale' : 'app-tag'}>{shown.stale ? (slice.status === 'running' ? 'Updating' : 'Settings changed') : 'Current'}</span><MoreButton id="preview" /></span>} data-section="result">
        <p className="result-line">
          <Icon name="check" />
          Sliced {r.layerCount} layers in {(r.wallMs / 1000).toFixed(2)} s
        </p>
        {resume && resume.plan.resumeLayer > 0 ? (
          <p className="result-line" data-resume>
            <Icon name="layers" />
            Resumes at layer {resume.plan.resumeLayer + 1}, {resume.plan.printedHeightMm.toFixed(2)} mm up. The layers below are already on the bed.
          </p>
        ) : null}
        <p className="app-note">
          {preview.segmentCount.toLocaleString('en-US')} toolpath segments from the {r.engine === 'sx' ? 'sx' : 'Orca'} engine.
          {r.warnings.length ? ` ${r.warnings.length} ${r.warnings.length === 1 ? 'warning' : 'warnings'}.` : ' No warnings.'}
        </p>
        <div className="stagebar" role="img" aria-label="Time per slicing stage">
          {SLICE_STAGES.map((st) => {
            const us = r.stageMicros[st] ?? 0
            return us > 0 ? <i key={st} style={{ flexGrow: us / totalStage }} {...tipAttrs({ title: st, body: `${(us / 1000).toFixed(1)} ms` })} /> : null
          })}
        </div>
        {r.warnings.length ? (
          <ul className="warns">
            {r.warnings.map((w, i) => {
              const fix = fixApplies(w) ? warningFix(w) : null
              return (
                <li key={`${w.code}-${i}`}>
                  <button type="button" className="warn-jump" aria-label={`Show warning: ${w.message}`} {...tipAttrs({ title: w.layer !== undefined ? `Layer ${w.layer + 1}` : 'Warning', body: 'Click to show it in the preview.' })} onClick={() => jumpToWarning(w)}>
                    <Icon name="alert" />
                    <span>{w.message}</span>
                  </button>
                  {fix ? (
                    <Button size="sm" onClick={() => void runWarningFix(w, () => repairSelected(host.slicer))}>
                      {fix.label}
                    </Button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}
      </Block>
      {more ? <Block title="Where the time goes" data-section="time">
        <div className="est-time">{formatDuration(r.stats.timeS)}</div>
        <div className="bars" aria-hidden="true">
          {rows.map((f) => (
            <i key={f.key} style={{ flexGrow: f.seconds, background: f.color }} />
          ))}
        </div>
        <ul className="tlist">
          {rows.map((f) => (
            <li key={f.key}>
              <i style={{ background: f.color }} />
              <span>{f.label}</span>
              <b>{formatDuration(f.seconds)}</b>
              <em>{f.seconds / (r.stats.timeS || 1) < 0.01 ? '<1%' : `${Math.round((f.seconds / (r.stats.timeS || 1)) * 100)}%`}</em>
            </li>
          ))}
        </ul>
      </Block> : null}
      {more ? <Block title="Settings used" aside={<LinkButton onClick={() => setWorkspace('prepare')}>Edit in {tab}</LinkButton>} data-section="used">
        <dl className="used">
          {USED.map(([k, label, match]) => {
            const w = match ? r.warnings.find((x) => match.test(x.message)) : undefined
            return (
              <div key={k}>
                <dt>{label}</dt>
                {w ? (
                  <dd className="warn" {...tipAttrs({ title: w.message, body: `Set: ${show(k, config)}` })}>
                    <Icon name="alert" size={13} /> {effective(w.message)}
                  </dd>
                ) : (
                  <dd>{show(k, config)}</dd>
                )}
              </div>
            )
          })}
        </dl>
      </Block> : null}
    </>
  )
}

export function PreviewRight() {
  const host = useHost()
  const slice = useApp((s) => s.slice)
  // The swatches are the slots' colors, as the slice used them; a string, so the selector stays stable.
  const slotColors = useApp((s) => resolveSlots(s).map((r) => r.color).join())
  const { printer, rows } = usePrinter()
  const spools = useSpools(host)
  const links = useApp((s) => s.spoolLinks)
  // A strike in the slice, or by object objects moved too close or too tall since it: Print and Export wait.
  const unsafe = useApp(printBlock)
  const shown = shownSlice(slice)
  // The result on screen while a new slice runs is the last one: its file is not the plate's, so Print and Export wait.
  const updating = slice.status === 'running'
  if (!shown) {
    return (
      <Block title="Filament use" data-section="filament">
        <p className="sx-muted sx-small">Appears after slicing.</p>
        {unsafe !== null ? (
          <p className="app-err" role="alert">
            {unsafe}
          </p>
        ) : null}
      </Block>
    )
  }
  const r = shown.result
  const colors = slotColors.split(',')
  const grams = r.stats.filamentG.reduce((a, b) => a + b, 0)
  const target = printTarget(printer, rows)
  const spoolOf = (slot: number) => spoolFor(slot, spools, links, printer?.status.slots[slot - 1]?.spoolmanId)
  const short = shortfalls(r.stats.filamentG, spoolOf)
  const uses = r.stats.filamentG.flatMap((g, i) => {
    const sp = spoolOf(i + 1)
    return sp && g > 0 ? [{ spoolId: sp.id, label: spoolLabel(sp), grams: g }] : []
  })
  return (
    <>
      <Block title="Filament use" aside={`${r.stats.filamentG.length} ${r.stats.filamentG.length === 1 ? 'slot' : 'slots'}`} data-section="filament">
        <ul className="fuse">
          {r.stats.filamentG.map((g, i) => (
            <li key={i}>
              <Swatch color={colors[i] ?? 'var(--dim)'} />
              <span>
                {printer?.status.slots[i]?.id ?? `Slot ${i + 1}`} {printer?.status.slots[i]?.material ?? 'PLA Basic'}
                <small>tool {i + 1}</small>
              </span>
              <b>
                {g > 0 ? `${g.toFixed(1)} g` : `${((r.stats.filamentMm[i] ?? 0) / 1000).toFixed(2)} m`}<small>{g > 0 ? `${((r.stats.filamentMm[i] ?? 0) / 1000).toFixed(2)} m` : 'weight not estimated'}</small>
              </b>
            </li>
          ))}
        </ul>
        {short.map((x) => (
          <p key={x.slot} className="support-line" role="alert">
            <Icon name="alert" />
            {spoolLabel(x.spool)} has {Math.round(x.haveG)} g left and this plate needs {x.needG.toFixed(0)} g.
          </p>
        ))}
        {uses.length > 0 ? (
          <Button size="sm" variant="ghost" icon="spool" tip={{ title: 'Record use', body: 'Subtract this plate from the linked spools in Spoolman, after you approve.' }} onClick={() => void recordSpoolUse(host, uses)}>
            Record use in Spoolman
          </Button>
        ) : null}
      </Block>
      <Block title="Totals" data-section="totals">
        <dl className="est-grid">
          <div>
            <dt>Filament</dt>
            <dd className={grams > 0 ? undefined : 'na'}>{formatGrams(grams)}</dd>
          </div>
          <div>
            <dt>Cost</dt>
            <dd className={r.stats.cost > 0 ? undefined : 'na'}>{formatCost(r.stats.cost)}</dd>
          </div>
          <div>
            <dt>Filament changes</dt>
            <dd>{r.stats.toolChanges}</dd>
          </div>
          <div>
            <dt>Layers</dt>
            <dd>{r.layerCount}</dd>
          </div>
        </dl>
        {printer && isExportOnly(printer) ? (
          <>
            <Button variant="primary" size="lg" full icon="sd-card" disabled={unsafe !== null || updating} onClick={() => void exportGcode(host)}>
              {`Export for ${printer.name}`}
            </Button>
            <p className="app-note">No connection. Save the file and copy it to the printer on a USB stick or SD card.</p>
          </>
        ) : (
          <>
            <Button variant="primary" size="lg" full icon="send-to-printer" aria-label={target ? `Print on ${target.name}` : undefined} disabled={!target || unsafe !== null || updating} onClick={() => target && void sendToPrinter(host, target)}>
              {target ? 'Print' : 'No idle printer'}
            </Button>
            {target ? <p className="app-note">On {target.name}{target.name !== target.model ? `, ${target.model}` : ''}</p> : null}
            <div className="app-row gap8">
              <Button size="sm" icon="download" disabled={unsafe !== null || updating} onClick={() => void exportGcode(host)}>
                Export G-code
              </Button>
            </div>
            {target ? null : <p className="app-note">Printers that finish a job show up here.</p>}
            {unsafe !== null ? (
              <p className="app-err" role="alert">
                {unsafe}
              </p>
            ) : null}
          </>
        )}
      </Block>
    </>
  )
}
