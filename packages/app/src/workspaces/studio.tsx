// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate tabs: mimir, Design and Slice share one viewport, so switching never rebuilds the scene; the panes around
// it change with the mode. mimir and Design show the same design; mimir puts the chat beside it in place of the panes. Slice shows the slice in place (toolpaths by default), with the layer dock and the slice summary.
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { RenderMenu, ViewMenu } from './view-menus'
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
import { fixedLength, type UnitPrefs } from '../cad/units'
import { get, isCadTool, railOpen, setRail, showsLayers, useApp, type PlateEntry } from '../state/store'
import { bounds, sizeOf } from '../plate/transform'
import { usePrinter } from '../lib/use-printer'
import { useRightAttention } from '../lib/right-attention'
import { ViewportHost } from '../viewport/viewport-host'
import { ZoneLegend } from './zone-legend'
import { PrepareLeft, PrepareObjects, SlicePinned, SliceBlock } from './prepare/prepare-panes'
import { LayerDock, Legend } from './preview/preview-hud'
import { PreviewLeft, PreviewRight } from './preview/preview-panes'
import { useGcodeView } from './preview/gcode-file'
import { trackPlateSlices } from './preview/plate-slices'
import { startMeshRelease } from '../plate/mesh-release'
import { startTimeline } from '../plate/timeline'
import { startSliceRelease } from './preview/slice-release'
import { PreviewPlates } from './preview/preview-plates'
import { railKey, useModelMode } from '../state/model-mode'
import { setTool, toolStore, useTool } from '../plate/tools'
import { warmFullEngine } from '../geom/full-engine'
import { useBoundValues } from './prepare/object-tools'
import { SliceLookSwitch } from './prepare/slice-look'
import { PlateToolsGroup } from './prepare/plate-tools-group'
import { ParkedChip } from './prepare/parked-chip'
import { ViewSelectionMenu } from './prepare/selection-bar'
import { SliceProgress } from './slice-progress'
import { useOverlayOffset, type OverlaySelectors } from '../lib/overlay-offset'
import { useCompactLayout, usePhoneLayout } from '../lib/phone-layout'
import { ModeChip } from '../first-run/mode-chip'
import { Loading } from '../shell/loading'

const PREPARE_LEFT: PaneSection[] = [
  { id: 'printer', icon: 'section-printer', label: 'Printer' },
  { id: 'filament', icon: 'spool', label: 'Filament' },
  { id: 'settings', icon: 'section-print-settings', label: 'Print settings' },
]
const OBJECTS_SECTION: PaneSection = { id: 'objects', icon: 'prepare', label: 'Objects' }
const PREVIEW_RIGHT: PaneSection[] = [
  { id: 'result', icon: 'slice', label: 'Sliced plate' },
  { id: 'filament', icon: 'spool', label: 'Filament use' },
  { id: 'totals', icon: 'weight', label: 'Totals' },
]

/**
 * The viewport controls toasts keep off: bottom bars, the top toolbar and view switch, and on a phone an open sheet,
 * which a toast floats above rather than over.
 */
// With the toolpaths, the color legend runs down the left under the top row: the toast keeps to its right.
// mimir's sizes panel runs down the right while a sheet is up: the toast keeps to its left, off Build and Cancel.
const OVERLAYS: OverlaySelectors = { bottom: '.hud-bl, .dock, .bpanel-body', top: '.plate-tools, .slice-look, .hud-top .hud-row, .hud-top .hud-col.end', left: '.hud-top .legend', side: '.mimir-sheet-panel' }
const PHONE_OVERLAYS: OverlaySelectors = { ...OVERLAYS, cover: '.pane.sheet.sheet-open' }

const PLATES_SECTION: PaneSection = { id: 'plates', icon: 'plates', label: 'Plates' }
const DESIGN_TREE: PaneSection[] = [{ id: 'objects', icon: 'history', label: 'Model' }]
const DESIGN_TOOL: PaneSection[] = [{ id: 'transform', icon: 'move', label: 'Transform' }]

// Design's panes load the first time Design opens, so Slice users never download them.
// The picture a project shows while it opens; its code loads with the view, not with the app.
const OpeningPicture = lazy(() => import('../project/opening-preview').then((m) => ({ default: m.OpeningPicture })))
const DesignLeft = lazy(() => import('./design/design-panes').then((m) => ({ default: m.DesignLeft })))
const DesignRight = lazy(() => import('./design/design-panes').then((m) => ({ default: m.DesignRight })))
const Shelf = lazy(() => import('./design/design-panes').then((m) => ({ default: m.Shelf })))
const DesignTimeline = lazy(() => import('./design/design-panes').then((m) => ({ default: m.DesignTimeline })))
const SelectPill = lazy(() => import('./design/design-panes').then((m) => ({ default: m.SelectPill })))
const PhoneShelf = lazy(() => import('./design/design-panes').then((m) => ({ default: m.PhoneShelf })))
const PhoneUndo = lazy(() => import('./design/design-panes').then((m) => ({ default: m.PhoneUndo })))
const PhoneHandles = lazy(() => import('./design/design-panes').then((m) => ({ default: m.PhoneHandles })))
// mimir's chat and view caption load the first time its tab opens.
const MimirChat = lazy(() => import('./mimir/mimir-panes').then((m) => ({ default: m.MimirChat })))
const MimirCaption = lazy(() => import('./mimir/mimir-panes').then((m) => ({ default: m.MimirCaption })))
const LookupCards = lazy(() => import('./mimir/lookup-cards').then((m) => ({ default: m.LookupCards })))
const MimirSheet = lazy(() => import('./mimir/sheet-view').then((m) => ({ default: m.MimirSheet })))

// norn (edit from Preview) loads with the first click on a toolpath.
const NornLayer = lazy(() => import('../norn/norn-layer').then((m) => ({ default: m.NornLayer })))
// The G-code line view loads when it is first opened.
const GcodePanel = lazy(() => import('./preview/gcode-panel').then((m) => ({ default: m.GcodePanel })))


/**
 * An object's size as it sits on the plate (its scale and turn included), as "x x y x z mm", or null with no mesh.
 * Model gives it in the display unit at its precision.
 */
export function modelSizeText(entry: Pick<PlateEntry, 'parts' | 'transform'> | undefined, units?: UnitPrefs): string | null {
  const b = entry ? bounds(entry.parts, entry.transform) : null
  if (!b) return null
  if (units) return `${sizeOf(b).map((v) => fixedLength(v, units)).join(' x ')} ${units.length}`
  return `${sizeOf(b).map((v) => v.toFixed(1)).join(' x ')} mm`
}

/** The size of the selected object, or of the first one with nothing selected; it follows scaling as it happens. */
function ModelSize({ model }: { model: boolean }) {
  const entry = useApp((s) => s.plate.find((p) => p.id === s.selection) ?? s.plate[0])
  const units = useApp((s) => s.units)
  const text = useMemo(() => modelSizeText(entry, model ? units : undefined), [entry, model, units])
  if (!text) return null
  return (
    <div className="dims sx-overlay sx-mono" aria-label="Model size">
      {text}
    </div>
  )
}
export function Studio() {
  const host = useHost()
  const hasPreview = useApp((s) => s.preview !== null)
  const nornOn = useApp((s) => s.norn.pick !== null || s.norn.before !== null)
  const gcodeOn = useGcodeView((s) => s.panel)
  const plate = useApp((s) => s.plate)
  const layout = useLayout()
  const plateName = useApp((s) => s.plates.find((p) => p.id === s.activePlate)?.name ?? 'Plate 1')
  const manyPlates = useApp((s) => s.plates.length > 1)
  // The look and feel places the settings sidebar, its width, and the primary Slice action.
  const side = layout.sidebar.side
  // On a phone the sidebar is a sheet, so the Slice action floats on the view instead of waiting inside it.
  const compact = useCompactLayout()
  const phone = usePhoneLayout()
  const sliceInSidebar = layout.primaryAction.placement === 'sidebar-footer' && !compact
  // The plate toolbar across the top carries the view switch under it, and the two drag as one.
  const groupTools = layout.toolbar !== 'left-of-viewport' && !phone
  const modelMode = useModelMode()
  useBoundValues(true)
  const design = modelMode === 'design'
  const mimir = modelMode === 'mimir'
  const [chatSeen, setChatSeen] = useState(mimir)
  if (mimir && !chatSeen) setChatSeen(true)
  // Either one shows the design rather than the plate set up for printing.
  const cad = design || mimir
  // Slice shows the sliced toolpaths in place of the models (the default look); the layer dock, legend and color menu come with them.
  // Painting, brim ears and lay on face work on the solid models, so the layers step aside while one is on.
  const plateTool = useTool()
  const surfaceTool = plateTool === 'paint' || plateTool === 'brim' || plateTool === 'face'
  const layers = useApp((s) => showsLayers(s)) && !cad && !surfaceTool
  // Whether the slice on screen is the plate as it is now: tests and styles read it from the studio.
  const sliceState = useApp((s) => (s.slice.status === 'done' ? (s.slice.stale ? 'stale' : 'current') : s.slice.status))
  const slicesDone = useApp((s) => s.slicesDone)
  const other = side === 'left' ? 'right' : 'left'
  // The objects list sits at the top of the right pane, above the slice summary; on a phone it stays in the settings sheet.
  const objectsRight = layout.objectList === 'right-pane' && !compact
  // The right pane stays shut until opened; its tab glows when something in it wants a look.
  const rightOpen = useApp((s) => railOpen(s.rails, 'preview', other, true))
  // Cut, Paint, Brim ears and the modeling tools open in the Objects card: with the objects in the right pane, opening a
  // tool opens the pane, which starts shut.
  const objectTool = useApp((s) => s.objectTool)
  const toolOpen = !cad && (plateTool === 'paint' || plateTool === 'brim' || objectTool === 'cut' || isCadTool(objectTool))
  useEffect(() => {
    if (toolOpen && objectsRight && !railOpen(get().rails, 'preview', other, true)) setRail('preview', other, true)
  }, [toolOpen, objectsRight, other])
  const { printer } = usePrinter()
  const printState = printer?.status.state
  const printResult = printer && (printState === 'finished' || printState === 'error') ? `${printer.id}:${printState}:${printer.status.updatedAt}` : null
  const rightAttention = useRightAttention(rightOpen, printResult)
  const rightSections = [...(objectsRight ? [OBJECTS_SECTION] : []), ...(hasPreview ? (manyPlates ? [PLATES_SECTION, ...PREVIEW_RIGHT] : PREVIEW_RIGHT) : [])]
  // Toasts center over the viewport and sit above the plate bar and the playback bar, below the toolbar and the view
  // switch, never on a control.
  const vpRef = useRef<HTMLElement>(null)
  useOverlayOffset(vpRef, compact ? PHONE_OVERLAYS : OVERLAYS)

  // Painting, brim ears and lay on face are print setup: they close when Design opens.
  // The full geometry engine starts loading on the way into Design, so its first tool does not wait.
  useEffect(() => {
    if (!cad) return
    if (['paint', 'brim', 'face'].includes(toolStore.getState().tool)) setTool('move')
    warmFullEngine()
  }, [cad])

  // Finished slices no view or plate holds any more are let go in the slicer.
  useEffect(() => startSliceRelease(host.slicer), [host])

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
  // Meshes nothing can bring back to a plate are let go in the slicer.
  useEffect(() => startMeshRelease(host.slicer), [host])
  useEffect(() => startTimeline(), [])

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
    <div className="studio" data-mode="prepare" data-layers={layers || undefined} data-slice={sliceState} data-slices={slicesDone} data-model-mode={cad ? modelMode : undefined} data-sidebar={side} style={{ '--w-settings': `${layout.sidebar.width}px` } as CSSProperties}>
      {/* on a phone Model's tools are a bar along the bottom of the view instead */}
      {design && !phone ? (
        <Suspense fallback={<div className="shelf" aria-hidden="true" />}>
          <Shelf />
        </Suspense>
      ) : null}
      {/* Once opened, the chat stays mounted and hides on Model and Slice, so a running build carries on. */}
      {chatSeen ? (
        <Suspense fallback={mimir ? <div className="mimir-chat" aria-hidden="true" /> : null}>
          <MimirChat hidden={!mimir} />
        </Suspense>
      ) : null}
      {mimir ? null : design ? (
        <SidePane key={`design-${side}`} side={side} ws={railKey('prepare', 'design')} label="Model" sections={DESIGN_TREE} width={280} tab={{ panel: 'model-tree', shutFully: true }} sheetTab={!phone}>
          <Suspense fallback={<Loading />}>
            <DesignLeft />
          </Suspense>
        </SidePane>
      ) : (
        <SidePane key={`prepare-${side}`} side={side} ws="prepare" label="Printer and settings" sections={PREPARE_LEFT} width={layout.sidebar.width} tab={{ panel: 'slice-sidebar' }} {...(compact ? {} : { pinned: <SlicePinned /> })} {...(sliceInSidebar ? { footer: <SliceBlock label={layout.primaryAction.label} compact /> } : {})} {...(layout.modeSelector === 'sidebar' ? { headExtra: <ModeChip layout={layout} /> } : {})}>
          <PrepareLeft layout={layout} />
        </SidePane>
      )}

      <section className="vp" aria-label="Plate" ref={vpRef}>
        <ViewportHost layers={layers} />
        <Suspense fallback={null}>
          <OpeningPicture />
        </Suspense>
        <SliceProgress />
        {cad ? null : <ViewSelectionMenu />}
        {/* With the toolbar on top, the view switch hangs under it and moves with it (plate-tools-group.tsx). */}
        {cad || !hasPreview || groupTools ? null : <SliceLookSwitch />}
        {cad || phone ? null : <ParkedChip />}
        <div className="hud hud-top">
          <div className="hud-col">
            <div className="hud-row">
              {mimir ? (
                <Suspense fallback={null}>
                  <MimirCaption />
                </Suspense>
              ) : null}
              {/* on a phone in Model the look button joins the view buttons on the right, so the pill row fits */}
              {design && phone ? null : <RenderMenu />}
              {design ? (
                <Suspense fallback={null}>
                  <SelectPill />
                </Suspense>
              ) : null}
            </div>
            {design && phone ? (
              <Suspense fallback={null}>
                <PhoneHandles />
              </Suspense>
            ) : null}
            {layers ? (
              <Legend />
            ) : null}
          </div>
          <div className="hud-col end">
            {design && phone ? <RenderMenu /> : null}
            <ViewMenu />
            {design && phone ? (
              <Suspense fallback={null}>
                <PhoneUndo />
              </Suspense>
            ) : null}
          </div>
        </div>

        <div className="hud hud-bl">
          {cad || layout.plateList === 'sidebar' ? null : <PlateList layout={layout} />}
          {/* The plate chip names the plate only; the objects' names and sizes are in the objects list and the scale tool. */}
          {cad ? null : (
            <div className="platechip sx-overlay" data-testid="plate-chip">
              <b>{plateName}</b>
            </div>
          )}
          {/* Design keeps the size of the design on screen, which its own panels do not show. */}
          {cad && selected ? <ModelSize model={design} /> : null}
        </div>

        {/* a phone views and prints: no plate tools */}
        {cad || phone ? null : groupTools ? <PlateToolsGroup layout={layout} look={hasPreview ? <SliceLookSwitch /> : null} /> : <PlateToolbar layout={layout} />}
        {layers ? <LayerDock /> : null}
        {/* After the playback bar: on a phone it sits under it, so opening the bar moves nothing above it. */}
        {!cad && !sliceInSidebar ? (
          <div className="slice-float sx-overlay">
            <SliceBlock label={layout.primaryAction.label} compact />
          </div>
        ) : null}
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
        {mimir ? (
          <Suspense fallback={null}>
            <LookupCards />
            <MimirSheet />
          </Suspense>
        ) : null}
        {cad ? (
          <Suspense fallback={null}>
            <DesignTimeline phone={phone && design} />
          </Suspense>
        ) : null}
        {design && phone ? (
          <Suspense fallback={null}>
            <PhoneShelf sheetKeys={{ tree: `${railKey('prepare', 'design')}:${side}`, tool: `${railKey('prepare', 'design')}:${other}` }} />
          </Suspense>
        ) : null}
        {cad ? null : (
          <>
            <ZoneLegend layers={layers} />
          </>
        )}
      </section>

      {mimir ? null : design ? (
        <SidePane key={`design-${other}`} side={other} ws={railKey('prepare', 'design')} label="Tool and transform" sections={DESIGN_TOOL} width={312} tab={{ panel: 'model-inspector', shutFully: true }} docked={phone} sheetTab={!phone}>
          <Suspense fallback={<Loading />}>
            <DesignRight />
          </Suspense>
        </SidePane>
      ) : objectsRight || hasPreview ? (
        <SidePane key={`sliced-${other}`} side={other} ws="preview" label={objectsRight ? 'Objects and slice summary' : 'Slice summary and filament'} sections={rightSections} width={312} tab={{ panel: 'slice-summary' }} attention={rightAttention}>
          {objectsRight ? <PrepareObjects /> : null}
          {hasPreview ? (
            <>
              <PreviewPlates />
              <PreviewLeft />
              <PreviewRight />
            </>
          ) : null}
        </SidePane>
      ) : null}
    </div>
  )
}
