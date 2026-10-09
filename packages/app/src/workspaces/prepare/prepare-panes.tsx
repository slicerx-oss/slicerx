// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { degC } from '../../lib/temp'
import { printTarget, usePrinter } from '../../lib/use-printer'
import { filamentUnitName } from '@slicerx/printer-catalog'
import { isExportOnly } from '../../lib/hand-printers'
import { NozzlePicker } from './nozzle-picker'
import { EnergyRow } from './energy-row'
import { MoreButton, useMore } from '../../shell/more'
import type { PrinterState } from '@slicerx/contracts'
import { Block, Button, Icon, KeyValues, LinkButton, Pill, type PillState, tipAttrs } from '@slicerx/ui'
import { lazy, Suspense, useEffect, useMemo } from 'react'
import { useHost } from '../../host'
import { useFleet, type FleetRow } from '../../lib/queries'
import { formatCost, formatDuration, formatGrams } from '../../lib/preview-stats'
const PrinterSettingsDialog = lazy(() => import('./printer-settings').then((m) => ({ default: m.PrinterSettingsDialog })))
import { printerMinFlush } from '../../filament/flush'
import type { SettingValue } from '@slicerx/contracts'
import { estimateLine, slicedIn } from '../../lib/estimate-line'
import { printBlock } from '../../plate/heimdall'
import { sequenceProblem } from '../../plate/sequence-check'
import { AmsPanel } from '../../filament/ams-panel'
import { VendorMark } from '../../lib/vendor-mark'
import { useSliceNote } from '../../lib/slice-note'
import { cancelSlice, exportGcode, sendToPrinter, slicePlate } from '../../state/actions'
import type { LayoutSpec } from '@slicerx/contracts'
import { effectiveMode, openSetup, useLayout } from '../../first-run/look'
import { useFold } from '../../shell/fold'
import { useExpertVisible } from '../../first-run/mode-selector'
import { PlateList } from './plate-list'
import { PrepareObjects } from './objects-card'
import { activeMeta } from '../../plate/plates'
import { plateBedType } from '../../plate/bed-type'
import { resolveConfig } from '../../adapters/config'
import { get, set, showSliced, shownSlice, useApp } from '../../state/store'
import { GENERIC_BED } from '../../adapters/generic-bed'
import { useModelMode } from '../../state/model-mode'
import { EasySettingsPanel } from './easy-settings'
const ExpertSettings = lazy(() => import('./expert-settings').then((m) => ({ default: m.ExpertSettings })))

export { usePrinter }

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


function PrinterBlock() {
  const { rows, printer } = usePrinter()
  // In the store, so a note's "Change printer" can open it.
  const choosing = useApp((s) => s.printerChooserOpen)
  const setChoosing = (open: boolean) => set({ printerChooserOpen: open })
  const layout = useLayout()
  const showPrinterSettings = effectiveMode(useApp((s) => s.settingsMode), layout) !== 'simple'
  const printerSettingsOpen = useApp((s) => s.printerSettingsOpen)
  const more = useMore('printer')
  const profileNozzle = useApp((s) => s.profile?.nozzle ?? 0.4)
  const noPrinter = useApp((s) => s.noPrinter)
  const [open, setOpen] = useFold('printer')
  const meta = useApp(activeMeta)
  const easy = useApp((s) => s.easy)
  const overrides = useApp((s) => s.overrides)
  const profile = useApp((s) => s.profile)
  // The plate type the active plate prints on: its own, a project's, or the printer's default.
  const plate = useMemo(() => plateBedType(meta, resolveConfig(easy, overrides)), [meta, easy, overrides, profile])
  if (!printer) {
    return (
      <Block title="Printer" icon="printer" data-section="printer">
        <div className="printer-none">
          <p className="sx-muted sx-small" {...tipAttrs({ title: 'No printer yet', body: `Until you add one, slices are for a generic ${GENERIC_BED.widthMm} by ${GENERIC_BED.depthMm} mm bed, ${GENERIC_BED.heightMm} mm tall.` })}>
            Slicing for a generic {GENERIC_BED.widthMm} mm bed.
          </p>
          <Button icon="plus" onClick={() => openSetup('printer')}>
            Add your printer
          </Button>
          {noPrinter ? null : (
            <LinkButton onClick={() => set({ noPrinter: true })} {...tipAttrs({ title: 'Slice without a printer', body: 'Keeps the generic bed and stops opening printer setup at launch. Add a printer here any time.' })}>
              Slice without a printer
            </LinkButton>
          )}
        </div>
      </Block>
    )
  }
  const pill = printerPill(printer)
  const bed = printer.status.bed
  const bedTemp = bed && !isExportOnly(printer) && printer.status.state !== 'offline' ? bed.target || bed.current : 0
  const sub = isExportOnly(printer) ? 'No connection, exports G-code' : [printer.filamentSystem === 'ams' || printer.filamentSystem === 'mmu' ? `${filamentUnitName(printer.model, printer.filamentSystem)} connected` : null, printer.status.state].filter(Boolean).join(', ')
  return (
    <Block
      title="Printer"
      icon="printer"
      id="printer-fold"
      {...(setOpen ? { expanded: open, onExpandedChange: setOpen } : {})}
      data-section="printer"
      aside={
        open ? (
          <span className="fil-aside">
            {showPrinterSettings ? (
              <Button size="sm" variant="ghost" icon="sliders" aria-label="Printer settings" tip={{ title: 'Printer settings', body: 'Open the machine settings: bed shape, start and end G-code, limits.' }} onClick={() => set({ printerSettingsOpen: true })} />
            ) : null}
            <LinkButton expanded={choosing} onClick={() => setChoosing(!choosing)}>
              Change
            </LinkButton>
          </span>
        ) : (
          <span className="sec-sum">
            {printer.name}, {profileNozzle} mm, {pill.label}
          </span>
        )
      }
    >
      <div className="printer">
        <div className="printer-ic">
          <VendorMark vendor={printer.vendor} size={28} />
        </div>
        <div className="min0">
          <div className="printer-name">
            {printer.name} <span className="sx-muted">{printer.vendor} {printer.model}</span>
          </div>
          <div className="printer-sub">{more ? sub : `${profileNozzle} mm nozzle`}</div>
        </div>
        <Pill state={pill.state}>{pill.label}</Pill>
      </div>
      {choosing ? <NozzlePicker id="nozzle-card" /> : null}
      {choosing ? (
        <ul className="choose" aria-label="Choose a printer">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                aria-pressed={r.id === printer.id}
                onClick={() => {
                  set({ printerId: r.id })
                  setChoosing(false)
                }}
              >
                <span>
                  {r.name} <span className="sx-muted">{r.model}</span>
                </span>
                <Pill state={printerPill(r).state}>{printerPill(r).label}</Pill>
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className="choose-add"
              onClick={() => {
                setChoosing(false)
                openSetup('printer')
              }}
            >
              <span>Add printer</span>
              <Icon name="plus" size={14} />
            </button>
          </li>
        </ul>
      ) : null}
      {printerSettingsOpen ? (
        <Suspense fallback={null}>
          <PrinterSettingsDialog printer={printer} />
        </Suspense>
      ) : null}
      {more ? <KeyValues
        items={[
          { value: `${profileNozzle} mm`, label: 'Nozzle' },
          { value: <span data-testid="slice-machine-plate" {...tipAttrs({ title: plate.label, body: 'Set per plate. Change it in plate settings.' })}>{plate.label}</span>, label: 'Plate' },
          // An export-only or offline printer reports no bed, so the row goes rather than guessing.
          ...(bedTemp ? [{ value: degC(bedTemp), label: 'Bed' }] : []),
        ]}
      /> : null}
    </Block>
  )
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

/** The settings sidebar. The look and feel decides where the object list and the mode selector sit. */
export function PrepareLeft({ layout }: { layout: LayoutSpec }) {
  const expertOpen = useApp((s) => s.expertOpen)
  const overrides = useApp((s) => Object.keys(s.overrides).length)
  const expertVisible = useExpertVisible(layout)
  const mode = effectiveMode(useApp((s) => s.settingsMode), layout)
  const tierTitle = mode === 'expert' || mode === 'developer' ? 'Expert settings' : 'Advanced settings'
  const objectsFirst = layout.objectList === 'sidebar-above-settings'
  // Design has no printer, filament or print settings: it models parts; Slice sets them up for printing.
  const design = useModelMode() === 'design'
  return (
    <>
      {objectsFirst ? <PrepareObjects /> : null}
      {design ? null : (
        <>
          <PrinterBlock />
          <FilamentBlock />
          {layout.objectList === 'sidebar-after-filament' ? <PrepareObjects /> : null}
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
      {objectsFirst || (!design && layout.objectList === 'sidebar-after-filament') ? null : <PrepareObjects />}
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
  // With Auto slice on there is no Slice button: Print is the action, ready once the background slice is current. It opens
  // the Print sheet on that printer; without one it shows the preview, where the G-code export lives.
  const primary = auto ? (
    printer && isExportOnly(printer) ? (
      <Button variant="primary" size="lg" full icon="sd-card" disabled={plate.length === 0 || !fresh} onClick={() => void exportGcode(host)}>
        Export G-code
      </Button>
    ) : (
      <Button variant="primary" size="lg" full icon="send-to-printer" disabled={plate.length === 0 || !fresh} onClick={() => (target ? void sendToPrinter(host, target) : showSliced())}>
        Print
      </Button>
    )
  ) : (
    <Button variant="primary" size="lg" full icon="slice" disabled={plate.length === 0} onClick={() => void slicePlate(host).then(() => get().slice.status === 'done' && showSliced())}>
      {done && !done.stale ? 'Slice again' : label}
    </Button>
  )
  const grams = done ? done.result.stats.filamentG.reduce((a, b) => a + b, 0) : 0
  const line = estimateLine(done)
  const progress = slice.status === 'running' ? slice.progress : null
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
  // Before a slice, the sidebar footer shows one muted line above the button instead of a section.
  if (compact && !done && slice.status !== 'running') {
    return (
      <div className="slice-lite" data-section="estimate">
        <p className="est-line">{plate.length ? (auto ? 'Time, filament and cost appear after the first slice.' : 'Slice to see time, filament and cost.') : 'Add a model to the plate.'}</p>
        {primary}
        {problems}
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
        <p className="est-sub">{plate.length ? 'Slice to see print time, filament and cost.' : 'Add a model to the plate.'}</p>
      )}
      {/* A background slice keeps the action in place and shows its progress on the block's top edge, so nothing moves. */}
      {slice.status === 'running' && auto && done ? (
        <div className="slicing-edge" role="status" aria-label="Slicing">
          <i style={{ transform: `scaleX(${progress ? Math.max(0.04, progress.fraction) : 0.04})` }} />
        </div>
      ) : null}
      {slice.status === 'running' && !(auto && done) ? (
        <div className="slicing" role="status">
          <div className="app-bar-track">
            <i style={{ transform: `scaleX(${progress ? Math.max(0.04, progress.fraction) : 0.04})` }} />
          </div>
          <div className="app-row between">
            <span className="sx-mono sx-small sx-muted">{progress ? `Stage: ${progress.stage}` : 'Starting'}</span>
            <Button size="sm" variant="ghost" onClick={() => cancelSlice()}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        primary
      )}
      {problems}
      {sliceNote ? <p className="app-note">{sliceNote}</p> : null}
    </Block>
  )
}

export { PrepareObjects }
