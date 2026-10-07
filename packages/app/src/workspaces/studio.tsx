// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate tab: Design and Slice share one viewport, so switching never rebuilds the scene; the panes around it
// change with the mode. Slice shows the slice in place (toolpaths by default), with the layer dock and the slice summary.
import { lazy, Suspense, useEffect, useRef, type CSSProperties } from 'react'
import { ColorMenu, RenderMenu, ViewMenu } from './view-menus'
import { useLayout, useLookChoice } from '../first-run/look'
import { registerCommands } from '../commands/registry'
import { history } from '../plate/history'
import { bindPlateKeys } from '../plate/keys'
import { pasteFromSystem } from '../plate/paste-system'
import { plateCommands } from '../plate/commands'
import { PlateToolbar } from './prepare/plate-toolbar'
import { PlateList } from './prepare/plate-list'
import { useHost } from '../host'
import { SidePane, type PaneSection } from '../shell/pane'
import { seedExamplePlate } from '../state/actions'
import { get, showsLayers, useApp } from '../state/store'
import { ViewportHost } from '../viewport/viewport-host'
import { LayerStrip } from './layer-strip'
import { ZoneLegend } from './zone-legend'
import { PrepareLeft, SliceBlock } from './prepare/prepare-panes'
import { LayerDock, Legend } from './preview/preview-hud'
import { PreviewLeft, PreviewRight } from './preview/preview-panes'
import { useGcodeView } from './preview/gcode-file'
import { trackPlateSlices } from './preview/plate-slices'
import { PreviewPlates } from './preview/preview-plates'
import { railKey, useModelMode } from '../state/model-mode'
import { setTool, toolStore, useTool } from '../plate/tools'
import { warmFullEngine } from '../geom/full-engine'
import { useBoundValues } from './prepare/object-tools'
import { SliceLookSwitch } from './prepare/slice-look'
import { ParkedChip } from './prepare/parked-chip'
import { SliceProgress } from './slice-progress'

const PREPARE_LEFT: PaneSection[] = [
  { id: 'printer', icon: 'printer', label: 'Printer' },
  { id: 'filament', icon: 'spool', label: 'Filament' },
  { id: 'settings', icon: 'sliders', label: 'Print settings' },
  { id: 'objects', icon: 'prepare', label: 'Objects' },
]
const PREVIEW_RIGHT: PaneSection[] = [
  { id: 'result', icon: 'slice', label: 'Sliced plate' },
  { id: 'filament', icon: 'spool', label: 'Filament use' },
  { id: 'totals', icon: 'weight', label: 'Totals' },
]

const PLATES_SECTION: PaneSection = { id: 'plates', icon: 'plates', label: 'Plates' }
const DESIGN_TREE: PaneSection[] = [{ id: 'objects', icon: 'history', label: 'Model' }]
const DESIGN_TOOL: PaneSection[] = [{ id: 'transform', icon: 'move', label: 'Transform' }]

// Design's panes load the first time Design opens, so Slice users never download them.
const DesignLeft = lazy(() => import('./design/design-panes').then((m) => ({ default: m.DesignLeft })))
const DesignRight = lazy(() => import('./design/design-panes').then((m) => ({ default: m.DesignRight })))
const Shelf = lazy(() => import('./design/design-panes').then((m) => ({ default: m.Shelf })))
const DesignTimeline = lazy(() => import('./design/design-panes').then((m) => ({ default: m.DesignTimeline })))

// norn (edit from Preview) loads with the first click on a toolpath.
const NornLayer = lazy(() => import('../norn/norn-layer').then((m) => ({ default: m.NornLayer })))
// The G-code line view loads when it is first opened.
const GcodePanel = lazy(() => import('./preview/gcode-panel').then((m) => ({ default: m.GcodePanel })))

export function Studio() {
  const host = useHost()
  const hasPreview = useApp((s) => s.preview !== null)
  const nornOn = useApp((s) => s.norn.pick !== null || s.norn.before !== null)
  const gcodeOn = useGcodeView((s) => s.panel)
  const plate = useApp((s) => s.plate)
  const plateLoading = useApp((s) => s.plateLoading)
  const layout = useLayout()
  const plateName = useApp((s) => s.plates.find((p) => p.id === s.activePlate)?.name ?? 'Plate 1')
  const manyPlates = useApp((s) => s.plates.length > 1)
  // The look and feel places the settings sidebar, its width, and the primary Slice action.
  const side = layout.sidebar.side
  const sliceInSidebar = layout.primaryAction.placement === 'sidebar-footer'
  const modelMode = useModelMode()
  useBoundValues(true)
  const design = modelMode === 'design'
  // Slice shows the sliced toolpaths in place of the models (the default look); the layer dock, legend and color menu come with them.
  // Painting, brim ears and lay on face work on the solid models, so the layers step aside while one is on.
  const plateTool = useTool()
  const surfaceTool = plateTool === 'paint' || plateTool === 'brim' || plateTool === 'face'
  const layers = useApp((s) => showsLayers(s)) && !design && !surfaceTool
  // Whether the slice on screen is the plate as it is now: tests and styles read it from the studio.
  const sliceState = useApp((s) => (s.slice.status === 'done' ? (s.slice.stale ? 'stale' : 'current') : s.slice.status))
  const slicesDone = useApp((s) => s.slicesDone)
  const other = side === 'left' ? 'right' : 'left'

  // Painting, brim ears and lay on face are print setup: they close when Design opens.
  // The full geometry engine starts loading on the way into Design, so its first tool does not wait.
  useEffect(() => {
    if (!design) return
    if (['paint', 'brim', 'face'].includes(toolStore.getState().tool)) setTool('move')
    warmFullEngine()
  }, [design])

  // A modeling tool left open when Design closed opens again as it was (cad/park.ts).
  useEffect(() => {
    if (design && get().parked) void import('../cad/park').then((p) => p.resume(host.slicer))
  }, [design, host])

  useEffect(() => {
    const s = get()
    if (s.plate.length === 0 && !s.plateLoading) void seedExamplePlate(host)
  }, [host])

  // Each plate keeps its slice while another one is in view.
  useEffect(() => trackPlateSlices(), [])

  // Plate keys follow the look and feel's keymap; undo starts recording as soon as the studio opens.
  const choice = useLookChoice()
  const choiceRef = useRef(choice)
  choiceRef.current = choice
  useEffect(() => {
    history()
    const offKeys = bindPlateKeys(() => choiceRef.current, { onPaste: (e) => void pasteFromSystem(host, e) })
    const offCommands = registerCommands(plateCommands(() => choiceRef.current, host))
    return () => {
      offKeys()
      offCommands()
    }
  }, [host])

  const selected = plate[0]

  return (
    <div className="studio" data-mode="prepare" data-layers={layers || undefined} data-slice={sliceState} data-slices={slicesDone} data-model-mode={design ? 'design' : undefined} data-sidebar={side} style={{ '--w-settings': `${layout.sidebar.width}px` } as CSSProperties}>
      {design ? (
        <Suspense fallback={<div className="shelf" aria-hidden="true" />}>
          <Shelf />
        </Suspense>
      ) : null}
      {design ? (
        <SidePane key={`design-${side}`} side={side} ws={railKey('prepare', 'design')} label="Model" sections={DESIGN_TREE} width={280}>
          <Suspense fallback={<div className="ws-loading" aria-busy="true" />}>
            <DesignLeft />
          </Suspense>
        </SidePane>
      ) : (
        <SidePane key={`prepare-${side}`} side={side} ws="prepare" label="Printer and settings" sections={PREPARE_LEFT} width={layout.sidebar.width} {...(sliceInSidebar ? { footer: <SliceBlock label={layout.primaryAction.label} compact /> } : {})}>
          <PrepareLeft layout={layout} />
        </SidePane>
      )}

      <section className="vp" aria-label="Plate">
        <ViewportHost layers={layers} />
        <SliceProgress />
        {design || !hasPreview ? null : <SliceLookSwitch />}
        {design ? null : <ParkedChip />}
        <div className="hud hud-top">
          <div className="hud-col">
            <RenderMenu />
            {layers ? (
              <>
                <ColorMenu />
                <Legend />
              </>
            ) : null}
          </div>
          <div className="hud-col end">
            <ViewMenu />
          </div>
        </div>

        <div className="hud hud-bl">
          {design || layout.plateList === 'sidebar' ? null : <PlateList layout={layout} />}
          {design ? null : (
            <div className="platechip sx-overlay">
              <b>{plateName}</b>
              <span>{selected ? selected.name : plateLoading ? 'Loading' : 'Empty'}</span>
              {plate.length > 1 ? <span>+{plate.length - 1}</span> : null}
            </div>
          )}
          {selected ? (
            <div className="dims sx-overlay sx-mono" aria-label="Model size">
              {selected.handle.bboxMm.map((v) => v.toFixed(1)).join(' x ')} mm
            </div>
          ) : null}
        </div>

        {design ? null : <PlateToolbar layout={layout} />}
        {!design && !sliceInSidebar ? (
          <div className="slice-float sx-overlay">
            <SliceBlock label={layout.primaryAction.label} compact />
          </div>
        ) : null}
        {layers ? <LayerDock /> : null}
        {layers && gcodeOn ? (
          <Suspense fallback={null}>
            <GcodePanel />
          </Suspense>
        ) : null}
        {layers && nornOn ? (
          <Suspense fallback={null}>
            <NornLayer />
          </Suspense>
        ) : null}
        {design ? (
          <Suspense fallback={null}>
            <DesignTimeline />
          </Suspense>
        ) : null}
        {design ? null : (
          <>
            <LayerStrip />
            <ZoneLegend layers={layers} />
          </>
        )}
      </section>

      {design ? (
        <SidePane key={`design-${other}`} side={other} ws={railKey('prepare', 'design')} label="Tool and transform" sections={DESIGN_TOOL} width={312}>
          <Suspense fallback={<div className="ws-loading" aria-busy="true" />}>
            <DesignRight />
          </Suspense>
        </SidePane>
      ) : hasPreview ? (
        <SidePane key={`sliced-${other}`} side={other} ws="preview" label="Slice summary and filament" sections={manyPlates ? [PLATES_SECTION, ...PREVIEW_RIGHT] : PREVIEW_RIGHT} width={312}>
          <PreviewPlates />
          <PreviewLeft />
          <PreviewRight />
        </SidePane>
      ) : null}
    </div>
  )
}
