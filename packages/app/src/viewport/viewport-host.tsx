// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Mounts @slicerx/viewport on first use of Prepare or Preview and drives it from
// the store through its imperative handle. React never renders per frame
//. If the GPU path cannot start, a flat 2D fallback
// keeps both workspaces usable.
import { fitLines, keepFits, subscribeFits } from '../plate/fit-state'
import type { PreviewBuffers } from '@slicerx/contracts'
import type { PlateTool, RenderMode, ToolChangerSpec, Viewport, ViewportEvents, ViewportPlate } from '@slicerx/viewport'
import { onThemeChange } from '@slicerx/ui/theme'
import { useEffect, useRef, useState } from 'react'
import { brandAccent, useEdition } from '../edition'
import { controlsFor, type ControlsApi } from '../first-run/controls'
import { effectiveSlot, mapSlot, resolveSlots, slotFinish, type ResolvedSlot } from '../filament/slots'
import { activeMeta } from '../plate/plates'
import { bake } from '../plate/mesh-ops'
import { objectWarnings } from '../plate/object-list'
import { loadExtruderAreas, nozzleZones } from '../plate/nozzle-zones'
import { commitTransforms, layOnPickedFace } from '../plate/edit'
import { openViewMenu } from '../plate/view-menu'
import { openViewRing, ringTarget, setLayFace } from '../plate/view-ring'
import { cutStore, toggleConnector } from '../plate/cut-plane'
import { probeHandler, setCameraBus, toolStore, type CadView, type Tool } from '../plate/tools'
import { pickSub, type EdgeAt, type EdgeWins, type FaceRound } from '../plate/sub-pick'
import { EDGE_WINS_PX, screenDistance } from '../plate/pick-filter'
import { modelFeelFor, onModelFeel } from '../cad/model-feel-flag'
import { framingIsHeld, hideOtherTag, otherPick, selectOther, selectOtherOn, setOtherView } from '../plate/select-other'
import { toGeom } from '../geom/client'
import { useHost } from '../host'
import { moveTower, towerMesh, towerShown, TOWER_ID, type ShownTower } from '../plate/tower'
import { appStore, selectedIds, set, shownSlice, toast, toggledSelection, useApp, type AppState } from '../state/store'
import { cadShown, modelMode, showsDesign } from '../state/model-mode'
import { isPhoneLayout, onPhoneLayout } from '../lib/phone-layout'
import { modelReveal, type RevealMemory } from './model-reveal'
import { webgl2Available, watchFor, withRetries } from './context-retry'
import { createFallbackViewport } from './fallback'
import { OVERLAY_GAP, overlayInsets } from './overlay-insets'
import { shellGpu } from './shell-gpu'
import { viewportTheme } from './scene-theme'
import { clearViewportLook, syncViewportLook } from './viewport-look'
import { commitStroke } from '../plate/paint'
import { addEar, headDiameter, moveEar, onEarSelection, onHeadDiameter, removeEar, resizeSelectedEars, selectedEars, selectEars, setHeadDiameter, worldEars } from '../plate/brim-ears'
import { paintBusChanged, setPaintBus } from '../plate/tools'
import { markerView, wantsGcodeMarkers } from '../workspaces/preview/markers'
import { resolveConfig } from '../adapters/config'
import { excludedPolygons } from './bed-exclude'
import { areaOrigin, polygonsToPlate } from '../plate/bed-origin'
import { toolChangerFor } from '../lib/toolchanger'
import { buildTimeline, fitOf, type Timeline } from '../lib/preview-timeline'
import { headFor } from '@slicerx/viewport'
import { strikeMarks } from '../plate/heimdall'
import { gantryHits, gantrySpec } from '../plate/heimdall-gantry'
import { markOpenStage, markViewDrawn, onOpenStage, openStagesPassed } from '../lib/open-mark'
import { drawnFrom } from './drawn'
import { currentSlice, sliceStage } from '../lib/slice-timing'

/** The part of the viewport handle the app drives. The 2D fallback implements the same. */
// One memory a session: a second view (a remount) does not count as Model's first open again.
const revealMemory: RevealMemory = { modelSeen: false }
/** View notices already told this visit: each new view says its notice again, which would stack a second card or
 * bring back one the person closed. */
const toldNotices = new Set<string>()
const prefersReducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** The render mode for the state: Model's CAD look, or the look picked for Slice. */
export function modelLook(s: Pick<AppState, 'workspace' | 'modelMode' | 'look'>): RenderMode {
  if (showsDesign(s)) return s.look === 'xray' ? 'xray' : 'cad'
  return s.look
}

export type Drive = Pick<Viewport, 'setMode' | 'setPlate' | 'drawnObjects' | 'setTransforms' | 'setRenderMode' | 'view' | 'setPreview' | 'setLayerRange' | 'setMoveCut' | 'setColorMode' | 'setToolColors' | 'setSelection' | 'on' | 'dispose'> & {
  backendName(): string
  /** Camera and mouse controls, tools and camera calls; the 2D fallback has none of them. */
  setControls?: Viewport['setControls']
  setTheme?: Viewport['setTheme']
  setLook?: Viewport['setLook']
  look?: Viewport['look']
  setTool?: Viewport['setTool']
  setRotateSpace?: Viewport['setRotateSpace']
  setMoveHandles?: Viewport['setMoveHandles']
  setMovable?: Viewport['setMovable']
  setCutPlane?: Viewport['setCutPlane']
  setGapLines?: Viewport['setGapLines']
  setGuides?: Viewport['setGuides']
  /** Model's Shift and drag box select. */
  setBoxSelect?: Viewport['setBoxSelect']
  /** Model's picked faces and the face filter's hover. */
  setSelectedFaces?: Viewport['setSelectedFaces']
  facePickAt?: Viewport['facePickAt']
  setPickFaces?: Viewport['setPickFaces']
  screenOf?: Viewport['screenOf']
  /** Model's Select Other: everything under a point, and a press held still for its list. */
  pickAll?: Viewport['pickAll']
  setHoldPick?: Viewport['setHoldPick']
  setPickEdges?: Viewport['setPickEdges']
  setPickedEdges?: Viewport['setPickedEdges']
  setInsets?: Viewport['setInsets']
  setPreviewGhost?: Viewport['setPreviewGhost']
  setPreviewOrigin?: Viewport['setPreviewOrigin']
  setPreviewStale?: Viewport['setPreviewStale']
  setHighlightSlot?: Viewport['setHighlightSlot']
  setToolFinishes?: Viewport['setToolFinishes']
  setMarkers?: Viewport['setMarkers']
  setExcludedAreas?: Viewport['setExcludedAreas']
  setGcodeMarkers?: Viewport['setGcodeMarkers']
  setProbeFaces?: Viewport['setProbeFaces']
  zoomToSelection?: Viewport['zoomToSelection']
  zoomToBed?: Viewport['zoomToBed']
  zoomBy?: Viewport['zoomBy']
  focusBedPoint?: Viewport['focusBedPoint']
  toggleProjection?: Viewport['toggleProjection']
  /** Where the camera is, for the agent bridge's read-back. */
  getCamera?: Viewport['getCamera']
  getProjection?: Viewport['getProjection']
  arrange?: Viewport['arrange']
  controlsApi?: ControlsApi
  /** Paint: only the GPU viewport has it. */
  setPaintSettings?: Viewport['setPaintSettings']
  getPaintSettings?: Viewport['getPaintSettings']
  setPaintColors?: Viewport['setPaintColors']
  setToolChanger?: Viewport['setToolChanger']
  setHeadModel?: Viewport['setHeadModel']
  setToolChange?: Viewport['setToolChange']
  setShowToolhead?: Viewport['setShowToolhead']
  setShowGantry?: Viewport['setShowGantry']
  setFollowNozzle?: Viewport['setFollowNozzle']
  setPurges?: Viewport['setPurges']
  setPaintData?: Viewport['setPaintData']
}

/** What a part shows: its slot's color when the person or the printer set one, or a color swap moved it, else the model file's own. */
function partColor(s: AppState, slots: ResolvedSlot[], slot: number, modelColor: string, printable = true): string {
  if (!printable) return '#6b6b78'
  const mapped = mapSlot(activeMeta(s), slot)
  const r = slots[mapped - 1]
  return r && (r.source === 'user' || r.source === 'printer' || mapped !== slot) ? r.color : modelColor
}

const PAINT_LAYERS = ['color', 'seam', 'support', 'fuzzy'] as const

const VOLUME_COLOR = { negative: '#ff5555', support_blocker: '#ffb86c', support_enforcer: '#50fa7b', modifier: '#8be9fd' } as const

/** Design models parts on a plain ground: no prime tower, which is print setup. */
const designing = (s: AppState): boolean => showsDesign(s) && cadShown()

/**
 * A volume's positions in its object's space, baked once per part and placement: the viewport keeps an object built
 * while its arrays stay the same ones, so a payload made for another change must not bake them anew.
 */
const baked = new WeakMap<object, { local: readonly number[]; positions: Float32Array }>()
function bakedVolume(v: { part: Parameters<typeof bake>[0]; local: Parameters<typeof bake>[1] }): Float32Array {
  const hit = baked.get(v.part)
  if (hit && hit.local === v.local) return hit.positions
  const positions = bake(v.part, v.local).positions
  baked.set(v.part, { local: v.local, positions })
  return positions
}

function platePayload(s: AppState, shown: ShownTower | null): ViewportPlate {
  const slots = resolveSlots(s)
  const tower = shown ? towerMesh(shown.at, shown.heightMm) : null
  return {
    bed: s.bed,
    zones: nozzleZones(s.extruderAreas, s.bed).map(({ id, label, color, polygon }) => ({ id, label, color, polygon })),
    objects: [
      ...(tower ? [{ id: TOWER_ID, name: 'Prime tower', transform: tower.transform, parts: [{ name: 'Prime tower', positions: tower.positions, indices: tower.indices, color: '#9aa4c1' }] }] : []),
      ...s.plate.map((p) => ({
      id: p.id,
      name: p.name,
      transform: p.transform,
      parts: [
        ...p.parts.map((part, i) => ({ name: part.name, positions: part.positions, indices: part.indices, slot: effectiveSlot(p, part), color: partColor(s, slots, effectiveSlot(p, part), p.colors[i] ?? p.colors[0] ?? brandAccent(), p.printable !== false) })),
        // Volumes show in place, colored by what they do.
        ...(p.volumes ?? []).map((v) => ({ name: v.name, positions: bakedVolume(v), indices: v.part.indices, color: VOLUME_COLOR[v.role] })),
      ],
    })),
    ],
  }
}

/**
 * How a phone runs the 3D view: 'slim' where it views and prints (Slice), 'model' in Model, false off a phone.
 */
export type PhoneView = 'slim' | 'model' | false

/** The phone view for the app's state, read once. */
export function phoneView(s: { workspace: string }): PhoneView {
  if (!isPhoneLayout()) return false
  // the mode shown, not the saved one: a phone on a host that slices always shows Slice
  return showsDesign({ workspace: s.workspace, modelMode: modelMode() }) ? 'model' : 'slim'
}

/**
 * The viewport tool for the app's tool. Scale shows the viewport's handles (x, y, z and the uniform corners), as move
 * and rotate show theirs. A phone in Slice views and prints, so it only selects; a phone in Model keeps the move,
 * rotate and scale handles and an open modeling tool's taps (a sketch draws with them), and every other tool selects
 * there. The brim tool without the viewport's brim mode is a plain selection.
 */
export function viewportTool(tool: Tool, phone: PhoneView, brimMode: boolean): PlateTool {
  if (phone === 'slim') return 'select'
  if (phone === 'model') return tool === 'move' || tool === 'rotate' || tool === 'scale' || tool === 'probe' ? tool : 'select'
  if (tool === 'brim' && !brimMode) return 'select'
  return tool
}

/** Objects and their meshes; a change here rebuilds the scene, a transform alone does not. */
/**
 * Whether a rebuilt plate gets a fresh camera: when its objects were replaced wholesale (a project opened, New
 * project, a plate swap, or a cut of the only model leaves no object the old plate had), the old view may show only
 * a corner of the bed. An edit, a move, an added or deleted object or a cut beside other models keeps the user's
 * camera. An empty plate either side frames too.
 */
export function reframesOnRebuild(prev: { plate: readonly { id: string }[]; activePlate: string }, next: { plate: readonly { id: string }[]; activePlate: string }): boolean {
  if (!prev.plate.length || !next.plate.length) return true
  if (prev.activePlate !== next.activePlate) return true
  const before = new Set(prev.plate.map((o) => o.id))
  return !next.plate.some((o) => before.has(o.id))
}

const towerSpot = (t: ShownTower | null): string => (t ? `${t.at.x},${t.at.y},${t.at.angle}` : '')

function geometryKey(s: AppState, shown: ShownTower | null): string {
  const colors = resolveSlots(s).map((r) => r.color).join()
  // The tower's corner and angle are its transform; only its size rebuilds.
  const towerKey = shown ? `tower:${shown.at.width},${shown.at.depth},${shown.heightMm}` : ''
  return towerKey + '|' + s.plate.map((p) => `${p.id}:${p.handle.id}:${p.printable === false ? 'x' : ''}${JSON.stringify(p.slotOverrides ?? {})}:${(p.volumes ?? []).map((v) => `${v.id}${v.role}${v.local.join()}`).join(';')}`).join('|') + `#${colors}#${JSON.stringify(activeMeta(s)?.settings.slotMap ?? {})}`
}

/** Whether the last way focus moved was the Tab key, rather than a press (a pointer, or a script after a key). */
let tabbed = false
let tabWatch = false
function watchTab(): void {
  if (tabWatch) return
  tabWatch = true
  window.addEventListener('keydown', (e) => void (e.key === 'Tab' && (tabbed = true)), true)
  window.addEventListener('pointerdown', () => void (tabbed = false), true)
}

function makeCanvas(stage: HTMLElement, label: string): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.className = 'vp-canvas'
  c.tabIndex = 0
  c.setAttribute('aria-label', label)
  // The view shows that it has focus only when Tab brought it there: a faint inner edge (app.css). A click, the plate
  // keys or a script focusing it leave it plain, as the browser's own focus ring would not.
  watchTab()
  c.addEventListener('focus', () => c.toggleAttribute('data-tab-focus', tabbed))
  c.addEventListener('blur', () => c.removeAttribute('data-tab-focus'))
  c.addEventListener('pointerdown', () => c.removeAttribute('data-tab-focus'))
  stage.appendChild(c)
  return c
}

/**
 * The plate reveal. Browser tests compare pictures from the first frame, so they turn it off with this session flag
 * (`off`); the reveal's own test sets `always` to play it on their software graphics.
 */
function revealOption(): boolean | 'always' {
  try {
    const v = sessionStorage.getItem('sx-reveal')
    return v === 'off' ? false : v === 'always' ? 'always' : true
  } catch {
    return true
  }
}

/**
 * Big models build in workers (viewport ViewportOptions.meshWorker), so a model of millions of triangles shows without
 * holding the page for seconds. None where the page has no workers (tests); the viewport then builds on the page.
 */
function meshWorkerOption(): { meshWorker?: () => Worker } {
  if (typeof Worker === 'undefined') return {}
  return { meshWorker: () => new Worker(new URL('./mesh-build-worker.ts', import.meta.url), { type: 'module', name: 'mesh-build' }) }
}

/**
 * The canvases live in a stage element React never renders into, because a
 * canvas that failed to get a WebGL context cannot give a 2D one either. Each try
 * gets a canvas of its own. `late3d` is called when the 2D fallback finds that a
 * WebGL2 context can be had after all, so the host starts the 3D view again.
 */
async function start(stage: HTMLElement, webgpu: boolean, label: string, late3d: () => void): Promise<Drive> {
  try {
    const [{ createViewport, controlsPreset, withRemap, withGizmo }, gpuRenderer] = await Promise.all([import('@slicerx/viewport'), shellGpu()])
    const vp = await withRetries(() => {
      const canvas = makeCanvas(stage, label)
      try {
        return createViewport(canvas, { backend: webgpu ? 'auto' : 'webgl2', label, gpuRenderer, reveal: revealOption(), ...meshWorkerOption() })
      } catch (e) {
        canvas.remove()
        throw e
      }
    })
    // Profiling hook: set localStorage 'slicerx.debug' to reach the handle from a script (the store's __sx is there
    // from the first frame, state/store.ts).
    try {
      if (localStorage.getItem('slicerx.debug')) Object.assign(window, { __vp: vp })
    } catch { /* storage blocked */ }
    return Object.assign(vp, { backendName: () => (vp.stats().backend === 'webgpu' ? 'WebGPU' : 'WebGL2'), controlsApi: { controlsPreset, withRemap, withGizmo } })
  } catch (e) {
    // A broken GPU path must not take Prepare down; the 2D fallback still shows the plate, and the 3D view comes back
    // when a context can be had.
    console.warn('Viewport failed to start, using the 2D fallback', e)
    const flat = createFallbackViewport(makeCanvas(stage, label))
    toast('This browser has no WebGL2, so the plate shows in a simple 2D view', 'warn')
    const stop = watchFor(webgl2Available, late3d)
    const dispose = flat.dispose.bind(flat)
    return Object.assign(flat, {
      dispose() {
        stop()
        dispose()
      },
    })
  }
}

/** Moves drawn on the top visible layer, or null for the whole layer. */
export function moveCount(p: PreviewBuffers | null, layerHi: number, cut: number): number | null {
  if (!p || layerHi < 1 || cut >= 1) return null
  const top = Math.min(layerHi, p.layerCount) - 1
  const startIdx = p.layerStart[top] ?? 0
  const end = p.layerStart[top + 1] ?? startIdx
  // Fractional: the viewport draws the current move part of the way and puts the head there.
  return (end - startIdx) * cut
}

/** Whether this session has checked the Model feel's off switch for the pick filter. */
let feelStarted = false

/** The plate's viewport. `layers`: Slice shows the toolpaths, with the layer dock and legend over the view. */
/** The edge under a click in Model, from the geometry engine, as lines to draw. */
const edgeAt: EdgeAt = async (objectId, partIndex, triangle, at) => {
  const e = appStore.getState().plate.find((p) => p.id === objectId)
  const part = e?.parts[partIndex]
  if (!e || !part) return null
  const [{ pickEdge }, { edgeLines }] = await Promise.all([import('../geom/cad'), import('../cad/edges')])
  const r = await pickEdge({ mesh: toGeom(part), transform: e.transform }, { triangle, at })
  return edgeLines(r.edge)
}

/** Whether the face under a pick is round: the engine's feature there is a cylinder (a hole's or a peg's wall). */
const faceRound: FaceRound = async (objectId, partIndex, triangle, at) => {
  const e = appStore.getState().plate.find((p) => p.id === objectId)
  const part = e?.parts[partIndex]
  if (!e || !part) return false
  const { featureAt } = await import('../geom/cad')
  const f = await featureAt({ mesh: toGeom(part), transform: e.transform }, { triangle, at })
  return f.kind === 'cylinder'
}

export function ViewportHost({ layers }: { layers: boolean }) {
  // There is one plate view now; the toolpath look (setToolpathLook) draws the slice in it.
  const mode = 'prepare' as const
  const host = useHost()
  const edition = useEdition()
  const defaultLook = useRef(edition.firstRun.defaultLook)
  defaultLook.current = edition.firstRun.defaultLook
  const stageRef = useRef<HTMLDivElement>(null)
  const vpRef = useRef<Drive | null>(null)
  const modeRef = useRef(mode)
  // Bumped when the 2D fallback finds WebGL2 after all: the view starts again, in 3D.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let disposed = false
    const offs: (() => void)[] = []
    const mountedAt = performance.now()
    void start(stage, host.capabilities.webgpu, 'Plate and toolpaths', () => setAttempt((n) => n + 1)).then((vp) => {
      if (disposed) {
        vp.dispose()
        return
      }
      vpRef.current = vp
      offs.push(drawnFrom(() => vp.drawnObjects()))
      offs.push(clearViewportLook)
      set({ viewportBackend: vp.backendName() })
      let prev = appStore.getState()
      // Paint the viewport already holds (a stroke it just made) is not pushed back.
      let fromViewport = false
      let excludedKey: string | null = null
      let towerBefore: ShownTower | null = null
      let keyBefore = ''
      // Test hook: with localStorage 'slicerx.debug' and 'slicerx.warmupWaitsForOpen' set, the toolpath shader warm-up
      // waits until the first file open starts (a plate restored at start is not one), so a test can open a project
      // before it as a person can at launch.
      let warmupWaitsForOpen = false
      try {
        warmupWaitsForOpen = Boolean(localStorage.getItem('slicerx.debug') && localStorage.getItem('slicerx.warmupWaitsForOpen'))
      } catch { /* storage blocked */ }
      if (warmupWaitsForOpen) offs.push(onOpenStage(() => void (warmupWaitsForOpen = false)))
      let changerSent: ToolChangerSpec | null | undefined
      // The purge at the chute for each change, read from the G-code once per preview and tool changer.
      let purgesFor: Timeline | null = null
      const syncPurges = (s: AppState) => {
        if (!vp.setPurges) return
        const spec = toolChangerFor(s)
        const p = s.preview
        const tl = p && spec?.chute ? buildTimeline(p, spec, fitOf(shownSlice(s.slice)?.result.stats ?? null)) : null
        if (tl === purgesFor) return
        purgesFor = tl
        vp.setPurges(null)
        if (!p || !tl) return
        void import('../workspaces/preview/purge-data')
          .then((d) => d.loadPurges(host, p, tl, spec))
          .then((plans) => {
            if (purgesFor === tl) vp.setPurges?.(plans)
          })
          .catch(() => {})
      }
      const pushPaint = (entries: AppState['plate'], before: AppState['plate'] | null) => {
        if (!vp.setPaintData) return
        for (const e of entries) {
          const old = before?.find((b) => b.id === e.id)
          if (old && old.paint === e.paint) continue
          const parts = new Set([...Object.keys(e.paint ?? {}), ...Object.keys(old?.paint ?? {})].map(Number))
          for (const part of parts) for (const layer of PAINT_LAYERS) vp.setPaintData(e.id, part, layer, e.paint?.[part]?.[layer] ?? null)
        }
      }
      // Brim ears: the viewport draws and picks them when it has the calls (feature detection, so older builds still run).
      const brimVp = vp as unknown as {
        setBrimEars?(ears: Record<string, (ReturnType<typeof worldEars>[number] & { selected?: boolean })[]>): void
        setBrimHoverRadius?(r: number | null): void
        on(event: 'brimadd', cb: (e: { objectId: string; point: [number, number, number] }) => void): () => void
        on(event: 'brimremove', cb: (e: { objectId: string; index: number }) => void): () => void
        on(event: 'brimselect', cb: (e: { objectId: string; indices: number[]; mode: 'set' | 'add' | 'remove' }) => void): () => void
        on(event: 'brimmove', cb: (e: { objectId: string; index: number; point: [number, number, number]; final: boolean }) => void): () => void
        on(event: 'brimwheel', cb: (e: { delta: 1 | -1 }) => void): () => void
      }
      const pushEars = (s: AppState) =>
        brimVp.setBrimEars?.(
          Object.fromEntries(
            s.plate
              .filter((p) => p.brimPoints?.length)
              .map((p) => {
                const chosen = new Set(selectedEars(p.id))
                return [p.id, worldEars(p).map((e, i) => ({ ...e, selected: chosen.has(i) }))]
              }),
          ),
        )
      const apply = (s: AppState, first: boolean) => {
        const shown = designing(s) ? null : towerShown(s, towerBefore)
        const towerMoved = towerSpot(shown) !== towerSpot(towerBefore)
        const key = geometryKey(s, shown)
        const rebuilt = first || key !== keyBefore || s.bed !== prev.bed || s.extruderAreas !== prev.extruderAreas
        towerBefore = shown
        keyBefore = key
        // A new project opening over the old one: the view keeps the old scene until the new model's first frame and
        // crossfades to it, so it never shows an empty plate in between. An open that ends empty lets go.
        const view = vp as unknown as Viewport
        if (!first && s.plateLoading && s.plate.length === 0 && prev.plate.length > 0) view.holdScene?.(true)
        else if (!first && !s.plateLoading && prev.plateLoading) view.holdScene?.(false)
        // The toolpath shader warm-up holds every frame while it compiles, so it waits for a file being opened.
        if (first || s.plateLoading !== prev.plateLoading) view.holdWarmup?.(s.plateLoading || warmupWaitsForOpen)
        // Fit notes and markers belong to the objects on the plate: a new project or a removed object takes its own along.
        if (s.plate !== prev.plate) keepFits(s.plate.map((p) => p.id))
        if (rebuilt) vp.setPlate(platePayload(s, shown), { keepCamera: !first && !reframesOnRebuild(prev, s) })
        else if (s.plate !== prev.plate || towerMoved) vp.setTransforms(Object.fromEntries([...s.plate.map((p) => [p.id, p.transform]), ...(shown ? [[TOWER_ID, towerMesh(shown.at, shown.heightMm).transform]] : [])]))
        // A rebuilt scene starts unpainted; otherwise only what changed outside the brush (undo, redo, clear) goes in.
        if (rebuilt) pushPaint(s.plate, null)
        else if (s.plate !== prev.plate && !fromViewport) pushPaint(s.plate, prev.plate)
        if ((first || s.slotSetup !== prev.slotSetup || s.printerSlots !== prev.printerSlots || s.fileSlotColors !== prev.fileSlotColors || rebuilt) && vp.setPaintColors) vp.setPaintColors(resolveSlots(s).map((r) => r.color))
        if (first || s.plate !== prev.plate || s.slotSetup !== prev.slotSetup || s.printerSlots !== prev.printerSlots || s.fileSlotColors !== prev.fileSlotColors) {
          const slots = resolveSlots(s)
          vp.setToolColors(slots.map((r) => r.color))
          // Silk prints streak along each bead, matte ones barely shine: the toolpaths shine like the filament named.
          vp.setToolFinishes?.(slots.map(slotFinish))
        }
        if (first || rebuilt || s.plate !== prev.plate) pushEars(s)
        if (first || s.selection !== prev.selection || s.selectedIds !== prev.selectedIds || s.towerSelected !== prev.towerSelected) vp.setSelection(s.towerSelected ? [TOWER_ID] : selectedIds(s))
        if (first || s.preview !== prev.preview) {
          vp.setPreview(s.preview)
          // The slice's timing (slice-timing.ts) ends at the frame after this one, the first with the preview drawn.
          if (s.preview && typeof requestAnimationFrame === 'function') {
            const id = currentSlice()
            requestAnimationFrame(() => requestAnimationFrame(() => sliceStage(id, 'drawn')))
          }
        }
        // A preview that no longer matches the plate stays drawn, dimmed, until the next slice replaces it.
        if (first || s.slice !== prev.slice) vp.setPreviewStale?.(shownSlice(s.slice)?.stale ?? false)
        // A slot hovered or focused in the filament rail picks its filament out; the rest dims.
        if (first || s.hoverSlot !== prev.hoverSlot) vp.setHighlightSlot?.(s.hoverSlot)
        if (first || s.layerHi !== prev.layerHi || s.layerLo !== prev.layerLo || s.preview !== prev.preview) vp.setLayerRange(Math.max(0, Math.min(s.layerLo, s.layerHi) - 1), Math.max(0, s.layerHi - 1))
        if (first || s.moveCut !== prev.moveCut || s.layerHi !== prev.layerHi || s.preview !== prev.preview) vp.setMoveCut(moveCount(s.preview, s.layerHi, s.moveCut))
        // The printer's own toolhead, its tool changer and, during playback, where the head is in a change.
        if (vp.setHeadModel && (first || s.profile !== prev.profile)) vp.setHeadModel(headFor(s.profile?.printerId))
        if (vp.setToolChanger && (first || s.profile !== prev.profile || s.overrides !== prev.overrides || s.easy !== prev.easy || s.bed !== prev.bed || s.preview !== prev.preview || s.slice !== prev.slice)) {
          const spec = toolChangerFor(s)
          if (spec !== changerSent) {
            changerSent = spec
            vp.setToolChanger(spec)
          }
          syncPurges(s)
        }
        if (vp.setToolChange && (first || s.toolChange !== prev.toolChange || s.preview !== prev.preview)) vp.setToolChange(s.toolChange)
        // heimdall's strikes where the machine would meet a printed part.
        if (first || s.slice !== prev.slice || s.strikePick !== prev.strikePick || s.strikeHover !== prev.strikeHover || s.layerHi !== prev.layerHi) (vp as unknown as Viewport).setStrikes?.(strikeMarks(s))
        // Show me on a refused slice marks its spot (and the excluded area it enters) while that refusal is on screen.
        if (first || s.slice !== prev.slice || s.refusalSpot !== prev.refusalSpot) {
          const r = s.refusalSpot
          const on = r !== null && r.slice === s.slice
          ;(vp as unknown as Viewport).setSpot?.(on ? { x: r.x, y: r.y, z: r.z, selected: true } : null, on ? r.area : null)
        }
        if (first || s.slice !== prev.slice || s.plate !== prev.plate || s.profile !== prev.profile || s.overrides !== prev.overrides || s.easy !== prev.easy || s.bed !== prev.bed) {
          ;(vp as unknown as Viewport).setGantry?.(gantrySpec(s), gantryHits(s))
        }
        if (vp.setShowToolhead && (first || s.showToolhead !== prev.showToolhead)) vp.setShowToolhead(s.showToolhead)
        if (vp.setShowGantry && (first || s.showGantry !== prev.showGantry)) vp.setShowGantry(s.showGantry)
        if (vp.setFollowNozzle && (first || s.followNozzle !== prev.followNozzle)) vp.setFollowNozzle(s.followNozzle)
        if (first || s.plate !== prev.plate || s.bed !== prev.bed || s.overrides !== prev.overrides || s.easy !== prev.easy) (vp as unknown as Viewport).setBedAlert?.(s.plate.some((e) => objectWarnings(e, s).some((w) => w.kind === 'off-bed')))
        if (first || s.zoneHover !== prev.zoneHover) (vp as unknown as Viewport).setZoneHighlight?.(s.zoneHover)
        // How Slice shows that the plate is sliced: layer lines on the models, or the
        // toolpaths in their place with the hovered model solid; models stay solid while the slice is out of date.
        if (first || s.sliceLook !== prev.sliceLook || s.workspace !== prev.workspace || s.modelMode !== prev.modelMode || s.preview !== prev.preview || s.slice !== prev.slice || s.easy !== prev.easy || s.overrides !== prev.overrides) {
          const plateView = s.workspace === 'prepare' && !designing(s)
          const stale = s.slice.status !== 'done' || s.slice.stale
          ;(vp as unknown as Viewport).setToolpathLook?.(plateView && s.sliceLook === 'toolpaths' && s.preview !== null, stale)
          ;(vp as unknown as Viewport).setPrintLook?.(plateView && s.sliceLook === 'print', Number(resolveConfig(s.easy, s.overrides)['layer_height']) || 0.2)
        }
        // Design models on a plain ground grid; the bed comes back in Slice. The camera stays where it is.
        if (first || s.modelMode !== prev.modelMode || s.workspace !== prev.workspace) (vp as unknown as Viewport).setGround?.(designing(s))
        // Model's reveal: its first open this session, or a job opened while it shows
        const revealNow = { model: designing(s), jobSeq: s.jobSeq }
        if (modelReveal(first ? null : { model: designing(prev), jobSeq: prev.jobSeq }, revealNow, revealMemory, prefersReducedMotion())) (vp as unknown as Viewport).playReveal?.()
        // The printer's no-print areas follow its profile and any override of them in printer settings.
        // Both are machine coordinates; the plate counts from the printable area's front left corner.
        if (first || s.profile !== prev.profile || s.overrides !== prev.overrides || s.easy !== prev.easy) {
          const cfg = resolveConfig(s.easy, s.overrides)
          const origin = areaOrigin(cfg['printable_area'])
          vp.setPreviewOrigin?.(origin[0], origin[1])
          const key = JSON.stringify([cfg['bed_exclude_area'] ?? null, origin])
          if (vp.setExcludedAreas && key !== excludedKey) {
            excludedKey = key
            vp.setExcludedAreas(polygonsToPlate(excludedPolygons(cfg['bed_exclude_area']), origin))
          }
        }
        if (first || s.colorMode !== prev.colorMode) vp.setColorMode(s.colorMode)
        // norn: the paths from before a change, shown faintly on request.
        if (first || s.norn.ghost !== prev.norn.ghost || s.norn.before !== prev.norn.before) vp.setPreviewGhost?.(s.norn.ghost && s.norn.before ? s.norn.before.preview : null)
        // Model draws geometry, not filament: the CAD gray with its edges (X-ray still works there); Slice keeps the look
        if (first || s.look !== prev.look || s.workspace !== prev.workspace || s.modelMode !== prev.modelMode) vp.setRenderMode(modelLook(s))
        if (!first && s.cameraSeq !== prev.cameraSeq) vp.view(s.camera, { animate: true })
        // Model frames the part so it is the biggest thing on screen: the whole model when Model opens or an object
        // is added, the selection when it changes outside a tool (keeping the angle), unless Settings keeps the
        // camera still on a pick.
        if (!first && designing(s) && s.cameraSeq === prev.cameraSeq) {
          if (!designing(prev) || s.plate.length > prev.plate.length) vp.view('iso', { animate: true })
          // a Select Other pick keeps the camera: the same spot must still have the same things under it
          else if (s.appearance.modelFraming === 'selection' && s.objectTool === null && !framingIsHeld() && (s.selection !== prev.selection || s.selectedIds !== prev.selectedIds)) {
            const now = selectedIds(s)
            if (now.length > 0 && now.join() !== selectedIds(prev).join()) (vp as unknown as Viewport).frameSelection?.({ animate: true })
          }
        }
        // The look and feel picks the mouse map; overrides from Settings sit on top.
        if ((first || s.lookAndFeel !== prev.lookAndFeel) && vp.setControls && vp.controlsApi) vp.setControls(controlsFor(vp.controlsApi, s.lookAndFeel ?? { id: defaultLook.current }))
        prev = s
      }
      vp.setMode(modeRef.current)
      apply(prev, true)
      // The backdrop follows the theme, now and on every change.
      // The look (lights, materials, plate and backdrop) follows it too: one preset per scheme, viewport-look.ts.
      const syncScene = () => {
        vp.setTheme?.(viewportTheme(appStore.getState().appearance.colorVision === 'standard' ? 'standard' : 'colorblind'))
        if (vp.setLook && vp.look) syncViewportLook({ setLook: vp.setLook.bind(vp), look: vp.look.bind(vp) })
      }
      syncScene()
      offs.push(onThemeChange(syncScene))
      offs.push(appStore.subscribe((s, p) => s.appearance.colorVision !== p.appearance.colorVision && syncScene()))
      offs.push(appStore.subscribe((s) => apply(s, false)))
      // The loading wisp runs the plate edge once a loading model is drawn, until the open is done.
      let wispOn = false
      const syncWisp = () => {
        const on = appStore.getState().plateLoading && openStagesPassed().has('drawn')
        if (on === wispOn) return
        wispOn = on
        ;(vp as unknown as Viewport).setLoadingWisp?.(on)
      }
      offs.push(appStore.subscribe(syncWisp), onOpenStage(syncWisp))
      // The selected printer's extruder areas come from its profile, loaded when the printer changes.
      let areasFor: string | null | undefined
      const loadAreas = (id: string | null) => {
        if (id === areasFor) return
        areasFor = id
        void loadExtruderAreas(id).then((areas) => {
          if (areasFor === id) set({ extruderAreas: areas })
        })
      }
      loadAreas(appStore.getState().printerId)
      offs.push(appStore.subscribe((s) => loadAreas(s.printerId)))
      // Model's box select: on with no tool open; the box picks objects, the first one primary.
      const boxOn = (st: AppState) => vp.setBoxSelect?.(showsDesign(st) && st.objectTool === null)
      boxOn(appStore.getState())
      offs.push(appStore.subscribe((st, prev) => {
        if (st.workspace !== prev.workspace || st.modelMode !== prev.modelMode || st.objectTool !== prev.objectTool) boxOn(st)
      }))
      offs.push(vp.on('boxselect', (e) => set({ selectedIds: e.ids, selection: e.ids[0] ?? null, towerSelected: false })))
      const selectObject = (e: { objectId: string | null; toggle?: boolean }) => {
        if (e.objectId === TOWER_ID) return void set({ towerSelected: true, selection: null })
        // Ctrl (Cmd) adds the object to the selection or takes it out, as the view does
        if (e.toggle && e.objectId) return void set(toggledSelection(appStore.getState(), e.objectId))
        set({ selection: e.objectId, towerSelected: false })
      }
      // The open in progress is on screen once a frame with its objects is drawn.
      offs.push(vp.on('platedrawn', (e) => {
        const stats = (vp as Partial<Pick<Viewport, 'stats'>>).stats?.bind(vp)
        // A viewport stand-in without the split leaves it out.
        markViewDrawn(mountedAt, stats?.().firstDrawMs ?? null, () => ({ ...(stats?.().startup ?? {}) }))
        if (e.built + e.kept > 0) markOpenStage('drawn')
      }))
      // A big model's creased shading and edges, made in the mesh workers after it first showed.
      offs.push(vp.on('platerefined', () => markOpenStage('refined')))
      offs.push(vp.on('pick', (e) => {
        // A modeling tool is listening: the click is its input and the selection stays.
        if (toolStore.getState().tool === 'probe') return void probeHandler()?.(e)
        // Painting: a click that misses the model (beside it, between its arms, or while the view still turns) keeps the
        // object being painted, so the next stroke still paints it. A click on another object paints that one instead.
        if (toolStore.getState().tool === 'paint' && !e.objectId) return
        // Model with Faces or Edges in the pick filter: the click picks a face or an edge (plate/sub-pick.ts).
        const st = appStore.getState()
        const click = async () => {
          if (showsDesign(st) && st.pickFilter.some((k) => k !== 'object')) {
            if (!(await pickSub(e, edgeAt, faceRound, edgeWinsFor(st)))) selectObject(e)
          } else selectObject(e)
        }
        // Select Other: a plain click on the same spot again steps to the next thing under it (plate/select-other-pick.ts).
        if (selectOtherOn(st) && !e.shift && !e.toggle && e.objectId && e.objectId !== TOWER_ID && vp.pickAll) return void otherPick().then((m) => m.clickAt(e, click))
        void click()
      }))
      // Model: a right click or the menu key opens the ring for what is under it (workspaces/design/view-ring.tsx), as
      // a touch held still does outside Select Other: with Faces or Edges in the pick filter the face or edge, picked first unless it already is;
      // else the object, selected first; else empty space. The menu key opens it for what is picked.
      const ringFor = (e: ViewportEvents['contextpick']) => {
        const st = appStore.getState()
        if (phoneView(st) === 'slim' || st.workspace !== 'prepare' || st.modelMode !== 'design' || st.objectTool !== null) return
        const at = { x: e.screen[0], y: e.screen[1] }
        if (e.key) return openViewRing(at, ringTarget(st))
        if (!e.objectId || e.objectId === TOWER_ID) {
          if (st.subPicks.length) set({ subPicks: [] })
          return openViewRing(at, { kind: 'empty' })
        }
        const objectId = e.objectId
        if (st.pickFilter.some((k) => k !== 'object') && e.partIndex !== null && e.triangle !== null && e.point) {
          const already = st.subPicks.some((p) => p.objectId === objectId && p.partIndex === e.partIndex && p.triangle === e.triangle)
          const ready = already ? Promise.resolve(true) : pickSub({ objectId, partIndex: e.partIndex, triangle: e.triangle, point: e.point, bed: null, screen: e.screen }, edgeAt, faceRound, edgeWinsFor(st))
          void ready.then((done) => {
            const now = appStore.getState()
            openViewRing(at, done && now.subPicks.length ? ringTarget(now) : { kind: 'object', objectId })
          })
          return
        }
        if (!selectedIds(st).includes(objectId)) selectObject(e)
        if (st.subPicks.length) set({ subPicks: [] })
        openViewRing(at, { kind: 'object', objectId })
      }
      offs.push(vp.on('contextpick', ringFor))
      // Select Other (plate/select-other.ts): a press or a finger held still on a model opens the list of everything
      // under it; on a phone the list's More actions opens the ring a held finger opened before.
      let pointerAt: [number, number] | null = null
      const canvas = () => stage.querySelector<HTMLCanvasElement>('canvas')
      const onPointer = (ev: PointerEvent) => {
        pointerAt = ev.buttons === 0 ? [ev.clientX, ev.clientY] : pointerAt
        const tag = selectOther.getState().tag
        if (tag && Math.hypot(ev.clientX - tag.at.x, ev.clientY - tag.at.y) > 16) hideOtherTag()
      }
      const onLeave = () => void (pointerAt = null)
      stage.addEventListener('pointermove', onPointer)
      stage.addEventListener('pointerleave', onLeave)
      offs.push(() => {
        stage.removeEventListener('pointermove', onPointer)
        stage.removeEventListener('pointerleave', onLeave)
      })
      if (vp.pickAll) {
        const all = vp.pickAll.bind(vp)
        setOtherView({
          pickAll: all,
          edgeAt,
          faceRound,
          screenOf: (p) => vp.screenOf?.(p) ?? null,
          rect: () => (canvas() ?? stage).getBoundingClientRect(),
          ring: (at) => {
            const h = all(at[0], at[1])[0]
            ringFor({ objectId: h?.objectId ?? null, partIndex: h?.partIndex ?? null, triangle: h?.triangle ?? null, point: h?.point ?? null, screen: at })
          },
          pointer: () => pointerAt,
          focus: () => canvas()?.focus({ preventScroll: true }),
        })
        offs.push(() => setOtherView(null))
      }
      offs.push(vp.on('holdpick', (e) => void otherPick().then((m) => m.holdAt(e.screen, e.touch, e.hits))))
      const holdOn = (s: AppState) => vp.setHoldPick?.(selectOtherOn(s) && phoneView(s) !== 'slim')
      holdOn(appStore.getState())
      offs.push(appStore.subscribe((s, prev) => {
        if (s.workspace !== prev.workspace || s.modelMode !== prev.modelMode || s.objectTool !== prev.objectTool || s.settingsMode !== prev.settingsMode) holdOn(s)
        // the tag names what the click picked: anything picked since takes it away
        if (s.subPicks !== prev.subPicks || s.selectedIds !== prev.selectedIds || s.selection !== prev.selection) hideOtherTag()
      }))
      // Lay on bed from the ring: the last picked face of the object, as lay on face takes it.
      setLayFace((objectId) => {
        const face = appStore.getState().subPicks.filter((p) => p.kind === 'face' && p.objectId === objectId).at(-1)
        const pick = face ? vp.facePickAt?.(face.objectId, face.partIndex, face.triangle) : null
        return pick ? layOnPickedFace(pick) : false
      })
      offs.push(() => setLayFace(null))
      // A right click on an object in Slice opens the selection's menu there; outside the selection it selects first.
      offs.push(vp.on('contextpick', (e) => {
        const st = appStore.getState()
        // a phone views and prints: no edit menu on the plate
        if (isPhoneLayout() || st.workspace !== 'prepare' || st.modelMode !== 'slice' || st.objectTool !== null || !e.objectId || e.objectId === TOWER_ID) return
        if (!selectedIds(st).includes(e.objectId)) selectObject(e)
        openViewMenu(e.screen[0], e.screen[1])
      }))
      // The picked faces light up and picked edges draw as bars; the face filter lights the face under the pointer, and
      // the edge filter shows the edge a click would pick.
      // With the new Model feel the face filter also asks for the edge under the pointer, and an edge within EDGE_WINS_PX
      // lights instead of the face (`edgeWon`), as a click there would pick it.
      let hoverLines: { from: [number, number, number]; to: [number, number, number] }[] = []
      let edgeWon = false
      const showPicks = (s: AppState) => {
        const inModel = showsDesign(s)
        const free = inModel && s.objectTool === null
        const feel = free && s.pickFilter.includes('face') && edgeWinsFor(s) !== undefined
        if (!feel) edgeWon = false
        // a row of Select Other's list under the pointer or focus shows what it would pick
        const hover = inModel ? selectOther.getState().hover : null
        const faces = inModel ? s.subPicks.filter((p) => p.kind === 'face') : []
        vp.setSelectedFaces?.(hover?.kind === 'face' ? [...faces, hover] : faces)
        vp.setPickFaces?.(free && s.pickFilter.includes('face') && !edgeWon)
        const edges = (free && s.pickFilter.includes('edge') && !s.pickFilter.includes('face')) || feel
        vp.setPickEdges?.(edges)
        if (!edges) hoverLines = []
        vp.setPickedEdges?.(inModel ? s.subPicks.flatMap((p) => p.lines ?? []) : [], hover?.kind === 'edge' ? (hover.lines ?? []) : hoverLines)
      }
      // An edge wins when its lines pass within EDGE_WINS_PX of the pointer on screen; off without the flag.
      const edgeWinsFor = (s: AppState): EdgeWins | undefined =>
        modelFeelFor(s.settingsMode) ? (lines, at) => screenDistance(at, lines, (p) => vp.screenOf?.(p) ?? null) <= EDGE_WINS_PX : undefined
      // The edge under the pointer, from the engine, at most one question at a time.
      let asking = 0
      offs.push(vp.on('edgehover', (h) => {
        const n = ++asking
        if (!h) {
          hoverLines = []
          edgeWon = false
          return showPicks(appStore.getState())
        }
        void edgeAt(h.objectId, h.partIndex, h.triangle, h.point).then(
          (lines) => {
            if (n !== asking) return
            const st = appStore.getState()
            const wins = st.pickFilter.includes('face') ? edgeWinsFor(st) : undefined
            // Face filter with the new Model feel: the edge shows only when it is near enough to win.
            edgeWon = Boolean(wins && lines && wins(lines, h.screen))
            hoverLines = wins && !edgeWon ? [] : (lines ?? [])
            showPicks(st)
          },
          () => undefined,
        )
      }))
      showPicks(appStore.getState())
      // A body in Select Other's list shows as selected while its row is under the pointer or focus.
      offs.push(selectOther.subscribe((o, was) => {
        if (o.hover === was.hover) return
        const st = appStore.getState()
        showPicks(st)
        if (o.hover?.kind === 'body') vp.setSelection([o.hover.objectId])
        else if (was.hover?.kind === 'body') vp.setSelection(st.towerSelected ? [TOWER_ID] : selectedIds(st))
      }))
      // The store starts on Face. A developer who turned the Model feel off starts on whole objects instead, once a
      // session (the flag stays out of the startup shell); turning the flag over sets Face with it, whole objects without.
      if (!feelStarted) {
        feelStarted = true
        if (!modelFeelFor(appStore.getState().settingsMode)) set({ pickFilter: ['object'] })
      }
      offs.push(onModelFeel((on) => set({ pickFilter: on ? ['face'] : ['object'], subPicks: [] })))
      offs.push(appStore.subscribe((s, prev) => {
        if (s.subPicks !== prev.subPicks || s.plate !== prev.plate || s.pickFilter !== prev.pickFilter || s.objectTool !== prev.objectTool || s.modelMode !== prev.modelMode || s.workspace !== prev.workspace || s.settingsMode !== prev.settingsMode) showPicks(s)
      }))
      // Final transforms that land in the same frame (an arrange moves every object) are one undo step.
      let pending: Record<string, number[]> | null = null
      offs.push(vp.on('transform', (e) => {
        if (!e.final) return
        // The tower is not a plate object: a move is its new front left corner and turns auto off.
        if (e.id === TOWER_ID) return void moveTower(e.transform[12] as number, e.transform[13] as number)
        if (!pending) {
          pending = {}
          requestAnimationFrame(() => {
            const batch = pending
            pending = null
            if (batch) commitTransforms(batch)
          })
        }
        pending[e.id] = e.transform
      }))
      if (vp.setPaintSettings) {
        offs.push((vp as unknown as Viewport).on('paintstroke', (stroke) => {
          fromViewport = true
          try {
            commitStroke({ objectId: stroke.objectId, partIndex: stroke.partIndex, layer: stroke.layer, edits: stroke.edits })
          } finally {
            fromViewport = false
          }
        }))
        // A change from the panel reads back through the same channel the wheel uses, so the panel shows what the brush has.
        setPaintBus({ set: (p) => { vp.setPaintSettings?.(p); paintBusChanged() }, get: () => vp.getPaintSettings?.() })
        offs.push(() => setPaintBus(null))
        offs.push((vp as unknown as Viewport).on('paintsettings', () => paintBusChanged()))
      }
      // The cut tool's plane: the panel's values go to the gizmo, and the gizmo's on release come back.
      if (vp.setCutPlane) {
        const cutVp = vp as unknown as Viewport
        const pushCut = () => {
          const { plane, keep, connectors } = cutStore.getState()
          cutVp.setCutPlane(plane ? { objectId: plane.objectId, point: plane.point, normal: plane.normal, keep, placeConnectors: connectors.placing } : null)
        }
        pushCut()
        offs.push(cutStore.subscribe(pushCut))
        offs.push(cutVp.on('cutplane', (e) => {
          if (e.final && cutStore.getState().plane?.objectId === e.objectId) cutStore.setState({ plane: { objectId: e.objectId, point: e.point, normal: e.normal } })
        }))
        offs.push(cutVp.on('cutconnector', (e) => {
          if (cutStore.getState().plane?.objectId === e.objectId) toggleConnector(e.point)
        }))
      }
      // Tools: the viewport has handles for move, rotate and scale, and lay on face; the numeric fields work too.
      const applyTool = () => {
        // A phone in Slice views and prints: a tap selects and a drag turns the view, and nothing on the plate moves.
        // A phone in Model keeps the handles, so a finger moves a model only by its arrows, rings or corners, never by
        // dragging the model itself.
        const phone = phoneView(appStore.getState())
        const t = phone === 'slim' ? 'select' : toolStore.getState().tool
        vp.setMovable?.(!phone)
        vp.setTool?.(viewportTool(t, phone, !!brimVp.setBrimEars))
        vp.setRotateSpace?.(toolStore.getState().rotateSpace)
        // a phone in Model has no drag on the model itself, so the arrows are how Move works there
        vp.setMoveHandles?.(t === 'move' && (phone === 'model' || toolStore.getState().moveArrows))
        brimVp.setBrimHoverRadius?.(t === 'brim' ? headDiameter() / 2 : null)
      }
      offs.push(onHeadDiameter(applyTool))
      offs.push(brimVp.on('brimadd', (e) => void addEar(e.objectId, e.point[0], e.point[1])))
      offs.push(brimVp.on('brimremove', (e) => void removeEar(e.objectId, e.index)))
      offs.push(brimVp.on('brimselect', (e) => selectEars(e.objectId, e.indices, e.mode)))
      offs.push(brimVp.on('brimmove', (e) => void moveEar(e.objectId, e.index, e.point[0], e.point[1], e.final)))
      offs.push(
        brimVp.on('brimwheel', (e) => {
          // Ctrl and the wheel change the head diameter by 0.1 mm a notch, for the selected ears and the next one.
          setHeadDiameter(headDiameter() + e.delta * 0.1)
          const id = appStore.getState().selection
          if (id) resizeSelectedEars(id, headDiameter())
        }),
      )
      offs.push(onEarSelection(() => pushEars(appStore.getState())))
      applyTool()
      offs.push(toolStore.subscribe(applyTool))
      offs.push(onPhoneLayout(applyTool))
      offs.push(appStore.subscribe((s, p) => {
        if (s.workspace !== p.workspace || s.modelMode !== p.modelMode) applyTool()
      }))
      if (vp.setTool) offs.push((vp as unknown as Viewport).on('facepick', (pick) => void layOnPickedFace(pick)))
      // The view preset the camera is at (a key, a button or a command chose it), null once it is turned by hand.
      let cameraPreset: string | null = 'iso'
      offs.push(vp.on('camera', (e) => {
        cameraPreset = e.preset
      }))
      setCameraBus({
        view: (preset, o) => vp.view(preset, o),
        ...(vp.zoomToSelection ? { zoomToSelection: (o?: { animate?: boolean }) => vp.zoomToSelection?.(o) } : {}),
        ...(vp.zoomToBed ? { zoomToBed: (o?: { animate?: boolean }) => vp.zoomToBed?.(o) } : {}),
        ...(vp.zoomBy ? { zoomBy: (f: number, o?: { animate?: boolean }) => vp.zoomBy?.(f, o) } : {}),
        ...(vp.focusBedPoint ? { focusBedPoint: (x: number, y: number, z: number, o?: { animate?: boolean }) => vp.focusBedPoint?.(x, y, z, o) } : {}),
        ...(vp.toggleProjection ? { toggleProjection: () => vp.toggleProjection?.() } : {}),
        ...(vp.getCamera ? { pose: () => ({ ...vp.getCamera!(), ...(vp.getProjection ? { projection: vp.getProjection() } : {}), preset: cameraPreset }) } : {}),
        ...(vp.setGuides ? { guides: (g: Parameters<Viewport['setGuides']>[0]) => vp.setGuides?.(g), probeFaces: (on: boolean) => vp.setProbeFaces?.(on) } : {}),
        ...(vp.arrange ? { arrange: (o?: { animate?: boolean; gapMm?: number }) => vp.arrange?.(o) ?? {} } : {}),
        ...('setPush' in vp ? { cad: vp as unknown as CadView } : {}),
      })
      offs.push(() => setCameraBus(null))
      // Kept dimensions: their code loads the first time an object has one or the toggle goes on.
      if ('setDimensions' in vp) {
        let stopDims: (() => void) | null = null
        let loading = false
        const startDims = (s: AppState) => {
          if (stopDims || loading || !(s.showDimensions || s.plate.some((e) => e.dimensions?.length))) return
          loading = true
          void import('../cad/dimension-view').then((m) => {
            if (!disposed) stopDims = m.startDimensions(vp as unknown as CadView)
          })
        }
        startDims(appStore.getState())
        offs.push(appStore.subscribe(startDims))
        offs.push(() => stopDims?.())
      }
      // Fit check gaps follow their own store; the viewport draws them over the objects.
      if (vp.setGapLines) {
        vp.setGapLines(fitLines())
        offs.push(subscribeFits(() => vp.setGapLines?.(fitLines())))
      }
      // norn: a click on a toolpath in Preview opens the settings that made it; a click on nothing closes them.
      // The preview numbers objects as the slice request listed them: the printable entries in plate order.
      if (vp.setPreviewGhost)
        offs.push(
          vp.on('pathpick', (e) =>
            set((s) => ({ norn: { ...s.norn, pick: e ? { feature: e.feature, layer: e.layer, gcodeLine: e.gcodeLine, screen: e.screen, objectId: e.object >= 0 ? (s.plate.filter((p) => p.printable !== false)[e.object]?.id ?? null) : null } : null } })),
          ),
        )
      // Point markers: shown from the legend. Wipes, tool changes and pauses are read from the G-code the first
      // time one of them is on for a preview; the viewport keeps them until the next preview.
      if (vp.setMarkers) {
        let markersFor: PreviewBuffers | null = null
        const syncMarkers = () => {
          const m = markerView.getState()
          vp.setMarkers?.(m.shown)
          const p = appStore.getState().preview
          if (!p || p === markersFor || !wantsGcodeMarkers(m) || !vp.setGcodeMarkers) return
          markersFor = p
          void import('../workspaces/preview/marker-data')
            .then((d) => d.markerPositions(host, p))
            .then((pos) => {
              if (appStore.getState().preview !== p) return
              vp.setGcodeMarkers?.(pos)
              markerView.setState({ counts: { wipes: pos.wipes.length / 3, toolChanges: pos.toolChanges.length / 3, pauses: pos.pauses.length / 3 } })
            })
            .catch(() => {
              if (markersFor === p) markersFor = null
            })
        }
        syncMarkers()
        offs.push(markerView.subscribe(syncMarkers))
        offs.push(
          appStore.subscribe((s, p) => {
            if (s.preview === p.preview) return
            markerView.setState({ counts: {} })
            syncMarkers()
          }),
        )
      }
      // A phone keeps the notice in the top bar (top-bar.tsx): a toast there landed over mimir's conversation.
      offs.push(
        vp.on('degrade', (e) => {
          // the toast shows the first sentence on one line, with the reason behind Details
          const text = e.details ? `${e.message} ${e.details}` : e.message
          set({ viewNotice: text })
          // told once a visit, with a close mark; the next view (another tab, the view started again) says the same thing
          if (!isPhoneLayout() && !toldNotices.has(text)) {
            toldNotices.add(text)
            toast(text, 'info', undefined, {})
          }
        }),
      )
      offs.push(vp.on('error', (e) => toast(e.message, 'error')))
    })
    return () => {
      disposed = true
      for (const off of offs) off()
      vpRef.current?.dispose()
      vpRef.current = null
      stage.replaceChildren()
    }
  }, [host, attempt])

  // With the toolpaths showing, the legend, the layer strip and the playback bar cover parts of the view: the viewport frames the plate's content in the free area.
  // In mimir, its lookup cards do the same along the bottom.
  useEffect(() => {
    const stage = stageRef.current
    const root = stage?.parentElement
    if (!stage || !root) return
    const send = () => {
      const vp = vpRef.current
      if (!vp?.setInsets) return
      const box = (r: DOMRect) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
      if (!layers) {
        // mimir's lookup cards take a band along the bottom: the part is framed above it. Its sizes panel takes the
        // right side, so the part is framed beside it.
        const band = root.querySelector<HTMLElement>('.mimir-lookups')
        const bottom = band ? Math.max(0, stage.getBoundingClientRect().bottom - band.getBoundingClientRect().top + OVERLAY_GAP) : 0
        const side = root.querySelector<HTMLElement>('.mimir-sheet-panel')
        const right = side ? Math.max(0, stage.getBoundingClientRect().right - side.getBoundingClientRect().left + OVERLAY_GAP) : 0
        return vp.setInsets({ left: 0, right, top: 0, bottom })
      }
      const rects = [...root.querySelectorAll<HTMLElement>('.sx-overlay')].filter((e) => e.offsetParent !== null).map((e) => box(e.getBoundingClientRect()))
      vp.setInsets(overlayInsets(box(stage.getBoundingClientRect()), rects))
    }
    const ro = new ResizeObserver(send)
    const watched = new Set<Element>()
    const watch = () => {
      const now = new Set<Element>([stage, ...root.querySelectorAll('.sx-overlay')])
      for (const e of watched) {
        if (!now.has(e)) {
          ro.unobserve(e)
          watched.delete(e)
        }
      }
      for (const e of now) {
        if (!watched.has(e)) {
          ro.observe(e)
          watched.add(e)
        }
      }
      send()
    }
    const mo = new MutationObserver(watch)
    mo.observe(root, { childList: true, subtree: true })
    watch()
    const late = window.setTimeout(watch, 600)
    // The lookup cards slide up over an opening timeline without resizing: frame again once they settle.
    const moved = (e: TransitionEvent) => {
      if ((e.target as Element).classList?.contains('mimir-lookups')) send()
    }
    root.addEventListener('transitionend', moved)
    return () => {
      window.clearTimeout(late)
      root.removeEventListener('transitionend', moved)
      mo.disconnect()
      ro.disconnect()
    }
  }, [layers])

  // The filament slot the viewport picks out, for tests and styles (null draws nothing).
  const highlight = useApp((s) => s.hoverSlot)
  return <div ref={stageRef} className="vp-stage" data-mode={mode} data-highlight={highlight ?? undefined} />
}
