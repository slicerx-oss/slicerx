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

export { SliceBlock } from './estimate-footer'
