// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Prepare and Preview share one viewport, so switching between them never
// rebuilds the scene. The side panes change with the mode.
import { lazy, Suspense, useEffect, useRef, type CSSProperties } from 'react'
import { Button, Icon } from '@slicerx/ui'
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
import { loadDefaultPlate, slicePlate } from '../state/actions'
import { get, useApp } from '../state/store'
import { ViewportHost } from '../viewport/viewport-host'
import { LayerStrip } from './layer-strip'
import { ZoneLegend } from './zone-legend'
import { PrepareLeft, SliceBlock } from './prepare/prepare-panes'
import { LayerDock, Legend } from './preview/preview-hud'
import { PreviewLeft, PreviewRight } from './preview/preview-panes'
import { useGcodeView } from './preview/gcode-file'
import { trackPlateSlices } from './preview/plate-slices'
import { PreviewPlates } from './preview/preview-plates'

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

// norn (edit from Preview) loads with the first click on a toolpath.
const NornLayer = lazy(() => import('../norn/norn-layer').then((m) => ({ default: m.NornLayer })))
// The G-code line view loads when it is first opened.
const GcodePanel = lazy(() => import('./preview/gcode-panel').then((m) => ({ default: m.GcodePanel })))

export function Studio({ mode }: { mode: 'prepare' | 'preview' }) {
  const host = useHost()
  const slice = useApp((s) => s.slice)
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

  useEffect(() => {
    const s = get()
    if (s.plate.length === 0 && !s.plateLoading) void loadDefaultPlate(host)
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
  const busy = plateLoading || slice.status === 'running'

  return (
    <div className="studio" data-mode={mode} data-sidebar={side} style={{ '--w-settings': `${layout.sidebar.width}px` } as CSSProperties}>
      {mode === 'prepare' ? (
        <SidePane key={`prepare-${side}`} side={side} ws="prepare" label="Printer and settings" sections={PREPARE_LEFT} width={layout.sidebar.width} {...(sliceInSidebar ? { footer: <SliceBlock label={layout.primaryAction.label} compact /> } : {})}>
          <PrepareLeft layout={layout} />
        </SidePane>
      ) : null}

      <section className="vp" aria-label={mode === 'prepare' ? 'Plate' : 'Preview'}>
        <ViewportHost mode={mode} />
        {busy ? (
          <div className="busy" aria-hidden="true">
            <i />
          </div>
        ) : null}
        <div className="hud hud-top">
          <div className="hud-col">
            {mode === 'prepare' ? (
              <RenderMenu />
            ) : hasPreview ? (
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

        {mode === 'prepare' ? (
          <div className="hud hud-bl">
            {layout.plateList === 'sidebar' ? null : <PlateList layout={layout} />}
            <div className="platechip sx-overlay">
              <b>{plateName}</b>
              <span>{selected ? selected.name : plateLoading ? 'Loading' : 'Empty'}</span>
              {plate.length > 1 ? <span>+{plate.length - 1}</span> : null}
            </div>
            {selected ? (
              <div className="dims sx-overlay sx-mono" aria-label="Model size">
                {selected.handle.bboxMm.map((v) => v.toFixed(1)).join(' x ')} mm
              </div>
            ) : null}
          </div>
        ) : null}

        {mode === 'preview' && !hasPreview ? (
          <div className="vp-empty">
            <div>
              <Icon name="slice" />
              <b>{slice.status === 'running' ? 'Slicing' : slice.status === 'error' ? 'The slice failed' : 'Nothing sliced yet'}</b>
              <p>{slice.status === 'error' ? slice.message : 'Slice the plate to see its toolpaths here, layer by layer.'}</p>
              {slice.status !== 'running' && plate.length > 0 ? (
                <Button size="sm" variant="primary" icon="slice" onClick={() => void slicePlate(host)}>
                  Slice {plateName}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {mode === 'prepare' ? <PlateToolbar layout={layout} /> : null}
        {mode === 'prepare' && !sliceInSidebar ? (
          <div className="slice-float sx-overlay">
            <SliceBlock label={layout.primaryAction.label} compact />
          </div>
        ) : null}
        {mode === 'preview' && hasPreview ? <LayerDock /> : null}
        {mode === 'preview' && hasPreview && gcodeOn ? (
          <Suspense fallback={null}>
            <GcodePanel />
          </Suspense>
        ) : null}
        {mode === 'preview' && hasPreview && nornOn ? (
          <Suspense fallback={null}>
            <NornLayer />
          </Suspense>
        ) : null}
        <LayerStrip />
        <ZoneLegend mode={mode} />
      </section>

      {mode === 'preview' ? (
        <SidePane key="preview-right" side="right" ws="preview" label="Slice summary and filament" sections={manyPlates ? [PLATES_SECTION, ...PREVIEW_RIGHT] : PREVIEW_RIGHT} width={312}>
          <PreviewPlates />
          <PreviewLeft />
          <PreviewRight />
        </SidePane>
      ) : null}
    </div>
  )
}
