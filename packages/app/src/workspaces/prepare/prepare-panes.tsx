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
import { ObjectActions } from './object-actions'
const ObjectSettings = lazy(() => import('./object-settings').then((m) => ({ default: m.ObjectSettings })))
import { ObjectTransform } from './object-transform'
// Fit check notes: their code loads with the first object list, not at startup.
const SliceGlide = lazy(() => import('../../ravens/waits').then((m) => ({ default: m.SliceGlide })))
const FitNotes = lazy(() => import('./fit-notes').then((m) => ({ default: m.FitNotes })))
const BrimEarsPanel = lazy(() => import('./brim-ears-panel').then((m) => ({ default: m.BrimEarsPanel })))
const CadPanel = lazy(() => import('../../cad/cad-panel').then((m) => ({ default: m.CadPanel })))
const HistoryPanel = lazy(() => import('../../cad/history/history-panel').then((m) => ({ default: m.HistoryPanel })))
const CutPanel = lazy(() => import('./cut-panel').then((m) => ({ default: m.CutPanel })))
const PaintPanel = lazy(() => import('./paint-panel').then((m) => ({ default: m.PaintPanel })))
import { useTool } from '../../plate/tools'
const ObjectVolumes = lazy(() => import('./object-volumes').then((m) => ({ default: m.ObjectVolumes })))
import { PlateList } from './plate-list'
import { MachineCard } from './machine-card'
import { selectObject } from '../../plate/edit'
import { get, isCadTool, selectedIds, set, setWorkspace, showSliced, shownSlice, useApp } from '../../state/store'
import { useModelMode } from '../../state/model-mode'
import { useMediaQuery } from '../../lib/media'
import { MiddleName } from '../../lib/short-name'
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
  const tool = useTool()
  const objectTool = useApp((s) => s.objectTool)
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
  // A history step opened for editing gets a fresh panel, even when the same tool is already open.
  const editKey = useApp((s) => (s.historyEdit ? `:${s.historyEdit.objectId}:${s.historyEdit.index}` : ''))
  return (
    <>
      {/* A phone's sheet scrolls as one, so the printer and filaments lead it instead of sitting pinned. */}
      {phone ? <SlicePinned /> : null}
      {objectsFirst ? <PrepareObjects /> : null}
      {isCadTool(objectTool) ? <Suspense fallback={null}><CadPanel key={objectTool + editKey} tool={objectTool} /></Suspense> : null}
      {objectTool === 'cut' ? <Suspense fallback={null}><CutPanel /></Suspense> : null}
      {tool === 'paint' ? <Suspense fallback={null}><PaintPanel /></Suspense> : null}
      {tool === 'brim' ? <Suspense fallback={null}><BrimEarsPanel /></Suspense> : null}
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

/** Objects on the plate, with add buttons. */
export function PrepareObjects() {
  const host = useHost()
  const plate = useApp((s) => s.plate)
  const selection = useApp((s) => s.selection)
  const multi = useApp((s) => s.selectedIds)
  const selected = selectedIds({ selection, selectedIds: multi })
  const [expanded, setExpanded] = useState<string | null>(null)
  const slotList = useResolvedSlots()
  const slotTotal = slotList.length
  // Triangle counts are engine detail: in the row's tooltip, and inline only in Developer mode.
  const developer = effectiveMode(useApp((s) => s.settingsMode), useLayout()) === 'developer'
  const bed = useApp((s) => s.bed)
  const printerSlots = useApp((s) => s.printerSlots)
  const [dropOn, setDropOn] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const more = useMore('object')
  // The CAD history list loads only for a selected object that has one (or whose step is open).
  const historyOf = useApp((s) => (s.historyEdit ? s.historyEdit.objectId : s.plate.find((p) => p.id === s.selection)?.history ? s.selection : null))
  const names = new Map(plate.map((p) => [p.id, p.name]))
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
                <span className="obj-name" data-testid="object-name" {...tipAttrs({ title: p.name })}><MiddleName name={p.name} /></span>
                <span className="obj-meta" {...tipAttrs({ title: triangles(p.handle.triangles) })}>
                  {p.instanceOf ? `Instance of ${names.get(p.instanceOf) ?? p.name}` : partCount(p.handle.parts.length)}
                  {developer ? `, ${triangles(p.handle.triangles)}` : null}
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
                            {slotList[k] ? slotLabel(slotList[k]) : `${k + 1}, not set up`}
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

export { SliceBlock } from './estimate-footer'
