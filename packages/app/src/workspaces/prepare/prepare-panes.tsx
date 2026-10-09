// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { printTarget, usePrinter } from '../../lib/use-printer'
import { isExportOnly } from '../../lib/hand-printers'
import { EnergyRow } from './energy-row'
import { MoreButton, useMore } from '../../shell/more'
import type { PrinterState } from '@slicerx/contracts'
import { Block, Button, Icon, LinkButton, type PillState, tipAttrs } from '@slicerx/ui'
import { lazy, Suspense, useEffect, useState, type CSSProperties } from 'react'
import { useWaited } from '../../lib/waited'
import './slice-track.css'
import './slice-sidebar.css'
import { sliceFraction } from '../slice-progress'
import { useHost } from '../../host'
import { useFleet, type FleetRow } from '../../lib/queries'
import { formatCost, formatDuration, formatGrams } from '../../lib/preview-stats'
import { printerMinFlush } from '../../filament/flush'
import type { SettingValue } from '@slicerx/contracts'
import { useResolvedSlots } from '../../filament/use-slots'
import { slotLabel } from '../../filament/rail'
import { estimateLine, partCount, slicedIn, triangles } from '../../lib/estimate-line'
import { effectiveSlot } from '../../filament/slots'
import { moveObject, objectWarnings, renameObject, searchObjects, setPartSlot, toggleLock, togglePrintable } from '../../plate/object-list'
import { printBlock } from '../../plate/heimdall'
import { sequenceProblem } from '../../plate/sequence-check'
import { removeVolume, ROLE_LABEL } from '../../plate/volumes'
import { AmsPanel } from '../../filament/ams-panel'
import { Silhouette, Swatch } from '../../parts'
import { useSliceNote } from '../../lib/slice-note'
import { cancelSlice, exportGcode, openModelFiles, sendToPrinter, slicePlate } from '../../state/actions'
import type { LayoutSpec } from '@slicerx/contracts'
import { effectiveMode, useLayout } from '../../first-run/look'
import { useExpertVisible } from '../../first-run/mode-selector'
import { PrepareObjects } from './objects-card'
import { ObjectTransform } from './object-transform'
// Fit check notes: their code loads with the first object list, not at startup.
const SliceGlide = lazy(() => import('../../ravens/waits').then((m) => ({ default: m.SliceGlide })))
import { useTool } from '../../plate/tools'
import { PlateList } from './plate-list'
import { MachineCard } from './machine-card'
import { selectObject } from '../../plate/edit'
import { get, isCadTool, selectedIds, set, setWorkspace, showSliced, shownSlice, useApp } from '../../state/store'
import { useModelMode } from '../../state/model-mode'
import { useMediaQuery } from '../../lib/media'
import { MiddleName, shortPrinterName } from '../../lib/short-name'
import { EasySettingsPanel } from './easy-settings'
const ExpertSettings = lazy(() => import('./expert-settings').then((m) => ({ default: m.ExpertSettings })))



export { usePrinter, PrepareObjects }

export const PRINTER_PILL: Record<PrinterState, { state: PillState; label: string }> = {
  idle: { state: 'ok', label: 'Ready' },
  finished: { state: 'ok', label: 'Ready' },
  preparing: { state: 'run', label: 'Preparing' },
  printing: { state: 'run', label: 'Printing' },
  paused: { state: 'warn', label: 'Paused' },
  error: { state: 'bad', label: 'Error' },
  offline: { state: 'off', label: 'Offline' },
}

/** The pill for a printer row: one added with no connection says so instead of Ready. */
export function printerPill(r: FleetRow): { state: PillState; label: string } {
  return isExportOnly(r) ? { state: 'off', label: 'Export only' } : PRINTER_PILL[r.status.state]
}


function FilamentBlock() {
  const { printer } = usePrinter()
  const slots = printer?.status.slots
  // The slot panel and the slicer read the printer's slots from the store.
  useEffect(() => {
    set({ printerSlots: slots ?? [] })
  }, [slots])
  // The printer profile's nozzle volume is the base of the flush volumes; the profile data loads on demand.
  const vendor = printer?.vendor
  const model = printer?.model
  useEffect(() => {
    let stale = false
    void import('./printer-base').then(({ printerBase }) => {
      if (stale) return
      set({ printerNozzleVolume: printerMinFlush((printerBase(vendor && model ? { vendor, model } : undefined) as Record<string, SettingValue>)['nozzle_volume']) })
    })
    return () => {
      stale = true
    }
  }, [vendor, model])
  return <AmsPanel maker={printer?.vendor ?? ''} system={printer?.filamentSystem} />
}

/** The top of the settings sidebar: the printer and the filaments stay in view while the settings under them scroll. */
export function SlicePinned() {
  // Design models parts: it has no printer or filament.
  if (useModelMode() === 'design') return null
  return (
    <>
      <MachineCard />
      <FilamentBlock />
    </>
  )
}

/** The settings sidebar. The look and feel decides where the object list and the mode selector sit. */
export function PrepareLeft({ layout }: { layout: LayoutSpec }) {
  const expertOpen = useApp((s) => s.expertOpen)
  const overrides = useApp((s) => Object.keys(s.overrides).length)
  const expertVisible = useExpertVisible(layout)
  const mode = effectiveMode(useApp((s) => s.settingsMode), layout)
  const tierTitle = mode === 'expert' || mode === 'developer' ? 'Expert settings' : 'Advanced settings'
  // With the objects in the right pane, a phone keeps them here: its panes are sheets, one at a time.
  const phone = useMediaQuery('(max-width: 900px)')
  const objectList = layout.objectList === 'right-pane' ? (phone ? 'sidebar-below-settings' : 'right-pane') : layout.objectList
  const objectsFirst = objectList === 'sidebar-above-settings'
  // Design has no printer, filament or print settings: it models parts; Slice sets them up for printing.
  const design = useModelMode() === 'design'
  return (
    <>
      {/* A phone's sheet scrolls as one, so the printer and filaments lead it instead of sitting pinned. */}
      {phone ? <SlicePinned /> : null}
      {objectsFirst ? <PrepareObjects /> : null}
      {design ? null : (
        <>
          {objectList === 'sidebar-after-filament' ? <PrepareObjects /> : null}
          <Block
            title="Print settings"
            icon="sliders"
            aside={
              // The mode chip in the pane title sets the mode where the look puts it in the sidebar.
              layout.modeSelector !== 'sidebar' && expertVisible ? (
              <LinkButton
                icon="sliders"
                onClick={() => {
                  set({ expertOpen: true })
                  requestAnimationFrame(() => document.getElementById('expert-toggle')?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
                }}
              >
                {overrides ? `Expert (${overrides})` : 'Expert'}
              </LinkButton>
              ) : undefined
            }
            data-section="settings"
          >
            <EasySettingsPanel />
          </Block>
          {expertVisible ? (
            <Block title={tierTitle} icon="settings" expanded={expertOpen} onExpandedChange={(v) => set({ expertOpen: v })} id="expert-toggle" data-section="expert">
              {expertOpen ? (
                <Suspense fallback={<div className="ws-loading" aria-busy="true" />}>
                  <ExpertSettings />
                </Suspense>
              ) : null}
            </Block>
          ) : null}
        </>
      )}
      {objectsFirst || objectList === 'right-pane' || (!design && objectList === 'sidebar-after-filament') ? null : <PrepareObjects />}
      {layout.plateList === 'sidebar' ? <PlateList layout={layout} /> : null}
    </>
  )
}

/** The estimate and the primary Slice action. `label` comes from the look and feel. */
export function SliceBlock({ label = 'Slice plate', compact }: { label?: string; compact?: boolean }) {
  const host = useHost()
  const sliceNote = useSliceNote()
  const slice = useApp((s) => s.slice)
  const plate = useApp((s) => s.plate)
  const auto = useApp((s) => s.autoSlice)
  // While a new slice runs the last one stays, stale, so the estimate never empties and comes back.
  const done = shownSlice(slice)
  // A strike in the slice holds Print and Export back. Before a slice, objects closer or taller than the printer
  // profile allows by object are a heads-up: heimdall checks every move when the plate slices.
  const unsafe = useApp(printBlock)
  const heads = useApp(sequenceProblem)
  const fresh = done !== null && !done.stale && unsafe === null
  const { printer, rows } = usePrinter()
  const target = printTarget(printer, rows)
  // Slice and Print wait while a model is still loading; everything else, Export included, stays usable.
  const loading = useApp((s) => s.plateLoading)
  const waitTip = (title: string) => (loading ? { tip: { title, reason: 'The model is still loading.' } } : {})
  // With Auto slice on there is no Slice button: Print is the action, ready once the background slice is current. It opens
  // the Print sheet on that printer; without one it shows the preview, where the G-code export lives.
  // With Auto slice off, Slice is the action until the plate has a current slice; then Print is, as with Auto slice
  // on (the slice summary has no Print of its own), and Slice again sits on the estimate line.
  const current = done !== null && !done.stale
  const primary = auto || current ? (
    printer && isExportOnly(printer) ? (
      <Button variant="primary" size="lg" full icon="sd-card" disabled={plate.length === 0 || !fresh} onClick={() => void exportGcode(host)}>
        Export G-code
      </Button>
    ) : (
      <Button variant="primary" size="lg" full icon="send-to-printer" disabled={plate.length === 0 || !fresh || loading} aria-label={target ? `Print on ${target.name}` : 'Print'} {...(loading ? waitTip('Print') : target ? { tip: { title: `Print on ${target.name}` } } : {})} onClick={() => (target ? void sendToPrinter(host, target) : showSliced())}>
        {target ? (
          <span className="btn-name">
            Print on <MiddleName name={shortPrinterName(target.name)} />
          </span>
        ) : (
          'Print'
        )}
      </Button>
    )
  ) : (
    <Button variant="primary" size="lg" full icon="slice" disabled={plate.length === 0 || loading} {...waitTip(label)} onClick={() => void slicePlate(host).then(() => get().slice.status === 'done' && showSliced())}>
      {done && !done.stale ? 'Slice again' : label}
    </Button>
  )
  const grams = done ? done.result.stats.filamentG.reduce((a, b) => a + b, 0) : 0
  const line = estimateLine(done)
  const progress = slice.status === 'running' ? slice.progress : null
  // A slice past about 1.2 s gets muninn riding its bar.
  const longSlice = useWaited(slice.status === 'running')
  // Why Print or Export is held back: the by-object check, and a slice that failed. Both footers show them.
  const problems = (
    <>
      {unsafe !== null ? (
        <p className="app-err" role="alert">
          {unsafe}
        </p>
      ) : heads !== null && !done ? (
        <p className="app-note">{heads}</p>
      ) : null}
      {slice.status === 'error' ? <p className="app-err">{slice.message}</p> : null}
    </>
  )
  const running = slice.status === 'running'
  // A slice in progress takes the button's place in a track of the button's own height, so the footer never moves
  // when a slice starts or ends; muninn rides the bar in the track's top row, clear of the text above.
  const track = (
    <div className="slice-track" role="status" aria-label={progress ? `Slicing, ${progress.stage}` : 'Slicing'} data-testid="slice-track">
      <div className="rv-ride" style={{ '--p': Math.max(0.04, sliceFraction(progress)) } as CSSProperties}>
        <div className="app-bar-track">
          <i style={{ transform: `scaleX(${Math.max(0.04, sliceFraction(progress))})` }} />
        </div>
        {longSlice ? <Suspense fallback={null}><SliceGlide done={false} /></Suspense> : null}
      </div>
      <Button size="sm" variant="ghost" onClick={() => cancelSlice()}>
        Cancel
      </Button>
    </div>
  )
  const stageLine = progress ? `Slicing: ${progress.stage}` : 'Slicing'
  // Before a first slice, and while it runs, the sidebar footer shows one muted line above the button or the track
  // instead of a section.
  if (compact && !done) {
    return (
      <div className="slice-lite" data-section="estimate">
        <p className="est-line">{running ? stageLine : plate.length ? (auto ? 'Time, filament and cost appear after the first slice.' : 'Slice to see time, filament and cost.') : 'Add a model to the plate.'}</p>
        {running ? track : primary}
        {problems}
      </div>
    )
  }
  // In the sidebar footer a finished slice is one line over the button, so the settings above keep their room.
  if (compact && done) {
    return (
      <div className="slice-lite slice-done" data-section="estimate">
        <p className="est-row">
          <span className="est-time" {...tipAttrs({ title: slicedIn(done.result.wallMs, host.capabilities.threads) })}>
            {formatDuration(done.result.stats.timeS)}
          </span>
          <span className="est-sub">
            {done.result.layerCount} layers{grams > 0 ? `, ${formatGrams(grams)}` : ''}
          </span>
          {!auto && current && !running ? (
            <Button size="sm" variant="ghost" icon="slice" className="est-again" onClick={() => void slicePlate(host).then(() => get().slice.status === 'done' && showSliced())}>
              Slice again
            </Button>
          ) : (
            <span className={done.stale ? 'app-tag stale' : 'app-tag'}>{done.stale ? (auto ? 'Updating' : 'Settings changed') : 'From slice'}</span>
          )}
        </p>
        {slice.status === 'running' && auto ? (
          <div className="slicing-edge" role="status" aria-label="Slicing">
            <i style={{ transform: `scaleX(${Math.max(0.04, sliceFraction(progress))})` }} />
          </div>
        ) : null}
        {running && !auto ? track : primary}
        {problems}
        {sliceNote ? <p className="app-note">{sliceNote}</p> : null}
      </div>
    )
  }
  return (
    <Block title="Estimate" className={compact ? 'slice-block compact' : 'slice-block'} aside={done ? <span className={done.stale ? 'app-tag stale' : 'app-tag'}>{done.stale ? (auto ? 'Updating' : 'Settings changed') : 'From slice'}</span> : undefined} data-section="estimate">
      {done ? (
        <>
          <div className="est-time" {...tipAttrs({ title: slicedIn(done.result.wallMs, host.capabilities.threads) })}>
            {formatDuration(done.result.stats.timeS)}
          </div>
          <div className="est-sub">{done.result.layerCount} layers</div>
          <dl className="est-grid">
            <div>
              <dt>Filament</dt>
              <dd>{formatGrams(grams)}</dd>
            </div>
            <div>
              <dt>Cost</dt>
              <dd>{formatCost(done.result.stats.cost)}</dd>
            </div>
            <EnergyRow timeS={done.result.stats.timeS} />
            <div>
              <dt>Filament changes</dt>
              <dd>{done.result.stats.toolChanges}</dd>
            </div>
            {line?.warnings ? (
              <div>
                <dt>Warnings</dt>
                <dd>{done.result.warnings.length}</dd>
              </div>
            ) : null}
          </dl>
        </>
      ) : (
        <p className="est-sub">{running ? stageLine : plate.length ? 'Slice to see print time, filament and cost.' : 'Add a model to the plate.'}</p>
      )}
      {/* A background slice keeps the action in place and shows its progress on the block's top edge, so nothing moves. */}
      {slice.status === 'running' && auto && done ? (
        <div className="slicing-edge" role="status" aria-label="Slicing">
          <i style={{ transform: `scaleX(${Math.max(0.04, sliceFraction(progress))})` }} />
        </div>
      ) : null}
      {running && !(auto && done) ? track : primary}
      {problems}
      {sliceNote ? <p className="app-note">{sliceNote}</p> : null}
    </Block>
  )
}
