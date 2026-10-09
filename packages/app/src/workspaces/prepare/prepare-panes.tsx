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
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useHost } from '../../host'
import { useFleet, type FleetRow } from '../../lib/queries'
import { formatCost, formatDuration, formatGrams } from '../../lib/preview-stats'
const PrinterSettingsDialog = lazy(() => import('./printer-settings').then((m) => ({ default: m.PrinterSettingsDialog })))
import { printerMinFlush } from '../../filament/flush'
import type { SettingValue } from '@slicerx/contracts'
import { useResolvedSlots } from '../../filament/use-slots'
import { effectiveSlot } from '../../filament/slots'
import { useFitWatch } from '../../plate/fit-check'
import { moveObject, objectWarnings, renameObject, searchObjects, setPartSlot, toggleLock, togglePrintable } from '../../plate/object-list'
import { printBlock } from '../../plate/heimdall'
import { sequenceProblem } from '../../plate/sequence-check'
import { removeVolume, ROLE_LABEL } from '../../plate/volumes'
import { AmsPanel } from '../../filament/ams-panel'
import { Silhouette, Swatch } from '../../parts'
import { VendorMark } from '../../lib/vendor-mark'
import { useSliceNote } from '../../lib/slice-note'
import { cancelSlice, exportGcode, openModelFiles, sendToPrinter, slicePlate } from '../../state/actions'
import type { LayoutSpec } from '@slicerx/contracts'
import { effectiveMode, openSetup, useLayout } from '../../first-run/look'
import { useFold } from '../../shell/fold'
import { ModeSelector, useExpertVisible } from '../../first-run/mode-selector'
import { ObjectActions } from './object-actions'
const ObjectSettings = lazy(() => import('./object-settings').then((m) => ({ default: m.ObjectSettings })))
import { ObjectTransform } from './object-transform'
// Fit check notes: their code loads with the first object list, not at startup.
const FitNotes = lazy(() => import('./fit-notes').then((m) => ({ default: m.FitNotes })))
const BrimEarsPanel = lazy(() => import('./brim-ears-panel').then((m) => ({ default: m.BrimEarsPanel })))
const CadPanel = lazy(() => import('../../cad/cad-panel').then((m) => ({ default: m.CadPanel })))
const HistoryPanel = lazy(() => import('../../cad/history/history-panel').then((m) => ({ default: m.HistoryPanel })))
const CutPanel = lazy(() => import('./cut-panel').then((m) => ({ default: m.CutPanel })))
const PaintPanel = lazy(() => import('./paint-panel').then((m) => ({ default: m.PaintPanel })))
import { useTool } from '../../plate/tools'
const ObjectVolumes = lazy(() => import('./object-volumes').then((m) => ({ default: m.ObjectVolumes })))
import { PlateList } from './plate-list'
import { activeMeta } from '../../plate/plates'
import { plateBedType } from '../../plate/bed-type'
import { resolveConfig } from '../../adapters/config'
import { selectObject } from '../../plate/edit'
import { get, isCadTool, selectedIds, set, setWorkspace, showSliced, shownSlice, useApp } from '../../state/store'
import { GENERIC_BED } from '../../adapters/generic-bed'
import { useModelMode } from '../../state/model-mode'
import { EasySettingsPanel } from './easy-settings'
const ExpertSettings = lazy(() => import('./expert-settings').then((m) => ({ default: m.ExpertSettings })))

const DRAG_TYPE = 'text/x-sx-object'

export const VOL_DOT = { negative: 'var(--red)', support_blocker: 'var(--orange)', support_enforcer: 'var(--green)', modifier: 'var(--cyan)' } as const

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
  const tool = useTool()
  const objectTool = useApp((s) => s.objectTool)
  const expertOpen = useApp((s) => s.expertOpen)
  const overrides = useApp((s) => Object.keys(s.overrides).length)
  const expertVisible = useExpertVisible(layout)
  const mode = effectiveMode(useApp((s) => s.settingsMode), layout)
  const tierTitle = mode === 'expert' || mode === 'developer' ? 'Expert settings' : 'Advanced settings'
  const objectsFirst = layout.objectList === 'sidebar-above-settings'
  // Design has no printer, filament or print settings: it models parts; Slice sets them up for printing.
  const design = useModelMode() === 'design'
  // A history step opened for editing gets a fresh panel, even when the same tool is already open.
  const editKey = useApp((s) => (s.historyEdit ? `:${s.historyEdit.objectId}:${s.historyEdit.index}` : ''))
  return (
    <>
      {objectsFirst ? <PrepareObjects /> : null}
      {isCadTool(objectTool) ? <Suspense fallback={null}><CadPanel key={objectTool + editKey} tool={objectTool} /></Suspense> : null}
      {objectTool === 'cut' ? <Suspense fallback={null}><CutPanel /></Suspense> : null}
      {tool === 'paint' ? <Suspense fallback={null}><PaintPanel /></Suspense> : null}
      {tool === 'brim' ? <Suspense fallback={null}><BrimEarsPanel /></Suspense> : null}
      {design ? null : (
        <>
          <PrinterBlock />
          <FilamentBlock />
          {layout.objectList === 'sidebar-after-filament' ? <PrepareObjects /> : null}
          <Block
            title="Print settings"
            icon="sliders"
            aside={
              layout.modeSelector === 'sidebar' ? (
                <ModeSelector layout={layout} id="mode-side" />
              ) : expertVisible ? (
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

/** Objects on the plate, with add buttons. */
export function PrepareObjects() {
  const host = useHost()
  const plate = useApp((s) => s.plate)
  const selection = useApp((s) => s.selection)
  const multi = useApp((s) => s.selectedIds)
  const selected = selectedIds({ selection, selectedIds: multi })
  const [expanded, setExpanded] = useState<string | null>(null)
  const slotTotal = useResolvedSlots().length
  const bed = useApp((s) => s.bed)
  const printerSlots = useApp((s) => s.printerSlots)
  const [dropOn, setDropOn] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const more = useMore('object')
  // The CAD history list loads only for a selected object that has one (or whose step is open).
  const historyOf = useApp((s) => (s.historyEdit ? s.historyEdit.objectId : s.plate.find((p) => p.id === s.selection)?.history ? s.selection : null))
  const names = new Map(plate.map((p) => [p.id, p.name]))
  useFitWatch()
  const matches = new Map(searchObjects(plate, query).map((m) => [m.id, m]))
  const searching = query.trim() !== ''
  return (
    <Block title="Objects" icon="cube" data-section="objects">
      {plate.length > 1 ? (
        <input className="sx-input obj-search" data-testid="objects-search" type="search" value={query} placeholder="Search objects and parts" aria-label="Search objects and parts" onChange={(e) => setQuery(e.target.value)} />
      ) : null}
      {searching && matches.size === 0 ? <p className="sx-small sx-muted">Nothing on the plate matches "{query.trim()}".</p> : null}
      <ul className="objs" data-testid="objects-list">
        {plate.map((p, index) => matches.has(p.id) && (
          <li
            key={p.id}
            data-testid="object-row"
            data-object-id={p.id}
            className={`${selected.includes(p.id) ? 'obj sel' : 'obj'}${p.printable === false ? ' off' : ''}${dropOn === p.id ? ' drop' : ''}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, p.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragEnd={() => setDropOn(null)}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
              e.preventDefault()
              setDropOn(p.id)
            }}
            onDragLeave={() => setDropOn((cur) => (cur === p.id ? null : cur))}
            onDrop={(e) => {
              e.preventDefault()
              setDropOn(null)
              const id = e.dataTransfer.getData(DRAG_TYPE)
              if (id) moveObject(id, index)
            }}
          >
            <div className="obj-row">
            <button
              type="button"
              className="obj-h"
              data-testid="object-select"
              aria-expanded={expanded === p.id}
              aria-pressed={selected.includes(p.id)}
              onClick={(e) => {
                const additive = e.metaKey || e.ctrlKey || e.shiftKey
                selectObject(p.id, additive)
                if (!additive) setExpanded(expanded === p.id ? null : p.id)
              }}
            >
              <span className="obj-thumb">{p.thumb ? <img src={p.thumb} alt="" /> : p.parts.length ? <Silhouette parts={p.parts} /> : null}</span>
              <span className="min0">
                <span className="obj-name" data-testid="object-name">{p.name}</span>
                <span className="obj-meta">
                  {p.instanceOf ? `Instance of ${names.get(p.instanceOf) ?? p.name}` : `${p.handle.parts.length} parts, ${p.handle.triangles.toLocaleString('en-US')} tris`}
                </span>
                {objectWarnings(p, { bed, printerSlots }).map((w) => (
                  <span key={w.kind} className="obj-warn" data-testid="object-warning" data-kind={w.kind} {...tipAttrs({ title: w.text })}>
                    <Icon name="alert" size={11} /> {w.text}
                  </span>
                ))}
              </span>
              <span className="obj-chev" {...tipAttrs({ title: expanded === p.id ? 'Hide details' : 'Details', body: 'Rename it, reorder it and pick a filament for each part.' })}>
                <Icon name="chevron-down" />
              </span>
            </button>
            <Button size="sm" variant="ghost" icon={p.locked ? 'lock' : 'unlock'} data-testid="object-lock" aria-label={`${p.locked ? 'Unlock' : 'Lock'} ${p.name}`} tip={{ title: p.locked ? 'Locked' : 'Lock', body: p.locked ? 'Click to let it move again.' : 'Keep it from moving, scaling or arranging.' }} pressed={Boolean(p.locked)} onClick={() => toggleLock([p.id])} />
            <Button size="sm" variant="ghost" icon={p.printable === false ? 'hide' : 'show'} data-testid="object-printable" aria-label={`${p.printable === false ? 'Print' : 'Do not print'} ${p.name}`} tip={{ title: p.printable === false ? 'Not printed' : 'Printed', body: p.printable === false ? 'Click to print it again.' : 'Click to leave it out of the print.', key: 'V' }} pressed={p.printable === false} onClick={() => togglePrintable([p.id])} />
            </div>
            <Suspense fallback={null}>
              <FitNotes id={p.id} />
            </Suspense>
            {expanded === p.id || (searching && !matches.get(p.id)?.self) ? (
              <div className="obj-detail">
                <label className="obj-rename" htmlFor={`rn-${p.id}`}>
                  <span className="sx-small sx-muted">Name</span>
                  <input id={`rn-${p.id}`} className="sx-input" data-testid="object-rename" defaultValue={p.name} maxLength={100} key={p.name} onBlur={(e) => { if (!renameObject(p.id, e.currentTarget.value)) e.currentTarget.value = p.name }} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
                </label>
                <div className="obj-order">
                  <Button size="sm" variant="ghost" icon="arrow-up" aria-label={`Move ${p.name} up`} disabled={index === 0} onClick={() => moveObject(p.id, index - 1)} />
                  <Button size="sm" variant="ghost" icon="arrow-down" aria-label={`Move ${p.name} down`} disabled={index === plate.length - 1} onClick={() => moveObject(p.id, index + 1)} />
                  <span className="sx-small sx-muted">Position {index + 1} of {plate.length}. Drag a row to reorder.</span>
                </div>
                <ul className="parts">
                  {p.handle.parts.map((part, i) => !matches.get(p.id)?.parts.includes(i) ? null : (
                    <li key={`${part.name}-${i}`} className="part">
                      <Swatch color={p.colors[i] ?? 'var(--dim)'} size="sm" />
                      <span className="n">{part.name}</span>
                      <label className="sr-only" htmlFor={`ps-${p.id}-${i}`}>
                        Filament for {part.name}
                      </label>
                      <select id={`ps-${p.id}-${i}`} className="mini" data-testid="object-part-slot" value={effectiveSlot(p, part)} onChange={(e) => setPartSlot(p.id, part.name, Number(e.target.value))}>
                        {Array.from({ length: Math.max(4, slotTotal, effectiveSlot(p, part)) }, (_, k) => (
                          <option key={k + 1} value={k + 1}>
                            Filament {k + 1}
                          </option>
                        ))}
                      </select>
                    </li>
                  ))}
                  {(p.volumes ?? []).map((v) => !matches.get(p.id)?.volumes.includes(v.id) ? null : (
                    <li key={v.id} className="part vol">
                      <i className="vol-dot" style={{ background: VOL_DOT[v.role] }} aria-hidden="true" />
                      <span className="n">{v.name}</span>
                      <span className="sx-small sx-dim">{ROLE_LABEL[v.role]}</span>
                      <Button size="sm" variant="ghost" icon="delete" aria-label={`Remove ${v.name} from ${p.name}`} onClick={() => removeVolume(p.id, v.id)} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="plate-actions">
        <Button size="sm" variant="ghost" icon="plus" data-testid="objects-add-model" onClick={() => void openModelFiles(host, { fresh: false })}>
          Add model
        </Button>
        {more ? (
          <Button size="sm" variant="ghost" icon="library" data-testid="objects-from-vault" onClick={() => setWorkspace('library')}>
            From the Vault
          </Button>
        ) : null}
        <ObjectActions />
      </div>
      <ObjectTransform />
      {historyOf ? <Suspense fallback={null}><HistoryPanel objectId={historyOf} /></Suspense> : null}
      {more ? (
        <>
          <Suspense fallback={null}>
            <ObjectVolumes />
          </Suspense>
          <Suspense fallback={null}>
            <ObjectSettings />
          </Suspense>
        </>
      ) : null}
    </Block>
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
          <div className="est-time">{formatDuration(done.result.stats.timeS)}</div>
          <div className="est-sub">
            {done.result.layerCount} layers, sliced in {Math.round(done.result.wallMs)} ms
          </div>
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
            <div>
              <dt>Warnings</dt>
              <dd>{done.result.warnings.length}</dd>
            </div>
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
      <p className="app-note">{sliceNote ?? (host.kind === 'desktop' ? `Slices natively on ${host.capabilities.threads} threads.` : `Slices in your browser on ${host.capabilities.threads} worker threads.`)}</p>
    </Block>
  )
}
