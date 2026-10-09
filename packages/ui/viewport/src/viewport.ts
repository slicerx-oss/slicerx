// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// createViewport: owns the renderer, the scene graph and the render loop.
// Frames are rendered on demand; the GPU idles when nothing changes, and the
// loop pauses while the canvas is offscreen or the page is hidden.
import { FirstFrameGate } from './firstframe'
import { gpuProfile } from './gpu'
import type { ToolChangerSpec } from './toolchanger'
import type { PurgePlan } from './purge'
import type { HeadModel } from './heads'
import {
  DoubleSide,
  FrontSide,
  BufferAttribute,
  BufferGeometry,
  Box3,
  Color,
  Matrix3,
  Matrix4,
  MeshBasicMaterial,
  Mesh,
  NoToneMapping,
  PerspectiveCamera,
  Plane,
  Raycaster,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Group,
  type Material,
  type Object3D,
} from 'three'
import type { DragAction } from './controls'
import { facePatch } from './faces'
import { Painter, type PaintHit } from './painter'
import { ScaleGizmo } from './gizmo'
import { RingSet, angleAround, pickRing, rayPlane, ringAxes, rotateAbout, snapAngle, turnVector, unit, unwrapAngle, type RingAxis, type RotateSpace } from './rings'
import { CutGizmo, CutPreview, extentAlong, movePlane, tiltAxes, type CutKeep } from './cutplane'
import { DimensionLayer, EdgePreview, PushPreview, SketchLayer, fromPlane, rayOnPlane, type DimensionMark, type SketchCursor, type SketchScene, type V2 } from './cadtools'
import { clampScale, factorsFor, handleAxis, handleLocal, minFactorFor, nearestOnLine, pivotFor, ratioLine, ratioPivotFor, ratioPlane, ratioPoint, scaleTransform, snapScale, type HandleId, type V3 } from './scaling'
import type { ModKey } from './gizmobindings'
import { layerTopsProblems } from './layerheights'
import { FEATURE_COLORS, SCENE, resolveTheme, type ResolvedTheme, type ViewportTheme } from './palette'
import { summarizePreview, type PreviewSummary } from './summary'
import { CONTROL_PRESETS, buttonName, dragStartsOnModel, modifiersOf, orbitCodeFor, resolveDrag, resolveWheel, type ControlsMap, type ControlsPresetId } from './controls'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { PreviewBuffers } from '@slicerx/contracts'
import { BrimEars } from './brim'
import { GapLines, type GapLine } from './gaps'
import { GuideLines, type Guides } from './guides'
import { applyInsets, CameraRig, NO_INSETS, reducedMotion, type Insets } from './camera'
import { MaterialCache, setSharedBandColors, setSharedLayerTops, setSharedSceneColors, shared, sharedMaterials } from './materials'
import { buildObject, disposeObject, type ObjectEntry } from './model'
import { Pipeline } from './post'
import { Stage } from './stage'
import { FrameProbe, probeRequested, type ProbeStats } from './probe'
import { Toolpaths, warmupBuffers } from './toolpaths'
import { Strikes, type StrikeMark } from './strikes'
import type { GantryHit, GantrySpec } from './gantry'
import type {
  CameraState,
  CutPlaneSpec,
  PushEvent,
  PushSpec,
  EdgePreviewSpec,
  SketchEvent,
  ColorMode,
  PartStyle,
  FacePick,
  LegendFeature,
  MarkerKind,
  PreviewExtras,
  PreviewRanges,
  PaintLayer,
  PaintSettings,
  PlateTool,
  Quality,
  RenderMode,
  DisplayStyle,
  Projection,
  ViewPreset,
  Viewport,
  ViewportEvents,
  ViewportMode,
  ViewportOptions,
  ViewportPlate,
  ViewportStats,
  ToolpathFinish,
  PlateStyle,
} from './types'

const RING = 600
const SETTLE_FRAMES = 3
/** Field of view of the orthographic stand-in, degrees. */
const ORTHO_FOV = 1
const DEG = Math.PI / 180
const dot3 = (a: readonly number[], b: readonly number[]): number => (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0)
/** The push distance in words, next to the cursor while dragging. */
const pushLabel = (d: number): string => (d < 0 ? `Cuts ${(-d).toFixed(1)} mm` : `Adds ${d.toFixed(1)} mm`)

class Ring {
  private readonly data = new Float32Array(RING)
  private n = 0
  private i = 0
  push(v: number): void {
    this.data[this.i] = v
    this.i = (this.i + 1) % RING
    this.n = Math.min(RING, this.n + 1)
  }
  values(): number[] {
    const out: number[] = []
    for (let k = 0; k < this.n; k++) out.push(this.data[(this.i - this.n + k + RING) % RING] ?? 0)
    return out
  }
  clear(): void {
    this.n = 0
    this.i = 0
  }
}

/** How long an object that left the plate stays built, for a plate switch that brings it back. */
const PARK_MS = 10_000

/** Whether the parts are the very arrays an object was built from (identity, not contents: comparing contents of a big model would cost what a rebuild saves). */
function sameArrays(from: readonly [Float32Array, Uint32Array | Uint16Array][] | undefined, parts: readonly { positions: Float32Array; indices: Uint32Array | Uint16Array }[]): boolean {
  return !!from && from.length === parts.length && parts.every((p, i) => from[i]![0] === p.positions && from[i]![1] === p.indices)
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const k = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[k] ?? 0
}

function gpuName(r: WebGLRenderer): string {
  const gl = r.getContext()
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  if (!ext) return 'unknown'
  const v: unknown = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
  return typeof v === 'string' ? v : 'unknown'
}

type Listener = (payload: never) => void

interface Drag {
  entry: ObjectEntry
  kind: 'move' | 'rotate'
  start: number[]
  offset: [number, number]
  rel: { min: [number, number]; max: [number, number] }
  startX: number
  center: [number, number]
  startYaw: number
}

export function createViewport(canvas: HTMLCanvasElement, opts: ViewportOptions = {}): Viewport {
  return new ViewportImpl(canvas, opts)
}

/** Side length of moving frames, as a share of the still frame, that a high density screen starts with (0.7 is half the pixels). */
const MOTION_START_HIDPI = 0.7

/** A ring drag in progress (rotate tool and cut tilt): the turn so far follows the cursor around `center` on the ring's plane, or along its screen tangent when the ring was grabbed edge on. */
interface RingDrag {
  center: V3
  radius: number
  dir: V3
  from: V3
  angle: number
  edgeOn: boolean
  x0: number
  y0: number
  tangent: [number, number]
  rpx: number
}

interface PickHit {
  entry: ObjectEntry
  part: number
  point: Vector3
  face: number
  dir: Vector3
}

class ViewportImpl implements Viewport {
  readonly canvas: HTMLCanvasElement
  private readonly renderer: WebGLRenderer
  private readonly stage: Stage
  private readonly pipeline: Pipeline
  private readonly camera: PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly rig: CameraRig
  private readonly toolpaths = new Toolpaths()
  private readonly strikes = new Strikes()
  private readonly mats = new MaterialCache()
  private readonly objects = new Map<string, ObjectEntry>()
  private readonly listeners = new Map<keyof ViewportEvents, Set<Listener>>()
  private readonly frameMs = new Ring()
  private readonly renderMs = new Ring()
  private readonly costMs = new Ring()

  private readonly quality: Quality
  private readonly gpu: string
  private readonly weak: boolean
  private readonly adaptive: boolean
  private readonly maxPr: number
  private readonly ro: ResizeObserver | null
  private readonly io: IntersectionObserver | null
  private readonly cleanups: (() => void)[] = []
  private mode: ViewportMode = 'prepare'
  private renderMode: RenderMode = 'studio'
  private selection: string[] = []
  private controlsMap: ControlsMap = CONTROL_PRESETS.slicerx
  private spaceDown = false
  private projection: Projection = 'perspective'
  private display: DisplayStyle = 'edges'
  private pickFn: (e: { clientX: number; clientY: number }) => PickHit | null = () => null
  private faceOverlay: Mesh | null = null
  private faceKey = ''
  private featureMask = 0x7fff
  private painter!: Painter
  private readonly gizmo = new ScaleGizmo()
  private scaleDrag: { entry: ObjectEntry; kind: HandleId; start: number[]; box: Box3; startRay: { o: V3; d: V3 }; pinAtStart: boolean; startRatioT: number | null } | null = null
  private keys = { shift: false, ctrl: false, alt: false }
  private painting: { x: number; y: number; pointerId: number } | null = null
  private layerTops: number[] | null = null
  private layerBand = true
  private summary: PreviewSummary | null = null
  private summaryFor: PreviewBuffers | null = null
  private theme: ResolvedTheme = resolveTheme()
  private faceColor: string = SCENE.selection
  private perspFov = 30
  private aoLevel = 1
  private tool: PlateTool = 'select'
  private pr = 1
  private aoOn: boolean
  private dirty = true
  private shadowDirty = true
  private raf = 0
  private lastRenderT = 0
  private frameIdx = 0
  private frames = 0
  /** Frames left in the fade-in of full-quality effects after the camera stops. */
  private settle = 0
  private slow = 0
  private scrubbed = false
  private motionSeeded = false
  private slowFrames = 0
  private fastFrames = 0
  private raiseAfter = 45
  private raisedAt = 0
  private onscreen = true
  private gpuTiming = false
  private probe: FrameProbe | null = null
  private disposed = false
  private previewSetAt: number | null = null
  private previewGen = 0
  private readonly firstFrame = new FirstFrameGate()
  private afterFrame: (() => void) | null = null
  private cameraMoved = false
  private firstFrameMs: number | null = null
  /** The part arrays each object was built from, by object id: the same arrays again keep the built object. */
  private readonly builtFrom = new Map<string, [Float32Array, Uint32Array | Uint16Array][]>()
  /** Objects built (not kept) by setPlate since the viewport started. */
  private objectBuilds = 0
  /** The last setPlate, until the frame that draws it. */
  private plateSet: { at: number; buildMs: number; built: number; kept: number } | null = null
  /** Objects off the plate, still built, by id, until PARK_MS passes without them coming back. */
  private readonly parked = new Map<string, { entry: ObjectEntry; from: [Float32Array, Uint32Array | Uint16Array][]; timer: ReturnType<typeof setTimeout> }>()
  private arrangeAnim: ((now: number) => boolean) | null = null
  private dragState: Drag | null = null
  private get drag(): Drag | null {
    return this.dragState
  }
  private set drag(d: Drag | null) {
    const was = this.dragState !== null
    this.dragState = d
    if (was !== (d !== null)) this.applyToolpathLook()
  }
  // Toolpath look: in the plate view the sliced toolpaths stand in for the models. The model under the
  // pointer turns solid at once, every model is solid while one is dragged or the slice is out of date.
  private toolpathLook = { on: false, stale: false }
  private solidId: string | null = null
  private width = 1
  private height = 1
  private insets: Insets = NO_INSETS
  private readonly brim = new BrimEars()
  private readonly gaps = new GapLines()
  private readonly guides = new GuideLines()
  private ghost: Toolpaths | null = null
  private probeFaces = false
  private brimDrag: { kind: 'ear'; objectId: string; index: number; moved: boolean } | { kind: 'rect'; x0: number; y0: number; mode: 'add' | 'remove'; ear: { objectId: string; index: number } | null; moved: boolean } | null = null
  private brimRectEl: HTMLDivElement | null = null
  private readonly rotRings = new RingSet<RingAxis>(['x', 'y', 'z'])
  private rotSpace: RotateSpace = 'world'
  private rotDrag: (RingDrag & { entry: ObjectEntry; axis: RingAxis; start: number[]; shown: number; snapped: boolean }) | null = null
  private readonly cutGizmo = new CutGizmo()
  private readonly cutRings = new RingSet<'u' | 'v'>(['u', 'v'], { u: '#ff79c6', v: '#bd93f9' })
  private readonly cutPreview = new CutPreview()
  private cut: { entry: ObjectEntry; point: V3; normal: V3; keep: CutKeep; place: boolean } | null = null
  private cutDrag: ({ kind: 'move'; point0: V3; extent: [number, number]; t0: number | null; mmPerPx: number; x0: number; y0: number } | (RingDrag & { kind: 'tilt'; ring: 'u' | 'v'; normal0: V3 })) | null = null
  private gizmoLabel: HTMLDivElement | null = null
  private readonly pushView = new PushPreview()
  private readonly edgeView = new EdgePreview()
  private probeHover = false
  private push: PushSpec | null = null
  private pushDrag: { started: boolean; objectId: string; partIndex: number; triangle: number; point: V3; normal: V3; d0: number; d: number; snapped: boolean; t0: number | null; mmPerPx: number; x0: number; y0: number } | null = null
  private readonly sketchLayer = new SketchLayer()
  private sketchDrag: { handle: number } | null = null
  private readonly dims = new DimensionLayer()
  private readonly tmpRay = new Raycaster()

  constructor(canvas: HTMLCanvasElement, opts: ViewportOptions) {
    this.canvas = canvas
    let renderer: WebGLRenderer
    try {
      renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' })
    } catch (e) {
      throw new Error('The 3D view needs WebGL2. Turn on hardware acceleration in the browser settings, then reload.', { cause: e })
    }
    this.renderer = renderer
    renderer.autoClear = false
    renderer.info.autoReset = false
    renderer.outputColorSpace = SRGBColorSpace
    renderer.toneMapping = NoToneMapping
    const gpu = gpuProfile(gpuName(renderer), opts.gpuRenderer)
    this.gpu = gpu.name
    this.weak = gpu.weak
    if (gpu.software) {
      const message = gpu.fromShell
        ? `This computer has no graphics driver for 3D, so it is drawn on the processor (${gpu.name}) and the 3D view will be slow.`
        : 'Hardware acceleration looks off in this browser, so the 3D view will be slow. Turn it on in the browser settings and reload.'
      // Listeners attach after construction, so tell them on the next turn.
      setTimeout(() => this.emit('degrade', { message }), 0)
    }
    this.quality = opts.quality ?? (this.weak ? 'low' : 'high')
    this.adaptive = opts.adaptive ?? true
    this.maxPr = opts.maxPixelRatio ?? (this.weak ? 1.25 : 2)
    this.aoOn = this.quality !== 'low'
    canvas.tabIndex = 0
    canvas.setAttribute('aria-label', opts.label ?? '3D view of the plate. Drag to orbit, scroll to zoom.')
    canvas.style.touchAction = 'none'

    this.stage = new Stage(renderer, this.weak)
    if (probeRequested()) this.probe = new FrameProbe(renderer)
    this.pipeline = new Pipeline(renderer, this.quality)
    this.camera = new PerspectiveCamera(30, 1, 20, 1600)
    this.camera.position.set(260, 230, 330)
    this.controls = new OrbitControls(this.camera, canvas)
    const c = this.controls
    c.enableDamping = true
    c.dampingFactor = 0.085
    c.screenSpacePanning = true
    c.minDistance = 30
    c.maxDistance = 1500
    // Bottom view looks up at the plate, so the orbit may pass under it.
    c.maxPolarAngle = Math.PI
    this.applyControls()
    c.target.set(0, 30, 0)
    c.update()
    this.rig = new CameraRig(this.camera, this.controls)
    const onChange = (): void => {
      // OrbitControls also updates inside its pointer handlers, so its own return value can miss motion.
      this.cameraMoved = true
      this.invalidate()
    }
    const onStart = (): void => {
      this.rig.preset = null
      this.rig.move = null
    }
    c.addEventListener('change', onChange)
    c.addEventListener('start', onStart)
    this.cleanups.push(() => {
      c.removeEventListener('change', onChange)
      c.removeEventListener('start', onStart)
    })

    this.painter = new Painter(
      (id) => this.objects.get(id),
      this.stage.scene,
      () => this.invalidate(),
      (s) => this.emit('paintstroke', s),
      () => this.controlsMap.gizmo.paint,
    )
    this.painter.applyPreset()
    this.painter.onClip = () => this.applyClip()
    this.painter.onSettings = (s) => this.emit('paintsettings', { ...s, heightRangeMm: [...s.heightRangeMm] })
    this.stage.scene.add(this.gizmo.group)
    this.stage.previewRoot.add(this.toolpaths.root)
    this.toolpaths.root.add(this.strikes.root)
    this.stage.objectsRoot.add(this.brim.group)
    this.stage.objectsRoot.add(this.gaps.group)
    this.stage.objectsRoot.add(this.guides.group)
    this.stage.objectsRoot.add(this.rotRings.group, this.cutGizmo.group, this.cutRings.group, this.pushView.group, this.edgeView.group, this.sketchLayer.group, this.dims.group)
    this.stage.envSH.then(
      (sh) => {
        if (this.disposed) return
        this.toolpaths.setEnvironment(sh)
        this.invalidate()
      },
      (e: unknown) => {
        // Toolpaths keep their flat ambient light without the bake; only a real failure is worth a line in the console.
        if (!this.disposed) console.warn('Environment bake failed', e)
      },
    )
    this.stage.previewRoot.visible = false
    if (opts.controls) this.setControls(opts.controls)
    if (opts.theme) this.setTheme(opts.theme)

    this.ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resize()) : null
    this.ro?.observe(canvas)
    this.io =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver((en) => {
            this.onscreen = en[0]?.isIntersecting ?? true
            this.kick()
          })
        : null
    this.io?.observe(canvas)
    const onVis = (): void => this.kick()
    document.addEventListener('visibilitychange', onVis)
    this.cleanups.push(() => document.removeEventListener('visibilitychange', onVis))
    const onLost = (e: Event): void => {
      e.preventDefault()
      this.emit('error', { message: 'The graphics context was lost. Reload the view to continue.' })
    }
    canvas.addEventListener('webglcontextlost', onLost)
    this.cleanups.push(() => canvas.removeEventListener('webglcontextlost', onLost))
    this.bindPointer()
    this.resize()
    this.view('iso')
    // The warm-up compiles the bead shaders and shows the bead for a frame; it waits until the plate's first frame is on
    // screen. The compile shares the GPU thread with the compositor: started in the very next frame, it held that first
    // frame back, and on a software renderer (seconds of compiling) the plate showed late. So it starts two frames after,
    // and on a weak or software GPU a second later still.
    this.firstFrame.after(() =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (this.disposed) return
          if (this.weak) setTimeout(() => void (this.disposed || this.warmPreview()), 1000)
          else void this.warmPreview()
        }),
      ),
    )
  }

  /** Compiles the bead shaders in the background so the first real preview frame does not wait for them. */
  private async warmPreview(): Promise<void> {
    // A preview set before the first frame (a slice that finished while the view was being made, such as one run
    // behind first-run setup) compiles the shaders itself. Warming up would swap it for the warm-up bead and then clear it.
    if (this.toolpaths.segmentCount > 0) return
    const gen = this.previewGen
    const root = this.stage.previewRoot
    this.toolpaths.set(warmupBuffers())
    this.toolpaths.warmNozzle(true)
    root.visible = true
    await this.renderer.compileAsync(this.stage.scene, this.camera).catch(() => {
      // Best effort: if it fails, the first real preview frame compiles the shaders instead.
    })
    if (this.disposed) return
    // One frame with the warm-up bead and a shadow update also builds the shadow-pass program.
    this.shadowDirty = true
    this.afterFrame = () => {
      root.visible = this.pathsShown()
      if (this.previewGen === gen) {
        this.toolpaths.warmNozzle(false)
        this.toolpaths.set(null)
      }
      this.shadowDirty = true
    }
    this.invalidate()
  }

  // ---------- events ----------

  on<E extends keyof ViewportEvents>(event: E, cb: (payload: ViewportEvents[E]) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    const l = cb as Listener
    set.add(l)
    return () => set.delete(l)
  }

  private emit<E extends keyof ViewportEvents>(event: E, payload: ViewportEvents[E]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const l of set) (l as (p: ViewportEvents[E]) => void)(payload)
  }

  // ---------- loop ----------

  invalidate(): void {
    this.dirty = true
    this.kick()
  }

  private canRun(): boolean {
    return !this.disposed && this.onscreen && !(typeof document !== 'undefined' && document.hidden)
  }

  private kick(): void {
    if (this.raf || !this.canRun()) return
    this.raf = requestAnimationFrame(this.tick)
  }

  private readonly tick = (now: number): void => {
    this.raf = 0
    if (!this.canRun()) {
      this.lastRenderT = 0
      return
    }
    let moving = this.rig.step(now) || this.cameraMoved
    this.cameraMoved = false
    if (this.controls.update()) moving = true
    if (this.arrangeAnim && this.arrangeAnim(now)) moving = true
    // Scrubbing layers or moves redraws like orbiting: cheap frames while it changes, full quality once it stops.
    const camMoving = moving
    if (this.scrubbed) {
      this.scrubbed = false
      moving = true
    }
    if (moving) {
      this.dirty = true
      this.settle = SETTLE_FRAMES
    } else if (this.settle > 0) this.dirty = true
    if (this.dirty) {
      this.dirty = false
      // Moving frames skip AO and MSAA; once the camera stops, full quality returns and AO fades in.
      let aoMix: number
      if (moving) {
        // Fade AO out over a few frames instead of cutting it, so starting to orbit does not pop the plate and shadows.
        this.aoLevel = Math.max(0, this.aoLevel - 0.34)
        aoMix = this.aoLevel
      } else {
        aoMix = this.settle > 0 ? (SETTLE_FRAMES - this.settle + 1) / SETTLE_FRAMES : 1
        this.aoLevel = aoMix
      }
      if (!moving && this.settle > 0) this.settle--
      this.renderFrame(aoMix, moving)
      if (this.lastRenderT) this.trackFrame(now - this.lastRenderT)
      if (this.lastRenderT && moving) this.tuneMotionScale(now - this.lastRenderT)
      this.lastRenderT = now
      if (camMoving) this.emit('camera', { preset: this.rig.preset })
    } else {
      this.lastRenderT = 0
    }
    // Through kick, never a bare requestAnimationFrame: a listener that invalidated during this tick has already
    // queued the next one, and a second request would start a second loop that renders every frame again.
    if (moving || this.dirty || this.rig.move || this.arrangeAnim) this.kick()
  }

  /**
   * Resolution of moving frames follows the frame time: a GPU that cannot hold 60 fps at the full pixel count
   * draws orbit frames smaller (the last pass upsamples them) and sharpens again once frames are cheap.
   */
  private tuneMotionScale(dt: number): void {
    const p = this.pipeline
    if (dt > 22) {
      this.fastFrames = 0
      if (++this.slowFrames >= (dt > 45 ? 2 : 4)) {
        this.slowFrames = 0
        if (p.motionScale > 0.3) {
          // Area scales the cost, so the side length scales with the square root of the time to win back.
          p.motionScale = Math.min(p.motionScale - 0.05, p.motionScale * Math.sqrt(17 / dt))
          if (this.raisedAt && this.frames - this.raisedAt < 240) this.raiseAfter = Math.min(this.raiseAfter * 2, 960)
        }
      }
    } else if (dt < 19 && p.motionScale < 1) {
      this.slowFrames = 0
      if (++this.fastFrames >= this.raiseAfter) {
        this.fastFrames = 0
        p.motionScale = p.motionScale + 0.1
        this.raisedAt = this.frames
      }
    } else this.slowFrames = Math.max(0, this.slowFrames - 1)
  }

  private trackFrame(dt: number): void {
    this.frameMs.push(dt)
    if (!this.adaptive || !this.aoOn) return
    if (dt > 55) {
      if (++this.slow > 14) this.degrade()
    } else this.slow = Math.max(0, this.slow - 1)
  }

  private degrade(): void {
    this.aoOn = false
    this.slow = 0
    if (this.pr > 1) {
      this.pr = 1
      this.resize()
    }
    this.emit('degrade', { message: 'Ambient occlusion paused to keep the view smooth on this GPU.' })
  }

  private renderFrame(aoMix: number, moving: boolean): void {
    const t0 = performance.now()
    this.probe?.begin()
    this.renderer.info.reset()
    const bed = this.stage.bed
    this.rig.fitClip(Math.max(bed.widthMm, bed.depthMm, bed.heightMm * 0.6))
    if (this.shadowDirty) {
      this.renderer.shadowMap.needsUpdate = true
      this.shadowDirty = false
    }
    const outline: Object3D[] = []
    if (this.mode === 'prepare') {
      for (const id of this.selection) {
        const o = this.objects.get(id)
        if (o) outline.push(o.group)
      }
    }
    if (this.pathsShown()) {
      const camBed = this.camera.position.clone().applyMatrix4(this.stage.bedRoot.matrixWorld.clone().invert())
      this.toolpaths.setView(camBed, this.pipeline.size.height)
      this.ghost?.setView(camBed, this.pipeline.size.height)
    }
    this.stage.updateZoneLabels(this.camera, this.pipeline.size.height / this.pipeline.size.pixelRatio)
    this.painter.sync()
    this.gaps.follow((id) => this.objects.get(id)?.group.matrix)
    this.updateGizmo()
    // Only while their tool is on: the rings follow the selection, the cut gizmo its plane.
    if (this.tool === 'rotate' || this.rotRings.visible) this.updateRings()
    if (this.cut || this.cutGizmo.group.visible) this.updateCutGizmo()
    this.dims.fit(this.camera.fov, this.height)
    const ao = this.aoOn && aoMix > 0 && this.display !== 'wireframe' && !(this.mode === 'prepare' && this.renderMode === 'xray')
    const firstPreviewFrame = this.previewSetAt !== null && this.pathsShown()
    this.stage.bakePendingContact()
    this.pipeline.render(this.stage.scene, this.camera, { ao, aoMix, fast: moving, outline, frameIndex: this.frameIdx++ })
    this.probe?.end()
    // Timer queries are not used for this: on ANGLE's Metal backend they span queued work and read high.
    if (this.gpuTiming || firstPreviewFrame) this.pipeline.waitForGpu()
    const t1 = performance.now()
    this.renderMs.push(t1 - t0)
    if (this.gpuTiming) this.costMs.push(t1 - t0)
    this.frames++
    this.firstFrame.frame()
    if (this.afterFrame) {
      const f = this.afterFrame
      this.afterFrame = null
      f()
      this.invalidate()
    }
    if (this.previewSetAt !== null && this.pathsShown()) {
      this.firstFrameMs = t1 - this.previewSetAt
      this.previewSetAt = null
    }
    if (this.plateSet) {
      const p = this.plateSet
      this.plateSet = null
      this.emit('platedrawn', { buildMs: p.buildMs, drawMs: t1 - p.at, built: p.built, kept: p.kept })
    }
  }

  private resize(): void {
    if (this.disposed) return
    const w = Math.max(1, this.canvas.clientWidth)
    const h = Math.max(1, this.canvas.clientHeight)
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1
    if (this.frames === 0 || this.pr > 1 || !this.adaptive) this.pr = Math.min(dpr, this.maxPr)
    this.width = w
    this.height = h
    this.renderer.setPixelRatio(this.pr)
    this.renderer.setSize(w, h, false)
    this.pipeline.setSize(w, h, this.pr)
    // On a high density screen the first orbit starts at about half the pixels, so it is smooth from its first frame.
    // tuneMotionScale raises it while frames stay cheap; still frames are always drawn at the full size with MSAA.
    if (!this.motionSeeded) {
      this.motionSeeded = true
      if (this.pr >= 1.5) this.pipeline.motionScale = MOTION_START_HIDPI
    }
    this.camera.aspect = w / h
    this.applyInset()
    shared.gmin.value = this.pr >= 1.5 ? 6.5 : 4
    // Sizing the canvas clears it. The observer runs before the page paints, so drawing now keeps the old picture
    // from going blank for a frame when a panel or bar beside the view changes size.
    if (this.frames > 0 && this.canRun()) this.renderFrame(this.aoLevel, false)
    this.invalidate()
  }

  /** Reserves the bottom `px` of the view for an overlay: the picture shifts up and views frame the model above it. */
  setBottomInset(px: number): void {
    this.setInsets({ ...this.insets, bottom: px })
  }

  /**
   * Reserves the sides of the view that overlays cover (pixels): the picture centers in what is left and
   * views frame the model inside it. A camera still on a view preset frames again for the new free area.
   */
  setInsets(next: Insets): void {
    const r = (n: number) => Math.max(0, Math.round(n))
    const v = { left: r(next.left), right: r(next.right), top: r(next.top), bottom: r(next.bottom) }
    const old = this.insets
    if (v.left === old.left && v.right === old.right && v.top === old.top && v.bottom === old.bottom) return
    this.insets = v
    this.applyInset()
    if (this.rig.preset) this.view(this.rig.preset)
    this.invalidate()
  }

  private applyInset(): void {
    this.rig.free = applyInsets(this.camera, this.width, this.height, this.insets)
  }

  // ---------- modes ----------

  setMode(mode: ViewportMode): void {
    if (mode === this.mode) return
    this.mode = mode
    const pv = mode === 'preview'
    this.stage.objectsRoot.visible = !pv
    this.stage.previewRoot.visible = pv
    this.stage.setContactVisible(!pv && this.renderMode !== 'xray')
    this.shadowDirty = true
    this.applyToolpathLook()
    this.invalidate()
  }

  setToolpathLook(on: boolean, stale = false): void {
    if (on === this.toolpathLook.on && stale === this.toolpathLook.stale) return
    this.toolpathLook = { on, stale }
    this.applyToolpathLook()
  }

  /** The toolpaths are on screen: in Preview, or in the plate view with the toolpath look. */
  private pathsShown(): boolean {
    // Tools that work on the model's surface (painting, brim ears, lay on face, the modeling tools' picks) need it solid.
    const surface = this.tool === 'paint' || this.tool === 'brim' || this.tool === 'face' || this.tool === 'probe'
    return this.mode === 'preview' || (this.toolpathLook.on && !this.toolpathLook.stale && this.dragState === null && !surface)
  }

  private applyToolpathLook(): void {
    if (this.mode !== 'prepare') return
    const paths = this.pathsShown()
    this.stage.previewRoot.visible = paths
    this.stage.objectsRoot.visible = true
    for (const o of this.objects.values()) o.group.visible = !paths || o.id === this.solidId
    this.stage.setContactVisible(!paths && this.renderMode !== 'xray')
    this.shadowDirty = true
    this.invalidate()
  }

  /** The model under the pointer, for the toolpath look: solid the moment the pointer is over it, toolpaths again when it leaves. */
  private hoverSolid(id: string | null): void {
    if (!this.toolpathLook.on || id === this.solidId) return
    this.solidId = id
    this.applyToolpathLook()
  }

  setRenderMode(mode: RenderMode): void {
    this.renderMode = mode
    this.applyMaterials()
  }

  private applyMaterials(): void {
    this.cutPreview.detach()
    const x = this.renderMode === 'xray'
    const wire = this.display === 'wireframe'
    const sh = sharedMaterials()
    for (const o of this.objects.values()) {
      for (const p of o.parts) {
        const m = this.mats.get(this.renderMode, { color: p.color, finish: p.finish })
        // Clay and overhang materials are shared by every viewport on the page, so a page has one display style for them.
        ;(m as Material & { wireframe?: boolean }).wireframe = wire
        p.mesh.material = m
        p.mesh.castShadow = !x && !wire
        p.mesh.receiveShadow = !x && !wire
        p.mesh.renderOrder = x ? 2 : 0
        p.edges.material = x ? sh.edgeXray : sh.edgeDark
        p.edges.visible = x || this.display === 'edges'
      }
    }
    this.stage.setContactVisible(!x && this.mode === 'prepare')
    this.shadowDirty = true
    this.applyClip()
    this.syncCutPreview()
  }

  /** Puts the painter's clipping plane on the models' materials (nothing when it is off). */
  private applyClip(): void {
    const plane = this.painter?.clipPlane() ?? null
    this.renderer.localClippingEnabled = true
    const set = (m: Material | Material[]): void => {
      for (const mat of Array.isArray(m) ? m : [m]) {
        const had = (mat.clippingPlanes?.length ?? 0) > 0
        mat.clippingPlanes = plane ? [plane] : null
        if (had !== !!plane) mat.needsUpdate = true
      }
    }
    for (const o of this.objects.values()) {
      // The model being cut carries the cut's own clipping planes.
      if (o === this.cutPreview.entry) continue
      for (const p of o.parts) {
        set(p.mesh.material)
        set(p.edges.material)
      }
    }
    this.invalidate()
  }

  setDisplayStyle(style: DisplayStyle): void {
    if (style === this.display) return
    this.display = style
    this.applyMaterials()
  }

  setOverhangAngle(deg: number): void {
    shared.overhangDeg.value = Math.max(0, Math.min(89, deg))
    this.invalidate()
  }

  setLayerHeights(tops: ArrayLike<number> | null, opts: { band?: boolean } = {}): void {
    if (tops) {
      const problems = layerTopsProblems(tops)
      if (problems.length) throw new Error(`Invalid layer heights: ${problems.join('; ')}`)
    }
    this.layerTops = tops ? Array.from(tops) : null
    this.layerBand = opts.band ?? this.layerBand
    setSharedLayerTops(this.layerTops, this.layerBand)
    this.shadowDirty = true
    this.invalidate()
  }

  setLayerHeightBand(on: boolean): void {
    this.layerBand = on
    setSharedLayerTops(this.layerTops, on)
    this.invalidate()
  }

  setPrintLook(on: boolean, layerHeightMm = 0.2): void {
    shared.lines.value = on ? 1 : 0
    shared.layerH.value = Math.max(0.02, layerHeightMm)
    this.invalidate()
  }

  // ---------- plate ----------

  setPlate(plate: ViewportPlate, opts: { keepCamera?: boolean } = {}): void {
    const t0 = performance.now()
    this.stage.setBed(plate.bed, plate.surfaceLabel)
    this.stage.setNozzleZones(plate.zones ?? [])
    if (plate.excluded) this.stage.setExcludedAreas(plate.excluded)
    this.hoverFace(null)
    this.cutPreview.detach()
    // An object that comes back with the same id and the very same arrays for every part keeps what was built for
    // it (the GPU buffers, normals and edges, the costly part for a big model); only its name, place and colors follow.
    // A new plate payload for a change elsewhere (the bed, the slot colors, the printer) then costs no rebuild.
    const before = new Map(this.objects)
    this.objects.clear()
    const sh = sharedMaterials()
    let built = 0
    let kept = 0
    for (const obj of plate.objects) {
      if (this.objects.has(obj.id)) continue
      const parked = before.has(obj.id) ? undefined : this.parked.get(obj.id)
      const old = before.get(obj.id) ?? parked?.entry
      if (old && sameArrays(parked ? parked.from : this.builtFrom.get(obj.id), obj.parts)) {
        before.delete(obj.id)
        if (parked) {
          clearTimeout(parked.timer)
          this.parked.delete(obj.id)
          this.builtFrom.set(obj.id, parked.from)
          this.stage.objectsRoot.add(old.group)
        }
        old.name = obj.name
        old.group.name = obj.name
        old.group.matrix.fromArray(obj.transform)
        old.group.matrixWorldNeedsUpdate = true
        obj.parts.forEach((p, i) => {
          const e = old.parts[i]!
          e.color = p.color
          e.finish = p.finish ?? 'basic'
        })
        this.objects.set(obj.id, old)
        kept++
        continue
      }
      const entry = buildObject(obj, (p) => this.mats.get(this.renderMode, { color: p.color, finish: p.finish ?? 'basic' }), this.renderMode === 'xray' ? sh.edgeXray : sh.edgeDark)
      this.builtFrom.set(obj.id, obj.parts.map((p) => [p.positions, p.indices]))
      this.objects.set(obj.id, entry)
      this.stage.objectsRoot.add(entry.group)
      built++
    }
    for (const [id, o] of before) {
      const from = this.builtFrom.get(id)
      if (this.objects.has(id) || !from) {
        disposeObject(o)
        continue
      }
      // An object that leaves the plate is kept built for a while: switching to another plate and back, as opening a
      // project of several plates does, then costs no rebuild.
      this.builtFrom.delete(id)
      this.park(id, o, from)
    }
    this.objectBuilds += built
    this.selection = this.selection.filter((id) => this.objects.has(id))
    // The cut follows its model into the new plate by id, or ends when the model is gone.
    if (this.cut) {
      const e = this.objects.get(this.cut.entry.id)
      this.cut = e ? { ...this.cut, entry: e } : null
    }
    this.applyMaterials()
    this.objectsMoved()
    this.applyToolpathLook()
    // A fresh plate (the first one, a project opened, a plate swap) opens on the whole build plate, not on its parts.
    if (!opts.keepCamera) this.view('plate')
    this.plateSet = { at: t0, buildMs: performance.now() - t0, built, kept }
  }

  private park(id: string, entry: ObjectEntry, from: [Float32Array, Uint32Array | Uint16Array][]): void {
    const was = this.parked.get(id)
    if (was) {
      clearTimeout(was.timer)
      disposeObject(was.entry)
    }
    entry.group.removeFromParent()
    const timer = setTimeout(() => {
      if (this.parked.get(id)?.entry !== entry) return
      this.parked.delete(id)
      disposeObject(entry)
    }, PARK_MS)
    this.parked.set(id, { entry, from, timer })
  }

  setTransforms(transforms: Record<string, number[]>): void {
    for (const [id, m] of Object.entries(transforms)) {
      const o = this.objects.get(id)
      if (!o) continue
      o.group.matrix.fromArray(m)
      o.group.matrixWorldNeedsUpdate = true
    }
    this.objectsMoved()
  }

  setPartStyle(objectId: string, partIndex: number, style: PartStyle): void {
    const p = this.objects.get(objectId)?.parts[partIndex]
    if (!p) return
    if (style.color) p.color = style.color
    if (style.finish) p.finish = style.finish
    const cutting = this.cutPreview.entry?.id === objectId
    if (cutting) this.cutPreview.detach()
    p.mesh.material = this.mats.get(this.renderMode, { color: p.color, finish: p.finish })
    if (cutting) this.syncCutPreview()
    this.invalidate()
  }

  private objectsMoved(): void {
    this.stage.scene.updateMatrixWorld(true)
    this.stage.requestContact()
    this.shadowDirty = true
    this.invalidate()
  }

  setSelection(ids: string[]): void {
    this.selection = ids.filter((id) => this.objects.has(id))
    this.invalidate()
  }

  setBrimEars(ears: Record<string, { x: number; y: number; z: number; r: number; error?: boolean; selected?: boolean }[]>): void {
    this.brim.setEars(ears)
    this.invalidate()
  }

  setGapLines(lines: readonly GapLine[]): void {
    this.gaps.set(lines)
    this.invalidate()
  }

  setGuides(guides: Guides): void {
    if (this.guides.set(guides)) this.invalidate()
  }

  setProbeHover(on: boolean): void {
    if (this.probeHover && !on) this.emit('probehover', null)
    this.probeHover = on
  }

  setEdgePreview(preview: EdgePreviewSpec | null): void {
    this.edgeView.set(preview)
    this.invalidate()
  }

  setProbeFaces(on: boolean): void {
    this.probeFaces = on
    if (!on && this.tool === 'probe') this.hoverFace(null)
  }

  setBrimHoverRadius(r: number | null): void {
    this.brim.setHoverRadius(r)
    this.invalidate()
  }

  private showBrimRect(x0: number, y0: number, x1: number, y1: number, mode: 'add' | 'remove'): void {
    if (typeof document === 'undefined') return
    let r = this.brimRectEl
    if (!r) {
      r = document.createElement('div')
      r.style.cssText = 'position:fixed;pointer-events:none;z-index:20;border-radius:2px;border:1px dashed'
      document.body.appendChild(r)
      this.brimRectEl = r
    }
    const c = mode === 'remove' ? this.theme.scene.overhangRed : this.theme.scene.selection
    r.style.borderColor = c
    r.style.background = `${c}22`
    r.style.left = `${Math.min(x0, x1)}px`
    r.style.top = `${Math.min(y0, y1)}px`
    r.style.width = `${Math.abs(x1 - x0)}px`
    r.style.height = `${Math.abs(y1 - y0)}px`
    r.style.display = 'block'
  }

  private hideBrimRect(): void {
    if (this.brimRectEl) this.brimRectEl.style.display = 'none'
  }

  /** Emits the ears whose centers lie inside a screen rectangle, one event per object. */
  private brimRectSelect(x0: number, y0: number, x1: number, y1: number, mode: 'add' | 'remove'): void {
    const rc = this.canvas.getBoundingClientRect()
    const [l, r] = [Math.min(x0, x1), Math.max(x0, x1)]
    const [t, b] = [Math.min(y0, y1), Math.max(y0, y1)]
    this.stage.scene.updateMatrixWorld(true)
    const m = this.stage.bedRoot.matrixWorld
    const v = new Vector3()
    const hits = new Map<string, number[]>()
    // As in Orca (get_unobscured_idxs), an ear behind the model is skipped. The ear and a point just above it are tested,
    // so an ear is not hidden by every small irregularity on the model.
    const meshes: Mesh[] = []
    for (const o of this.objects.values()) for (const p of o.parts) meshes.push(p.mesh)
    const rc3 = new Raycaster()
    const cam = this.camera.getWorldPosition(new Vector3())
    const visible = (pt: Vector3): boolean => {
      const dir = pt.clone().sub(cam)
      const dist = dir.length()
      rc3.set(cam, dir.normalize())
      rc3.far = dist
      const h = rc3.intersectObjects(meshes, false)[0]
      return !h || h.distance > dist - 0.4
    }
    this.brim.forEachEar((id, i, e) => {
      v.set(e.x, e.y, e.z).applyMatrix4(m).project(this.camera)
      if (v.z > 1) return
      const sx = rc.left + (v.x * 0.5 + 0.5) * rc.width
      const sy = rc.top + (-v.y * 0.5 + 0.5) * rc.height
      if (sx < l || sx > r || sy < t || sy > b) return
      const at = new Vector3(e.x, e.y, e.z + 0.1).applyMatrix4(m)
      const above = new Vector3(e.x, e.y, e.z + 1.5).applyMatrix4(m)
      if (visible(at) || visible(above)) hits.set(id, [...(hits.get(id) ?? []), i])
    })
    for (const [objectId, indices] of hits) this.emit('brimselect', { objectId, indices, mode })
  }

  setTool(tool: PlateTool): void {
    this.tool = tool
    if (tool !== 'brim' && this.brim.setHover(null)) this.invalidate()
    if (tool !== 'face' && tool !== 'probe') this.hoverFace(null)
    this.painter.setActive(tool === 'paint')
    this.applyToolpathLook()
    this.invalidate()
  }

  /** Union of the model's part boxes in its own frame. */
  private localBox(entry: ObjectEntry): Box3 {
    const b = new Box3()
    // Part geometry never changes after it is built (transforms live on the group), so its box is computed once.
    for (const p of entry.parts) {
      const g = p.mesh.geometry
      if (!g.boundingBox) g.computeBoundingBox()
      if (g.boundingBox) b.union(g.boundingBox)
    }
    return b
  }

  private scaleTarget(): ObjectEntry | null {
    if (this.tool !== 'scale' || this.mode !== 'prepare') return null
    const id = this.selection[0]
    return (id ? this.objects.get(id) : undefined) ?? null
  }

  scaleHandles(): Partial<Record<HandleId, [number, number]>> | null {
    const t = this.scaleTarget()
    if (!t) return null
    this.updateGizmo()
    const world = this.gizmo.handleWorld(t.group, this.localBox(t))
    const r = this.canvas.getBoundingClientRect()
    const out: Partial<Record<HandleId, [number, number]>> = {}
    for (const k of Object.keys(world) as HandleId[]) {
      const p = world[k]
      if (!p) continue
      const v = new Vector3(...p).project(this.camera)
      out[k] = [((v.x + 1) / 2) * r.width, ((1 - v.y) / 2) * r.height]
    }
    return out
  }

  /** True when the key of a binding is down (null never is). */
  private modDown(key: ModKey | null, state = this.keys): boolean {
    return key !== null && state[key]
  }

  private updateGizmo(): void {
    const t = this.scaleTarget()
    const b = this.controlsMap.gizmo.scale
    const pinned = this.scaleDrag ? this.pinned(this.scaleDrag.pinAtStart) : this.modDown(b.pinKey)
    this.gizmo.update(t?.group ?? null, t ? this.localBox(t) : null, this.camera, this.height, this.camera.fov, { layout: b.layout, pivot: b.pivot, pinned })
  }

  /** Whether the pin key counts as held: read at the start of the drag (Orca) or live (Bambu Studio). */
  private pinned(atStart: boolean): boolean {
    const b = this.controlsMap.gizmo.scale
    return b.pinKey === null ? false : b.pinMode === 'at-start' ? atStart : this.modDown(b.pinKey)
  }

  private scaleDown(ray: Raycaster): boolean {
    const t = this.scaleTarget()
    if (!t) return false
    this.updateGizmo()
    const kind = this.gizmo.hit(ray)
    if (!kind) return false
    t.group.updateMatrixWorld(true)
    const b = this.controlsMap.gizmo.scale
    this.scaleDrag = {
      entry: t,
      kind,
      start: t.group.matrix.toArray(),
      box: this.localBox(t),
      startRay: { o: ray.ray.origin.toArray() as V3, d: ray.ray.direction.toArray() as V3 },
      pinAtStart: this.modDown(b.pinKey),
      startRatioT: null,
    }
    this.gizmo.setDragging(kind)
    this.controls.enabled = false
    return true
  }

  /**
   * Factors of the running drag for a ray, or null when the ray cannot be turned into a ratio. The source of the ratio, the
   * pivot, the pin and snap keys and the layout all come from the preset's scale bindings (gizmobindings.ts).
   */
  private scaleFactors(ray: { o: V3; d: V3 }): { factors: V3; anchor: V3 } | null {
    const d = this.scaleDrag
    if (!d) return null
    const b = this.controlsMap.gizmo.scale
    const { entry, kind, box } = d
    const min = box.min.toArray() as V3
    const max = box.max.toArray() as V3
    const origin = { layout: b.layout, pivot: b.pivot, cornerPinLocksZ: b.cornerPinLocksZ }
    const pinned = this.pinned(d.pinAtStart)
    const m = new Matrix4().fromArray(d.start)
    const parent = entry.group.parent
    parent?.updateMatrixWorld(true)
    const toWorld = new Matrix4().multiplyMatrices(parent?.matrixWorld ?? new Matrix4(), m)
    const world = (p: V3): V3 => new Vector3(...p).applyMatrix4(toWorld).toArray() as V3
    const pivotWorld = world(ratioPivotFor(kind, min, max, origin, pinned))
    const handleWorld = world(handleLocal(kind, min, max, b.layout))
    const len = Math.hypot(handleWorld[0] - pivotWorld[0], handleWorld[1] - pivotWorld[1], handleWorld[2] - pivotWorld[2])
    if (len < 1e-6) return null
    let f: number
    if (b.ratio === 'line') {
      const dir: V3 = [(handleWorld[0] - pivotWorld[0]) / len, (handleWorld[1] - pivotWorld[1]) / len, (handleWorld[2] - pivotWorld[2]) / len]
      const tNow = nearestOnLine(ray.o, ray.d, pivotWorld, dir)
      const tStart = nearestOnLine(d.startRay.o, d.startRay.d, pivotWorld, dir)
      if (tNow === null || tStart === null) return null
      f = ratioLine(tNow, tStart, len)
    } else if (b.ratio === 'point') {
      f = ratioPoint(ray.o, ray.d, handleWorld, pivotWorld)
    } else {
      const upWorld = new Vector3(0, 0, 1).transformDirection(toWorld).toArray() as V3
      f = ratioPlane(ray.o, ray.d, handleWorld, pivotWorld, upWorld, handleAxis(kind) === 'z')
    }
    if (f <= 0) return null
    if (this.modDown(b.snapKey)) f = snapScale(f, b.snapStep)
    const scaleMm = toWorld.getMaxScaleOnAxis()
    const sizes = [(max[0] - min[0]) * scaleMm, (max[1] - min[1]) * scaleMm, (max[2] - min[2]) * scaleMm] as V3
    f = Math.max(clampScale(f), minFactorFor(kind, sizes, b.minSizeMm))
    const lockZ = pinned && b.cornerPinLocksZ && handleAxis(kind) === 'uniform'
    return { factors: factorsFor(kind, f, lockZ), anchor: pivotFor(kind, min, max, origin, pinned) }
  }

  private scaleMove(ray: Raycaster, e: PointerEvent): void {
    const d = this.scaleDrag
    if (!d) return
    this.keys = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey }
    const r = this.scaleFactors({ o: ray.ray.origin.toArray() as V3, d: ray.ray.direction.toArray() as V3 })
    if (!r) return
    const m = scaleTransform(d.start, r.factors, r.anchor)
    d.entry.group.matrix.fromArray(m)
    d.entry.group.matrixWorldNeedsUpdate = true
    this.emit('scale', { id: d.entry.id, factors: r.factors, uniform: handleAxis(d.kind) === 'uniform', snapped: this.modDown(this.controlsMap.gizmo.scale.snapKey) })
    this.emit('transform', { id: d.entry.id, transform: m, final: false })
    this.invalidate()
  }

  private scaleEnd(cancel: boolean): void {
    const d = this.scaleDrag
    if (!d) return
    this.scaleDrag = null
    this.gizmo.setDragging(null)
    this.controls.enabled = true
    if (cancel) {
      d.entry.group.matrix.fromArray(d.start)
      d.entry.group.matrixWorldNeedsUpdate = true
    } else this.emit('transform', { id: d.entry.id, transform: d.entry.group.matrix.toArray(), final: true })
    this.objectsMoved()
    this.invalidate()
  }

  // ---------- rotate rings ----------

  private rotateTarget(): ObjectEntry | null {
    if (this.tool !== 'rotate' || this.mode !== 'prepare' || this.cut) return null
    const id = this.selection[0]
    return (id ? this.objects.get(id) : undefined) ?? null
  }

  /** Center of the model's box and a ring radius a little wider than the box, in bed coordinates. */
  private ringLayout(entry: ObjectEntry): { center: V3; radius: number } {
    const b = this.localBox(entry)
    if (b.isEmpty()) b.set(new Vector3(), new Vector3())
    const m = entry.group.matrix
    const c = b.getCenter(new Vector3()).applyMatrix4(m)
    const half = b.getSize(new Vector3()).length() / 2
    return { center: c.toArray() as V3, radius: Math.max(4, half * m.getMaxScaleOnAxis() * 1.08) }
  }

  /** A ray in bed coordinates. */
  private bedRay(ray: Raycaster): { o: V3; d: V3 } {
    const inv = this.stage.bedMatrix().invert()
    return { o: ray.ray.origin.clone().applyMatrix4(inv).toArray() as V3, d: ray.ray.direction.clone().transformDirection(inv).toArray() as V3 }
  }

  /** Millimeters per screen pixel at a bed point. */
  private mmPerPx(p: V3): number {
    const w = new Vector3(...p).applyMatrix4(this.stage.bedMatrix())
    const dist = this.camera.position.distanceTo(w)
    return (2 * dist * Math.tan((this.camera.fov * Math.PI) / 360)) / Math.max(1, this.height)
  }

  /** A bed point on screen, in client pixels. */
  private toScreen(p: V3): [number, number] {
    const v = new Vector3(...p).applyMatrix4(this.stage.bedMatrix()).project(this.camera)
    const r = this.canvas.getBoundingClientRect()
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height]
  }

  /** Starts a ring drag: where the ring was grabbed, and the screen tangent there for a ring seen edge on. */
  private ringStart(o: V3, d: V3, center: V3, dir: V3, radius: number, e: { clientX: number; clientY: number }): RingDrag {
    const ud = unit(d)
    const hit = rayPlane(o, d, center, dir)
    const edgeOn = !hit || Math.abs(ud[0] * dir[0] + ud[1] * dir[1] + ud[2] * dir[2]) < 0.15
    // Grabbed edge on, the ring counts as grabbed at its point nearest the camera.
    const raw: V3 = hit && !edgeOn ? [hit[0] - center[0], hit[1] - center[1], hit[2] - center[2]] : [-ud[0], -ud[1], -ud[2]]
    const k = raw[0] * dir[0] + raw[1] * dir[1] + raw[2] * dir[2]
    const from = unit([raw[0] - dir[0] * k, raw[1] - dir[1] * k, raw[2] - dir[2] * k])
    const at: V3 = [center[0] + from[0] * radius, center[1] + from[1] * radius, center[2] + from[2] * radius]
    const t = turnVector(from, dir, 0.05)
    const s0 = this.toScreen(at)
    const s1 = this.toScreen([center[0] + t[0] * radius, center[1] + t[1] * radius, center[2] + t[2] * radius])
    const sc = this.toScreen(center)
    const tl = Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) || 1
    return { center, radius, dir, from, angle: 0, edgeOn, x0: e.clientX, y0: e.clientY, tangent: [(s1[0] - s0[0]) / tl, (s1[1] - s0[1]) / tl], rpx: Math.max(20, Math.hypot(s0[0] - sc[0], s0[1] - sc[1])) }
  }

  /** The turn of a ring drag for a pointer position, before snapping. */
  private ringAngle(g: RingDrag, ray: Raycaster, e: { clientX: number; clientY: number }): number {
    if (g.edgeOn) return ((e.clientX - g.x0) * g.tangent[0] + (e.clientY - g.y0) * g.tangent[1]) / g.rpx
    const { o, d } = this.bedRay(ray)
    const p = rayPlane(o, d, g.center, g.dir)
    if (!p) return g.angle
    return unwrapAngle(g.angle, angleAround(g.from, [p[0] - g.center[0], p[1] - g.center[1], p[2] - g.center[2]], g.dir))
  }

  private updateRings(): void {
    const t = this.rotateTarget()
    if (!t) {
      if (this.rotRings.visible) this.rotRings.show(false)
      return
    }
    const l = this.rotDrag ?? this.ringLayout(t)
    const axes = ringAxes(t.group.matrix.elements, this.rotSpace)
    for (const id of ['x', 'y', 'z'] as const) this.rotRings.place(id, l.center, axes[id], l.radius)
    this.rotRings.show(true)
  }

  private ringUnder(ray: Raycaster): RingAxis | null {
    const t = this.rotateTarget()
    if (!t) return null
    const { o, d } = this.bedRay(ray)
    const l = this.ringLayout(t)
    const axes = ringAxes(t.group.matrix.elements, this.rotSpace)
    return pickRing(o, d, l.center, (['x', 'y', 'z'] as const).map((id) => ({ id, axis: axes[id] })), l.radius, 7 * this.mmPerPx(l.center))
  }

  private ringHover(ray: Raycaster): void {
    const id = this.ringUnder(ray)
    if (this.rotRings.setHover(id)) {
      this.canvas.style.cursor = id ? 'pointer' : ''
      this.invalidate()
    }
  }

  private rotDown(ray: Raycaster, e: PointerEvent): boolean {
    const t = this.rotateTarget()
    const axis = t ? this.ringUnder(ray) : null
    if (!t || !axis) return false
    const { o, d } = this.bedRay(ray)
    const l = this.ringLayout(t)
    const dir = ringAxes(t.group.matrix.elements, this.rotSpace)[axis]
    this.rotDrag = { ...this.ringStart(o, d, l.center, dir, l.radius, e), entry: t, axis, start: t.group.matrix.toArray(), shown: 0, snapped: false }
    this.rotRings.setActive(axis)
    this.controls.enabled = false
    this.showGizmoLabel(e.clientX, e.clientY, this.rotText(0, false))
    this.invalidate()
    return true
  }

  private rotText(rad: number, snapped: boolean): string {
    const d = this.rotDrag
    const deg = (rad * 180) / Math.PI
    const axis = d ? d.axis.toUpperCase() : ''
    return `${this.rotSpace === 'local' ? 'Object ' : ''}${axis} ${snapped ? Math.round(deg) : deg.toFixed(1)}°`
  }

  private rotMove(ray: Raycaster, e: PointerEvent): void {
    const d = this.rotDrag
    if (!d) return
    d.angle = this.ringAngle(d, ray, e)
    const rb = this.controlsMap.gizmo.rotate
    const snapped = this.modDown(rb.snapKey, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey })
    const a = snapped ? snapAngle(d.angle, rb.snapStepDeg) : d.angle
    d.shown = a
    d.snapped = snapped
    const m = rotateAbout(d.start, d.center, d.dir, a)
    d.entry.group.matrix.fromArray(m)
    d.entry.group.matrixWorldNeedsUpdate = true
    this.rotRings.sweep(d.center, d.dir, d.from, a, d.radius)
    this.setGizmoLabel(this.rotText(a, snapped))
    this.emit('rotate', { id: d.entry.id, axis: d.axis, space: this.rotSpace, angleDeg: (a * 180) / Math.PI, snapped, final: false })
    this.emit('transform', { id: d.entry.id, transform: m, final: false })
    this.invalidate()
  }

  private rotEnd(cancel: boolean): void {
    const d = this.rotDrag
    if (!d) return
    this.rotDrag = null
    this.rotRings.setActive(null)
    this.controls.enabled = true
    this.hideGizmoLabel()
    const g = d.entry.group
    if (cancel) {
      g.matrix.fromArray(d.start)
      g.matrixWorldNeedsUpdate = true
    } else {
      // A turn about a tilted axis puts the model back on the bed, as Orca does after a rotation.
      if (Math.abs(d.dir[2]) < 0.9999) {
        g.updateMatrixWorld(true)
        const b = new Box3().setFromObject(g, true).applyMatrix4(this.stage.bedMatrix().invert())
        if (!b.isEmpty()) g.matrix.elements[14] = (g.matrix.elements[14] ?? 0) - b.min.z
        g.matrixWorldNeedsUpdate = true
      }
      this.emit('rotate', { id: d.entry.id, axis: d.axis, space: this.rotSpace, angleDeg: (d.shown * 180) / Math.PI, snapped: d.snapped, final: true })
      this.emit('transform', { id: d.entry.id, transform: g.matrix.toArray(), final: true })
    }
    this.objectsMoved()
  }

  setRotateSpace(space: RotateSpace): void {
    if (space === this.rotSpace) return
    this.rotSpace = space
    this.invalidate()
  }

  rotateHandles(): Partial<Record<RingAxis, [number, number]>> | null {
    const t = this.rotateTarget()
    if (!t) return null
    const l = this.ringLayout(t)
    const axes = ringAxes(t.group.matrix.elements, this.rotSpace)
    const cam = this.camera.position.clone().applyMatrix4(this.stage.bedMatrix().invert())
    const toCam: V3 = [cam.x - l.center[0], cam.y - l.center[1], cam.z - l.center[2]]
    const r = this.canvas.getBoundingClientRect()
    const out: Partial<Record<RingAxis, [number, number]>> = {}
    for (const id of ['x', 'y', 'z'] as const) {
      // The point of each ring on the camera's side, where it is easiest to grab.
      const n = axes[id]
      const k = toCam[0] * n[0] + toCam[1] * n[1] + toCam[2] * n[2]
      const f = unit([toCam[0] - n[0] * k, toCam[1] - n[1] * k, toCam[2] - n[2] * k])
      const s = this.toScreen([l.center[0] + f[0] * l.radius, l.center[1] + f[1] * l.radius, l.center[2] + f[2] * l.radius])
      out[id] = [s[0] - r.left, s[1] - r.top]
    }
    return out
  }

  /** The value of a running drag next to the cursor. Placed once when the drag starts; a move only changes its text. */
  private showGizmoLabel(x: number, y: number, text: string): void {
    if (typeof document === 'undefined') return
    let el = this.gizmoLabel
    if (!el) {
      el = document.createElement('div')
      el.className = 'vp-gizmo-label'
      el.setAttribute('role', 'status')
      // A small lifted surface: the host's tokens when it has them, a plain dark label when it does not.
      el.style.cssText =
        'position:fixed;pointer-events:none;z-index:20;padding:2px 6px;border-radius:var(--r-sm,4px);' +
        'font:500 12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg,#f8f8f2);' +
        'background:color-mix(in srgb,var(--ink-3,#1e1f29) 90%,transparent);border:1px solid var(--line,transparent);' +
        'box-shadow:var(--shadow-float,none);-webkit-backdrop-filter:var(--lift-glass,none);backdrop-filter:var(--lift-glass,none)'
      document.body.appendChild(el)
      this.gizmoLabel = el
    }
    el.textContent = text
    el.style.left = `${x + 16}px`
    el.style.top = `${y - 30}px`
    el.style.display = 'block'
  }

  private setGizmoLabel(text: string): void {
    if (this.gizmoLabel) this.gizmoLabel.textContent = text
  }

  private hideGizmoLabel(): void {
    if (this.gizmoLabel) this.gizmoLabel.style.display = 'none'
  }

  // ---------- cut plane ----------

  setCutPlane(cut: CutPlaneSpec | null): void {
    const entry = cut ? this.objects.get(cut.objectId) : undefined
    if (!cut || !entry) {
      if (!this.cut && !this.cutPreview.entry) return
      this.cutEnd(true)
      this.cut = null
      this.cutPreview.detach()
      this.applyClip()
      return
    }
    // A plane pushed back by the app while a drag runs would undo the drag; the release reports the result.
    if (this.cutDrag) return
    const keep = cut.keep ?? 'both'
    const reattach = this.cut?.entry !== entry || this.cut.keep !== keep
    this.cut = { entry, point: [...cut.point], normal: unit(cut.normal), keep, place: cut.placeConnectors === true }
    if (reattach) this.syncCutPreview()
    else this.cutPreview.setPlane(this.cut.point, this.cut.normal, this.stage.bedRoot.matrixWorld)
    this.invalidate()
  }

  private syncCutPreview(): void {
    const c = this.cut
    if (!c) return
    this.cutPreview.attach(c.entry, c.keep)
    this.stage.bedRoot.updateMatrixWorld(true)
    this.cutPreview.setPlane(c.point, c.normal, this.stage.bedRoot.matrixWorld)
    this.renderer.localClippingEnabled = true
  }

  private updateCutGizmo(): void {
    const c = this.mode === 'prepare' ? this.cut : null
    this.cutGizmo.group.visible = !!c
    this.cutRings.show(!!c)
    if (!c) return
    const r = this.ringLayout(c.entry).radius
    this.cutGizmo.place(c.point, c.normal, r, this.mmPerPx(c.point))
    const g = this.cutDrag?.kind === 'tilt' ? this.cutDrag : null
    const { u, v } = tiltAxes(g ? g.normal0 : c.normal)
    this.cutRings.place('u', c.point, u, r * 0.8)
    this.cutRings.place('v', c.point, v, r * 0.8)
  }

  /** What of the cut gizmo a ray points at: a tilt ring, the grabber or the plane. */
  private cutUnder(ray: Raycaster): 'u' | 'v' | 'grabber' | 'plane' | null {
    const c = this.mode === 'prepare' ? this.cut : null
    if (!c) return null
    this.updateCutGizmo()
    this.cutGizmo.group.updateMatrixWorld(true)
    if (ray.intersectObject(this.cutGizmo.grabber, false).length) return 'grabber'
    const { o, d } = this.bedRay(ray)
    const { u, v } = tiltAxes(c.normal)
    const ring = pickRing(o, d, c.point, [{ id: 'u' as const, axis: u }, { id: 'v' as const, axis: v }], this.ringLayout(c.entry).radius * 0.8, 7 * this.mmPerPx(c.point))
    if (ring) return ring
    return ray.intersectObject(this.cutGizmo.quad, false).length ? 'plane' : null
  }

  private cutHover(ray: Raycaster): void {
    const part = this.cutUnder(ray)
    const a = this.cutRings.setHover(part === 'u' || part === 'v' ? part : null)
    const b = this.cutGizmo.setHot(part === 'grabber' || part === 'plane' ? part : null)
    if (a || b) {
      this.canvas.style.cursor = part ? 'pointer' : ''
      this.invalidate()
    }
  }

  private cutDown(ray: Raycaster, e: PointerEvent): boolean {
    const c = this.cut
    const part = c ? this.cutUnder(ray) : null
    if (!c || !part) return false
    const { o, d } = this.bedRay(ray)
    // Placing connectors: a click on the plane says where, and the plane stays put.
    if (c.place && part === 'plane') {
      const n = c.normal
      const den = n[0] * d[0] + n[1] * d[1] + n[2] * d[2]
      if (Math.abs(den) < 1e-9) return true
      const t = (n[0] * (c.point[0] - o[0]) + n[1] * (c.point[1] - o[1]) + n[2] * (c.point[2] - o[2])) / den
      this.emit('cutconnector', { objectId: c.entry.id, point: [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t] })
      return true
    }
    if (part === 'u' || part === 'v') {
      const axis = tiltAxes(c.normal)[part]
      this.cutDrag = { ...this.ringStart(o, d, c.point, axis, this.ringLayout(c.entry).radius * 0.8, e), kind: 'tilt', ring: part, normal0: c.normal }
      this.cutRings.setActive(part)
      this.showGizmoLabel(e.clientX, e.clientY, 'Tilt 0°')
    } else {
      const b = this.localBox(c.entry)
      const extent = extentAlong(b.min.toArray() as V3, b.max.toArray() as V3, c.entry.group.matrix.elements, c.point, c.normal)
      const px = this.mmPerPx(c.point)
      // Along the normal by the ray's nearest point; when the normal points at the camera, by the cursor's height on screen.
      const s0 = this.toScreen(c.point)
      const s1 = this.toScreen([c.point[0] + c.normal[0] * 10, c.point[1] + c.normal[1] * 10, c.point[2] + c.normal[2] * 10])
      const visible = Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) * px > 2.5
      const t0 = visible ? nearestOnLine(o, d, c.point, c.normal) : null
      this.cutDrag = { kind: 'move', point0: c.point, extent, t0, mmPerPx: px, x0: e.clientX, y0: e.clientY }
      this.cutGizmo.setHot(part)
      this.showGizmoLabel(e.clientX, e.clientY, 'Moved 0.0 mm')
    }
    this.controls.enabled = false
    this.invalidate()
    return true
  }

  private cutMove(ray: Raycaster, e: PointerEvent): void {
    const c = this.cut
    const g = this.cutDrag
    if (!c || !g) return
    const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey }
    if (g.kind === 'move') {
      let t: number
      if (g.t0 !== null) {
        const { o, d } = this.bedRay(ray)
        const now = nearestOnLine(o, d, g.point0, c.normal)
        if (now === null) return
        t = now - g.t0
      } else t = (g.y0 - e.clientY) * g.mmPerPx
      // The cut snaps with the rotate key for both moves and tilts, so one key works on every look.
      const mv = this.controlsMap.gizmo.move
      if (this.modDown(this.controlsMap.gizmo.rotate.snapKey, mods)) t = Math.round(t / mv.snapStepMm) * mv.snapStepMm
      c.point = movePlane(g.point0, c.normal, t, g.extent)
      const moved = (c.point[0] - g.point0[0]) * c.normal[0] + (c.point[1] - g.point0[1]) * c.normal[1] + (c.point[2] - g.point0[2]) * c.normal[2]
      this.setGizmoLabel(`Moved ${moved.toFixed(1)} mm`)
    } else {
      g.angle = this.ringAngle(g, ray, e)
      const rb = this.controlsMap.gizmo.rotate
      const snapped = this.modDown(rb.snapKey, mods)
      const a = snapped ? snapAngle(g.angle, rb.snapStepDeg) : g.angle
      c.normal = unit(turnVector(g.normal0, g.dir, a))
      this.cutRings.sweep(g.center, g.dir, g.from, a, g.radius)
      const deg = (a * 180) / Math.PI
      this.setGizmoLabel(`Tilt ${snapped ? Math.round(deg) : deg.toFixed(1)}°`)
    }
    this.cutPreview.setPlane(c.point, c.normal, this.stage.bedRoot.matrixWorld)
    this.emit('cutplane', { objectId: c.entry.id, point: [...c.point], normal: [...c.normal], final: false })
    this.invalidate()
  }

  private cutEnd(cancel: boolean): void {
    const g = this.cutDrag
    const c = this.cut
    if (!g) return
    this.cutDrag = null
    this.cutRings.setActive(null)
    this.cutGizmo.setHot(null)
    this.controls.enabled = true
    this.hideGizmoLabel()
    if (!c) return
    if (cancel) {
      if (g.kind === 'move') c.point = g.point0
      else c.normal = g.normal0
      this.cutPreview.setPlane(c.point, c.normal, this.stage.bedRoot.matrixWorld)
    } else this.emit('cutplane', { objectId: c.entry.id, point: [...c.point], normal: [...c.normal], final: true })
    this.invalidate()
  }

  cutHandles(): { grabber: [number, number]; u: [number, number]; v: [number, number] } | null {
    const c = this.mode === 'prepare' ? this.cut : null
    if (!c) return null
    const r = this.ringLayout(c.entry).radius
    const { u, v } = tiltAxes(c.normal)
    const rc = this.canvas.getBoundingClientRect()
    const at = (p: V3): [number, number] => {
      const s = this.toScreen(p)
      return [s[0] - rc.left, s[1] - rc.top]
    }
    const on = (a: V3, k: number): V3 => [c.point[0] + a[0] * k, c.point[1] + a[1] * k, c.point[2] + a[2] * k]
    // Each ring's point a quarter turn from the other ring's axis, so the two lie apart on screen.
    return { grabber: at(on(c.normal, r * 0.6)), u: at(on(v, r * 0.8)), v: at(on(u, r * 0.8)) }
  }

  // ---------- push and pull ----------

  setPush(push: PushSpec | null): void {
    const before = this.push
    this.push = push
    if (!push) {
      if (this.pushDrag) this.pushEnd(true)
      this.pushView.setPrism(null, null)
      this.pushView.group.visible = false
      if (before) this.invalidate()
      return
    }
    const f = push.face
    if (push.prism !== before?.prism || f !== before?.face) this.pushView.setPrism(f ? (push.prism ?? null) : null, f ? { point: [...f.point], normal: [...f.normal] } : null)
    // While a drag runs the view owns the distance; the app's copy may lag a frame behind.
    const g = this.pushDrag
    this.pushView.setDistance(g?.started && f && g.objectId === f.objectId ? g.d : push.distanceMm)
    this.invalidate()
  }

  /** Whether a bed point and normal lie on the picked push face. */
  private onPushFace(objectId: string, point: V3, normal: V3): boolean {
    const sel = this.push?.face
    if (!sel || sel.objectId !== objectId || dot3(sel.normal, normal) < 0.9999) return false
    return Math.abs(dot3([point[0] - sel.point[0], point[1] - sel.point[1], point[2] - sel.point[2]], sel.normal)) < 0.01
  }

  /** A press on a flat face with the push tool: the drag starts once the cursor moves a few pixels, so a click still picks. */
  private pushDown(e: PointerEvent, p: PickHit | null): boolean {
    const f = p ? this.faceFromHit(p) : null
    if (!p || !f || this.mode !== 'prepare') return false
    let point = f.pick.point as V3
    let normal = f.pick.normal as V3
    let d0 = 0
    const sel = this.push?.face
    // The face already picked keeps its distance, so a second drag goes on from the first.
    if (sel && this.onPushFace(p.entry.id, point, normal)) {
      point = [...sel.point]
      normal = [...sel.normal]
      d0 = this.push?.distanceMm ?? 0
    }
    const px = this.mmPerPx(point)
    const s0 = this.toScreen(point)
    const s1 = this.toScreen([point[0] + normal[0] * 10, point[1] + normal[1] * 10, point[2] + normal[2] * 10])
    // Along the normal by the ray's nearest point; when the normal points at the camera, by the cursor's height on screen.
    const visible = Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) * px > 2.5
    const { o, d } = this.bedRayAt(e)
    const t0 = visible ? nearestOnLine(o, d, point, normal) : null
    this.pushDrag = { started: false, objectId: p.entry.id, partIndex: p.part, triangle: p.face, point, normal, d0, d: d0, snapped: false, t0, mmPerPx: px, x0: e.clientX, y0: e.clientY }
    this.controls.enabled = false
    return true
  }

  private pushMove(e: PointerEvent): void {
    const g = this.pushDrag
    if (!g) return
    if (!g.started) {
      if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < 4) return
      g.started = true
      // A face other than the picked one: its prism comes from the app once it has picked that face.
      if (!this.onPushFace(g.objectId, g.point, g.normal)) this.pushView.setPrism(null, null)
      this.showGizmoLabel(e.clientX, e.clientY, pushLabel(g.d))
      this.emitPush('start', g)
    }
    let t: number
    if (g.t0 !== null) {
      const { o, d } = this.bedRayAt(e)
      const now = nearestOnLine(o, d, g.point, g.normal)
      if (now === null) return
      t = now - g.t0
    } else t = (g.y0 - e.clientY) * g.mmPerPx
    g.snapped = this.modDown(this.controlsMap.gizmo.rotate.snapKey, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey })
    // The rotate snap key rounds to whole millimeters, as it rounds a turn to 15 degrees.
    g.d = g.snapped ? Math.round(g.d0 + t) : Math.round((g.d0 + t) * 100) / 100
    this.pushView.setDistance(g.d)
    this.setGizmoLabel(pushLabel(g.d))
    this.emitPush('move', g)
    this.invalidate()
  }

  /** Ends a push drag. Returns false when the press never became a drag, so the release counts as a click. */
  private pushEnd(cancel: boolean): boolean {
    const g = this.pushDrag
    if (!g) return false
    this.pushDrag = null
    this.controls.enabled = true
    if (!g.started) return false
    this.hideGizmoLabel()
    if (cancel) {
      g.d = g.d0
      this.pushView.setDistance(g.d0)
      this.emitPush('cancel', g)
    } else this.emitPush('end', g)
    this.invalidate()
    return true
  }

  private emitPush(phase: PushEvent['phase'], g: NonNullable<ViewportImpl['pushDrag']>): void {
    this.emit('push', { phase, objectId: g.objectId, partIndex: g.partIndex, triangle: g.triangle, point: [...g.point], normal: [...g.normal], distanceMm: g.d, snapped: g.snapped })
  }

  /** The ray under a client point, in bed coordinates. */
  private bedRayAt(e: { clientX: number; clientY: number }): { o: V3; d: V3 } {
    const r = this.canvas.getBoundingClientRect()
    this.tmpRay.setFromCamera(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, (-(e.clientY - r.top) / r.height) * 2 + 1), this.camera)
    return this.bedRay(this.tmpRay)
  }

  // ---------- sketch ----------

  setSketch(scene: SketchScene | null): void {
    if (!scene && !this.sketchLayer.scene) return
    if (!scene) this.sketchDrag = null
    this.sketchLayer.set(scene)
    this.invalidate()
  }

  setSketchCursor(cursor: SketchCursor | null): void {
    if (!this.sketchLayer.scene) return
    this.sketchLayer.cursor(cursor)
    this.invalidate()
  }

  private sketchOn(): boolean {
    return this.sketchLayer.scene !== null && this.tool === 'probe' && this.mode === 'prepare'
  }

  /** The cursor on the sketch plane, or null when the ray misses it. */
  private sketchAt(e: { clientX: number; clientY: number }): V2 | null {
    const s = this.sketchLayer.scene
    if (!s) return null
    const { o, d } = this.bedRayAt(e)
    return rayOnPlane(s.frame, o, d)
  }

  private sketchEvent(kind: SketchEvent['kind'], e: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean }, handle?: number): void {
    const s = this.sketchLayer.scene
    const at = s ? this.sketchAt(e) : null
    if (!s || !at) return
    this.emit('sketch', { kind, at, ...(handle !== undefined ? { handle } : {}), mmPerPx: this.mmPerPx(fromPlane(s.frame, at)), screen: [e.clientX, e.clientY], shift: e.shiftKey, alt: e.altKey })
  }

  lookAtPlane(point: V3, normal: V3, radiusMm: number, opts: { animate?: boolean } = {}): void {
    const m = this.stage.bedMatrix()
    const target = new Vector3(...point).applyMatrix4(m)
    const dir = new Vector3(...normal).transformDirection(m)
    // Straight down the camera's up axis the orbit has no heading; a hair of tilt keeps the bed's front at the bottom.
    if (Math.abs(dir.y) > 0.9995) dir.z += 0.0008
    dir.normalize()
    const cam = this.camera
    const fov = (cam.fov * Math.PI) / 180
    const fovH = 2 * Math.atan(Math.tan(fov / 2) * cam.aspect)
    const dist = Math.max(radiusMm, 5) / Math.sin(Math.min(fov, fovH) / 2)
    this.rig.preset = null
    this.rig.go({ pos: target.clone().addScaledVector(dir, dist), target }, opts.animate ?? true, performance.now())
    this.invalidate()
  }

  // ---------- kept dimensions ----------

  setDimensions(marks: readonly DimensionMark[]): void {
    if (this.dims.set(marks)) this.invalidate()
  }

  setPaintSettings(settings: Partial<PaintSettings>): void {
    this.painter.update(settings)
  }

  getPaintSettings(): PaintSettings {
    return { ...this.painter.settings, heightRangeMm: [...this.painter.settings.heightRangeMm] }
  }

  setPaintColors(colors: readonly string[]): void {
    this.painter.setColors(colors)
  }

  getPaintData(objectId: string, partIndex: number, layer: PaintLayer): Record<number, string> {
    return this.painter.getData(objectId, partIndex, layer)
  }

  setPaintData(objectId: string, partIndex: number, layer: PaintLayer, texts: Record<number, string> | null): number[] {
    return this.painter.setData(objectId, partIndex, layer, texts)
  }

  applyPaintEdits(objectId: string, partIndex: number, layer: PaintLayer, edits: readonly { triangle: number; text: string | null }[]): void {
    this.painter.applyEdits(objectId, partIndex, layer, edits)
  }

  performGapFill(objectId: string): void {
    const o = this.objects.get(objectId)
    if (o) this.painter.performGapFill(o)
  }

  paintHeightRange(objectId: string, range?: [number, number]): void {
    const o = this.objects.get(objectId)
    if (o) this.painter.paintHeightRange(o, range)
  }

  /**
   * Paint tool pointer down. The buttons and keys come from the preset's paint bindings: the left button paints the chosen
   * state (an enforcer on the seam and support layers); the right button paints a blocker on those layers, and on the color layer
   * either the second brush color or nothing (left to the camera), as the look says; the erase key erases. Returns true when the
   * press belongs to the paint tool.
   */
  private paintDown(e: PointerEvent, hit: PickHit): boolean {
    const pb = this.controlsMap.gizmo.paint
    const held = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey }
    // Any modifier other than the erase key belongs to the camera.
    for (const k of ['shift', 'ctrl', 'alt'] as const) if (held[k] && k !== pb.eraseKey) return false
    if (this.spaceDown) return false
    const settings = this.painter.settings
    if (settings.tool === 'gap') return false
    const layer = settings.layer
    let state: number | undefined
    let button: 'left' | 'right' = 'left'
    // Fuzzy skin has one painted state: the right button takes it off.
    let rightErases = false
    if (e.button === 2) {
      button = 'right'
      if (layer === 'fuzzy') rightErases = true
      else if (layer !== 'color') state = 2
      else if (pb.colorRightButton === 'second-state') state = settings.secondState
      else return false
    } else if (e.button === 0) {
      if (layer !== 'color') state = 1
    } else return false
    const h: PaintHit = { entry: hit.entry, part: hit.part, point: hit.point, dir: hit.dir, face: hit.face }
    this.painter.begin(hit.entry, hit.part, { erase: rightErases || (pb.eraseKey !== null && held[pb.eraseKey]), button, ...(state !== undefined ? { state } : {}) })
    this.painter.apply(h)
    this.painting = { x: e.clientX, y: e.clientY, pointerId: e.pointerId }
    this.controls.enabled = false
    this.canvas.setPointerCapture(e.pointerId)
    return true
  }

  private paintMove(e: PointerEvent, pick: (p: { clientX: number; clientY: number }) => PickHit | null): void {
    const s = this.painter.settings
    const last = this.painting
    if (!last) {
      const h = pick(e)
      this.painter.setCursor(h ? { entry: h.entry, part: h.part, point: h.point, dir: h.dir, face: h.face } : null, h?.dir ?? new Vector3(0, 0, -1))
      return
    }
    if (s.tool !== 'brush' && s.tool !== 'height' && s.tool !== 'triangle') return
    // Walk from the last pointer position in small steps so a fast drag leaves no gaps.
    const dist = Math.hypot(e.clientX - last.x, e.clientY - last.y)
    const steps = Math.max(1, Math.ceil(dist / 6))
    for (let i = 1; i <= steps; i++) {
      const x = last.x + ((e.clientX - last.x) * i) / steps
      const y = last.y + ((e.clientY - last.y) * i) / steps
      const h = pick({ clientX: x, clientY: y })
      if (h) {
        this.painter.apply({ entry: h.entry, part: h.part, point: h.point, dir: h.dir, face: h.face })
        this.painter.setCursor({ entry: h.entry, part: h.part, point: h.point, dir: h.dir, face: h.face }, h.dir)
      }
    }
    last.x = e.clientX
    last.y = e.clientY
  }

  pickFace(clientX: number, clientY: number): FacePick | null {
    if (this.mode !== 'prepare') return null
    const p = this.pickFn({ clientX, clientY })
    return p ? (this.faceFromHit(p)?.pick ?? null) : null
  }

  private faceFromHit(p: PickHit): { pick: FacePick; triangles: number[] } | null {
    const src = p.entry.parts[p.part]?.mesh.userData.source as { positions: Float32Array; indices: Uint32Array | Uint16Array } | undefined
    if (!src || p.face < 0) return null
    const patch = facePatch(src.positions, src.indices, p.face)
    if (!patch) return null
    const n = new Vector3(...patch.normal).applyMatrix3(new Matrix3().getNormalMatrix(p.entry.group.matrix)).normalize()
    const c = this.bedBox(p.entry).getCenter(new Vector3())
    return {
      pick: { objectId: p.entry.id, partIndex: p.part, normal: [n.x, n.y, n.z], centerBed: [c.x, c.y, c.z], areaMm2: patch.areaMm2, point: this.worldToBed(p.point) },
      triangles: patch.triangles,
    }
  }

  /** Highlights the face patch under the cursor (tool `face`). Null clears it. */
  private hoverFace(p: PickHit | null): void {
    const f = p ? this.faceFromHit(p) : null
    const key = f && p ? `${p.entry.id}:${p.part}:${Math.min(...f.triangles)}:${f.triangles.length}` : ''
    if (key === this.faceKey) return
    this.faceKey = key
    if (this.faceOverlay) {
      this.faceOverlay.removeFromParent()
      this.faceOverlay.geometry.dispose()
      this.faceOverlay = null
    }
    if (f && p) {
      const mesh = p.entry.parts[p.part]?.mesh
      const src = mesh?.userData.source as { positions: Float32Array; indices: Uint32Array | Uint16Array } | undefined
      if (mesh && src) {
        const pos = new Float32Array(f.triangles.length * 9)
        f.triangles.forEach((t, k) => {
          for (let v = 0; v < 3; v++) {
            const vi = 3 * (src.indices[3 * t + v] ?? 0)
            for (let a = 0; a < 3; a++) pos[9 * k + 3 * v + a] = src.positions[vi + a] ?? 0
          }
        })
        const g = new BufferGeometry()
        g.setAttribute('position', new BufferAttribute(pos, 3))
        const m = new MeshBasicMaterial({ color: new Color(this.faceColor), transparent: true, opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8, toneMapped: false })
        const o = new Mesh(g, m)
        o.raycast = () => {}
        o.renderOrder = 3
        mesh.add(o)
        this.faceOverlay = o
      }
    }
    this.emit('facehover', f?.pick ?? null)
    this.invalidate()
  }

  // ---------- camera ----------

  private framingBox(): Box3 {
    const box = new Box3()
    this.stage.scene.updateMatrixWorld(true)
    const sel = this.selection.map((id) => this.objects.get(id)).filter((o): o is ObjectEntry => !!o)
    if (this.mode === 'preview') {
      const b = this.toolpaths.bounds()
      if (b) {
        const m = this.stage.bedRoot.matrixWorld
        box.expandByPoint(new Vector3(...b.min).applyMatrix4(m))
        box.expandByPoint(new Vector3(...b.max).applyMatrix4(m))
      }
    }
    if (box.isEmpty()) {
      const list = sel.length ? sel : [...this.objects.values()]
      for (const o of list) box.expandByObject(o.group)
    }
    if (box.isEmpty()) box.setFromCenterAndSize(new Vector3(0, 20, 0), new Vector3(120, 40, 120))
    return box
  }

  view(preset: ViewPreset, opts: { animate?: boolean } = {}): void {
    const bed = this.stage.bed
    const pose = this.rig.presetPose(preset, this.framingBox(), Math.max(bed.widthMm, bed.depthMm))
    this.rig.preset = preset
    this.rig.go(pose, opts.animate ?? false, performance.now())
    this.invalidate()
  }

  zoomToSelection(opts: { animate?: boolean } = {}): void {
    const box = new Box3()
    this.stage.scene.updateMatrixWorld(true)
    const sel = this.selection.map((id) => this.objects.get(id)).filter((o): o is ObjectEntry => !!o)
    for (const o of sel.length ? sel : [...this.objects.values()]) box.expandByObject(o.group)
    if (box.isEmpty()) return this.view('bed', opts)
    this.frameBox(box, opts.animate ?? true)
  }

  /**
   * Eases the camera so the bed point (x, y, z in mm) is at the center of the view, keeping the angle and zoom.
   * With the system's reduced motion setting on, or `animate: false`, the camera jumps.
   */
  focusBedPoint(x: number, y: number, z: number, opts: { animate?: boolean } = {}): void {
    const world = new Vector3(x, y, z).applyMatrix4(this.stage.bedMatrix())
    this.rig.preset = null
    this.rig.go(this.rig.centerOn(world), opts.animate ?? true, performance.now())
    this.invalidate()
  }

  zoomToBed(opts: { animate?: boolean } = {}): void {
    this.view('bed', { animate: opts.animate ?? true })
  }

  zoomBy(factor: number, opts: { animate?: boolean } = {}): void {
    this.rig.preset = null
    this.rig.go(this.rig.zoomed(factor), opts.animate ?? true, performance.now())
    this.invalidate()
  }

  setProjection(projection: Projection): void {
    if (projection === this.projection) return
    const cam = this.camera
    const t = this.controls.target
    // Orthographic is a very long lens: a 1 degree field of view from far away, drawn identically to
    // a true orthographic camera to within a pixel, so AO, shadows and picking keep one code path.
    const from = cam.fov
    const to = projection === 'orthographic' ? ORTHO_FOV : this.perspFov
    if (projection === 'orthographic') this.perspFov = from
    const k = Math.tan((from * Math.PI) / 360) / Math.tan((to * Math.PI) / 360)
    cam.position.sub(t).multiplyScalar(k).add(t)
    cam.fov = to
    cam.updateProjectionMatrix()
    this.controls.minDistance *= k
    this.controls.maxDistance *= k
    this.rig.move = null
    this.projection = projection
    this.controls.update()
    this.cameraMoved = true
    this.invalidate()
    this.emit('camera', { preset: this.rig.preset })
  }

  getProjection(): Projection {
    return this.projection
  }

  toggleProjection(): Projection {
    this.setProjection(this.projection === 'orthographic' ? 'perspective' : 'orthographic')
    return this.projection
  }

  /** Animates the camera to frame a world-space box, keeping the view direction. */
  private frameBox(box: Box3, animate = true): void {
    const bed = this.stage.bed
    this.rig.preset = null
    this.rig.go(this.rig.presetPose('fit', box, Math.max(bed.widthMm, bed.depthMm)), animate, performance.now())
    this.invalidate()
  }

  private worldToBed(v: Vector3): [number, number, number] {
    const inv = this.stage.bedMatrix().invert()
    const b = v.clone().applyMatrix4(inv)
    return [b.x, b.y, b.z]
  }

  setTheme(theme?: ViewportTheme): void {
    const t = resolveTheme(theme)
    this.theme = t
    setSharedBandColors(t.heatRamp[0] ?? '#4f6bed', t.heatRamp[Math.floor((t.heatRamp.length - 1) / 2)] ?? '#f1fa8c', t.heatRamp[Math.floor((t.heatRamp.length - 1) * 0.75)] ?? '#ffb86c')
    this.pipeline.setSceneColors(t.scene)
    this.faceColor = t.scene.selection
    this.guides.setColor(t.scene.selection)
    this.brim.setColors(t.scene)
    this.cutRings.setColor('v', t.scene.selection)
    this.sketchLayer.setAccent(t.scene.selection)
    this.stage.setSceneColors(t.scene)
    setSharedSceneColors(t.scene)
    this.mats.dispose()
    this.toolpaths.setTheme(t)
    this.strikes.setColors(t.scene.overhangRed, t.scene.overhangAmber)
    this.toolpaths.setGantryColor(t.scene.overhangRed)
    this.applyMaterials()
  }

  setControls(controls: ControlsPresetId | ControlsMap): void {
    const prev = this.controlsMap.id
    this.controlsMap = typeof controls === 'string' ? CONTROL_PRESETS[controls] : controls
    this.applyControls()
    // A new look brings its own tool defaults (radius, band, angles); edits to one look's bindings keep the settings.
    if (this.controlsMap.id !== prev) this.painter?.applyPreset()
    this.painter?.update({})
  }

  getControls(): ControlsMap {
    return this.controlsMap
  }

  private applyControls(): void {
    const m = this.controlsMap
    const c = this.controls
    c.rotateSpeed = m.rotateSpeed
    c.zoomSpeed = m.wheel.invert ? -m.zoomSpeed : m.zoomSpeed
    c.zoomToCursor = m.wheel.zoomToCursor
  }

  /**
   * Points OrbitControls at what the preset says the pressed button does. Runs
   * before OrbitControls sees the event. Returns the resolved action.
   */
  private routeDrag(e: PointerEvent, hit: () => Vector3 | null): DragAction {
    if (e.pointerType === 'touch') return 'rotate'
    const name = buttonName(e.button)
    if (!name) return 'none'
    const mods = modifiersOf(e, this.spaceDown)
    const action = resolveDrag(this.controlsMap, name, mods, this.mode)
    const code = orbitCodeFor(action, mods) as 0 | 1 | 2
    const key = name === 'left' ? 'LEFT' : name === 'middle' ? 'MIDDLE' : 'RIGHT'
    this.controls.mouseButtons[key] = code
    if (action === 'rotate') {
      const pivot = this.controlsMap.freeCamera ? hit() : this.controlsMap.orbitAround === 'selection' ? this.selectionCenter() : null
      if (pivot) this.rig.retargetToDepthOf(pivot)
    }
    return action
  }

  private selectionCenter(): Vector3 | null {
    const sel = [...this.objects.values()].filter((o) => this.selection.includes(o.id))
    if (!sel.length) return null
    const box = new Box3()
    for (const o of sel) {
      o.group.updateMatrixWorld(true)
      box.expandByObject(o.group)
    }
    return box.getCenter(new Vector3())
  }

  /** Trackpad two-finger scrolls become pan or rotate when the preset says so; pinch and mouse wheels stay with OrbitControls. */
  private routeWheel(e: WheelEvent): void {
    // In the paint tool the wheel with the look's parameter key changes radius, band, fill angle or gap area, and with its clip key
    // moves the clipping plane (Orca: Ctrl and Alt; PrusaSlicer: Alt and Ctrl). A pinch also arrives with ctrlKey, in small
    // fractional steps, so only whole notches count. Alt wins over Ctrl, since Windows reports Right Alt as both.
    if (this.tool === 'paint' && e.deltaMode === 0 ? Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40 : this.tool === 'paint') {
      const pb = this.controlsMap.gizmo.paint
      const key = e.altKey ? 'alt' : e.ctrlKey || e.metaKey ? 'ctrl' : e.shiftKey ? 'shift' : null
      if (key && (key === pb.wheelParamKey || key === pb.wheelClipKey)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        const target = this.selection[0] ? this.objects.get(this.selection[0]) : [...this.objects.values()][0]
        this.painter.wheel(e.deltaY > 0 ? -1 : 1, key === pb.wheelParamKey ? 'param' : 'clip', this.camera, target ?? null)
        return
      }
    }
    const action = resolveWheel(this.controlsMap, e)
    if (action === 'zoom') return
    e.preventDefault()
    e.stopImmediatePropagation()
    const h = this.canvas.clientHeight
    if (action === 'pan') this.rig.panBy(-e.deltaX, -e.deltaY, h)
    else this.rig.orbitBy(-e.deltaX, -e.deltaY, h, this.controlsMap.rotateSpeed)
    this.cameraMoved = true
    this.invalidate()
  }

  getCamera(): CameraState {
    const t = this.controls.target
    const off = this.camera.position.clone().sub(t)
    const d = off.length()
    return {
      target: this.worldToBed(t),
      azimuthDeg: Math.atan2(off.x, off.z) / DEG,
      elevationDeg: Math.asin(Math.max(-1, Math.min(1, off.y / Math.max(1e-6, d)))) / DEG,
      distanceMm: d,
    }
  }

  setCamera(state: Partial<CameraState>, opts: { animate?: boolean } = {}): void {
    const cur = this.getCamera()
    const s = { ...cur, ...state }
    const target = new Vector3(...s.target).applyMatrix4(this.stage.bedMatrix())
    const az = s.azimuthDeg * DEG
    const el = Math.max(-89, Math.min(89, s.elevationDeg)) * DEG
    const pos = target.clone().add(new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(s.distanceMm))
    this.rig.preset = null
    this.rig.go({ pos, target }, opts.animate ?? false, performance.now())
    this.invalidate()
  }

  // ---------- plate tools ----------

  private bindPointer(): void {
    const el = this.canvas
    const ray = new Raycaster()
    const ndc = new Vector2()
    const plane = new Plane(new Vector3(0, 1, 0), 0)
    const hit = new Vector3()
    let down: { x: number; y: number } | null = null
    const setRay = (e: { clientX: number; clientY: number }): void => {
      const r = el.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, (-(e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, this.camera)
    }
    const pick = (e: { clientX: number; clientY: number }): PickHit | null => {
      if (this.mode !== 'prepare') return null
      setRay(e)
      const meshes: Mesh[] = []
      for (const o of this.objects.values()) for (const p of o.parts) meshes.push(p.mesh)
      const clipped = this.painter.clipPlane() !== null
      // With the painter's clipping plane on, what lies in front of it cannot be hit, and the cut opens the model so the
      // inside of its far wall can be reached: back faces count for the ray while the plane is on, as in Orca.
      const sides = clipped ? meshes.map((m) => (m.material as Material).side) : []
      if (clipped) for (const m of meshes) (m.material as Material).side = DoubleSide
      const hits = ray.intersectObjects(meshes, false)
      if (clipped) meshes.forEach((m, i) => ((m.material as Material).side = sides[i] ?? FrontSide))
      const h = clipped ? hits.find((x) => !this.painter.isClipped(x.point)) : hits[0]
      if (!h) return null
      const id = h.object.userData.objectId as string
      const entry = this.objects.get(id)
      return entry ? { entry, part: (h.object.userData.partIndex as number) ?? 0, point: h.point, face: h.faceIndex ?? -1, dir: ray.ray.direction.clone() } : null
    }
    this.pickFn = pick
    const bedHit = (e: PointerEvent): [number, number] | null => {
      setRay(e)
      if (!ray.ray.intersectPlane(plane, hit)) return null
      const b = this.worldToBed(hit)
      return [b[0], b[1]]
    }
    /** The ear under the cursor: by the model's hit point when the cursor is over the model, else by the bed under it. */
    const earAt = (e: PointerEvent, p: PickHit | null): { objectId: string; index: number } | null => {
      let xy: [number, number] | null = null
      if (p) {
        const b = this.worldToBed(p.point)
        xy = [b[0], b[1]]
      } else xy = bedHit(e)
      return xy ? this.brim.hit(xy[0], xy[1]) : null
    }
    /** Bed point under the cursor for a dragged ear: the model's hit, else the bed plane. */
    const earPoint = (e: PointerEvent): [number, number, number] | null => {
      const h = pick(e)
      if (h) return this.worldToBed(h.point)
      const bh = bedHit(e)
      return bh ? [bh[0], bh[1], 0] : null
    }
    // Sketch hovers and point drags go out at most once per frame, with the latest cursor.
    type SketchPending = { kind: 'hover' | 'drag'; e: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean }; handle?: number }
    let sketchPending: SketchPending | null = null
    const flushSketch = (): void => {
      const p = sketchPending
      sketchPending = null
      if (p && (p.kind === 'hover' ? this.sketchOn() : this.sketchDrag)) this.sketchEvent(p.kind, p.e, p.handle)
    }
    const queueSketch = (kind: SketchPending['kind'], e: PointerEvent, handle?: number): void => {
      const first = sketchPending === null
      sketchPending = { kind, e: { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, altKey: e.altKey }, ...(handle !== undefined ? { handle } : {}) }
      if (first) requestAnimationFrame(flushSketch)
    }
    // Probe hovers go out at most once per frame, with the latest cursor, and only while a tool asks.
    let probePending: { clientX: number; clientY: number } | null = null
    let probeLast = ''
    const flushProbe = (): void => {
      const p = probePending
      probePending = null
      if (!p || !this.probeHover || this.tool !== 'probe') return
      const h = pick(p)
      const ev = h && h.face >= 0 ? { objectId: h.entry.id, partIndex: h.part, triangle: h.face, point: this.worldToBed(h.point) } : null
      const key = ev ? `${ev.objectId}:${ev.partIndex}:${ev.point.map((v) => v.toFixed(3)).join(',')}` : ''
      if (key === probeLast) return
      probeLast = key
      this.emit('probehover', ev)
    }
    // The toolpath look's hover picks at most once per frame too: a pick tests every triangle of the models under the
    // ray, and pointer moves come faster than frames.
    let solidPending: { clientX: number; clientY: number } | null = null
    const flushSolid = (): void => {
      const p = solidPending
      solidPending = null
      if (!p || !this.toolpathLook.on || this.mode !== 'prepare' || this.drag) return
      this.hoverSolid(pick(p)?.entry.id ?? null)
    }
    const queueSolid = (e: PointerEvent): void => {
      const first = solidPending === null
      solidPending = { clientX: e.clientX, clientY: e.clientY }
      if (first) requestAnimationFrame(flushSolid)
    }
    const queueProbe = (e: PointerEvent): void => {
      const first = probePending === null
      probePending = { clientX: e.clientX, clientY: e.clientY }
      if (first) requestAnimationFrame(flushProbe)
    }
    const onDown = (e: PointerEvent): void => {
      const p0 = pick(e)
      const action = this.routeDrag(e, () => p0?.point ?? null)
      down = { x: e.clientX, y: e.clientY }
      if (this.mode !== 'prepare') return
      if (this.tool === 'brim') {
        if (e.button === 2) {
          // A right click on an ear removes it; anywhere else the button keeps its camera job.
          const ear = earAt(e, p0)
          if (ear) {
            this.emit('brimremove', ear)
            e.stopPropagation()
            e.preventDefault()
          }
          return
        }
        if (e.button !== 0) return
        const ear = earAt(e, p0)
        if (e.shiftKey || e.altKey) {
          // Shift draws a selection rectangle, Alt a deselect rectangle; a click without a drag toggles the ear under it.
          this.brimDrag = { kind: 'rect', x0: e.clientX, y0: e.clientY, mode: e.altKey ? 'remove' : 'add', ear, moved: false }
        } else if (ear) {
          this.brimDrag = { kind: 'ear', objectId: ear.objectId, index: ear.index, moved: false }
        } else return
        this.controls.enabled = false
        el.setPointerCapture(e.pointerId)
        e.stopPropagation()
        return
      }
      if (e.button !== 0 && !(e.button === 2 && this.tool === 'paint')) return
      if (this.cut) {
        setRay(e)
        if (this.cutDown(ray, e)) {
          el.setPointerCapture(e.pointerId)
          e.stopPropagation()
        }
        // While a cut is set up the model stays put: a press off the gizmo is the camera's.
        return
      }
      if (this.sketchOn()) {
        // A press on a sketch point drags it; anywhere else the press is the camera's, and a click is the tool's.
        const s = this.sketchLayer.scene!
        const at = this.sketchAt(e)
        const h = at ? this.sketchLayer.handleAt(at, 8 * this.mmPerPx(fromPlane(s.frame, at))) : -1
        if (h >= 0) {
          this.sketchDrag = { handle: h }
          this.controls.enabled = false
          el.setPointerCapture(e.pointerId)
          e.stopPropagation()
        }
        return
      }
      if (this.push && this.tool === 'probe') {
        if (this.pushDown(e, p0)) {
          el.setPointerCapture(e.pointerId)
          e.stopPropagation()
        }
        return
      }
      if (this.tool === 'rotate') {
        setRay(e)
        if (this.rotDown(ray, e)) {
          el.setPointerCapture(e.pointerId)
          e.stopPropagation()
          return
        }
      }
      if (this.tool === 'scale') {
        this.keys = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey }
        setRay(e)
        if (this.scaleDown(ray)) {
          el.setPointerCapture(e.pointerId)
          e.stopPropagation()
        }
        return
      }
      const p = p0
      if (!p) return
      if (this.tool === 'face' || this.tool === 'probe') return
      if (this.tool === 'paint') {
        if (this.paintDown(e, p)) e.stopPropagation()
        return
      }
      const explicit = this.tool !== 'select'
      // With the select tool the preset decides whether the press moves the model or orbits the view.
      if (!explicit && !dragStartsOnModel(this.controlsMap, modifiersOf(e, this.spaceDown), action, this.selection.includes(p.entry.id))) return
      this.selectIds([p.entry.id])
      const bh = bedHit(e)
      if (!bh) return
      const m = p.entry.group.matrix.toArray()
      const box = this.bedBox(p.entry)
      const tx = m[12] ?? 0
      const ty = m[13] ?? 0
      this.drag = {
        entry: p.entry,
        kind: this.tool === 'rotate' ? 'rotate' : 'move',
        start: m,
        offset: [tx - bh[0], ty - bh[1]],
        rel: { min: [box.min.x - tx, box.min.y - ty], max: [box.max.x - tx, box.max.y - ty] },
        startX: e.clientX,
        center: [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2],
        startYaw: Math.atan2(m[1] ?? 0, m[0] ?? 1),
      }
      this.controls.enabled = false
      el.setPointerCapture(e.pointerId)
      e.stopPropagation()
    }
    const onMove = (e: PointerEvent): void => {
      if (this.brimDrag) {
        const bd = this.brimDrag
        const dist = down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) : 0
        if (dist >= 4) bd.moved = true
        if (bd.kind === 'ear' && bd.moved) {
          const pt = earPoint(e)
          if (pt) this.emit('brimmove', { objectId: bd.objectId, index: bd.index, point: pt, final: false })
        } else if (bd.kind === 'rect' && bd.moved) this.showBrimRect(bd.x0, bd.y0, e.clientX, e.clientY, bd.mode)
        return
      }
      if (this.scaleDrag) {
        setRay(e)
        this.scaleMove(ray, e)
        return
      }
      if (this.rotDrag) {
        setRay(e)
        this.rotMove(ray, e)
        return
      }
      if (this.cutDrag) {
        setRay(e)
        this.cutMove(ray, e)
        return
      }
      if (this.pushDrag) {
        this.pushMove(e)
        return
      }
      if (this.sketchDrag) {
        queueSketch('drag', e, this.sketchDrag.handle)
        return
      }
      if (e.buttons === 0 && this.mode === 'prepare' && !this.drag) {
        if (this.sketchOn()) queueSketch('hover', e)
        if (this.cut) {
          setRay(e)
          this.cutHover(ray)
        } else if (this.tool === 'rotate') {
          setRay(e)
          this.ringHover(ray)
        }
      }
      if (this.tool === 'scale' && e.buttons === 0) {
        this.keys = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey }
        setRay(e)
        this.updateGizmo()
        if (this.gizmo.setHover(this.gizmo.hit(ray))) {
          this.canvas.style.cursor = this.gizmo.hit(ray) ? 'pointer' : ''
          this.updateGizmo()
          this.invalidate()
        }
      }
      const d = this.drag
      if (!d) {
        if (this.toolpathLook.on && this.mode === 'prepare' && e.buttons === 0) queueSolid(e)
        if ((this.tool === 'face' || (this.tool === 'probe' && this.probeFaces)) && this.mode === 'prepare' && e.buttons === 0) this.hoverFace(pick(e))
        if (this.tool === 'probe' && this.probeHover && this.mode === 'prepare' && e.buttons === 0) queueProbe(e)
        if (this.tool === 'paint' && this.mode === 'prepare') this.paintMove(e, pick)
        if (this.tool === 'brim' && this.mode === 'prepare' && e.buttons === 0) {
          const h = pick(e)
          const bp = h ? this.worldToBed(h.point) : null
          if (this.brim.setHover(bp ? [bp[0], bp[1]] : null)) this.invalidate()
        }
        return
      }
      const bed = this.stage.bed
      const m = new Matrix4().fromArray(d.start)
      if (d.kind === 'move') {
        const bh = bedHit(e)
        if (!bh) return
        let x = bh[0] + d.offset[0]
        let y = bh[1] + d.offset[1]
        const mv = this.controlsMap.gizmo.move
        if (this.modDown(mv.snapKey, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey })) {
          // Orca and Bambu Studio round a move to a step while Shift is down; the model's own offset is kept.
          x = Math.round(x / mv.snapStepMm) * mv.snapStepMm
          y = Math.round(y / mv.snapStepMm) * mv.snapStepMm
        }
        x = Math.max(-d.rel.min[0], Math.min(bed.widthMm - d.rel.max[0], x))
        y = Math.max(-d.rel.min[1], Math.min(bed.depthMm - d.rel.max[1], y))
        m.elements[12] = x
        m.elements[13] = y
      } else {
        let yaw = d.startYaw + (e.clientX - d.startX) * 0.012
        const rb = this.controlsMap.gizmo.rotate
        if (this.modDown(rb.snapKey, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey })) yaw = snapAngle(yaw, rb.snapStepDeg)
        const [cx, cy] = d.center
        const r = new Matrix4().makeTranslation(cx, cy, 0).multiply(new Matrix4().makeRotationZ(yaw - d.startYaw)).multiply(new Matrix4().makeTranslation(-cx, -cy, 0))
        m.premultiply(r)
      }
      d.entry.group.matrix.copy(m)
      d.entry.group.matrixWorldNeedsUpdate = true
      this.emit('transform', { id: d.entry.id, transform: m.toArray(), final: false })
      this.invalidate()
    }
    const onUp = (e: PointerEvent): void => {
      if (this.brimDrag) {
        const bd = this.brimDrag
        this.brimDrag = null
        this.controls.enabled = true
        this.hideBrimRect()
        down = null
        if (bd.kind === 'ear') {
          if (bd.moved) {
            const pt = earPoint(e)
            if (pt) this.emit('brimmove', { objectId: bd.objectId, index: bd.index, point: pt, final: true })
          } else this.emit('brimselect', { objectId: bd.objectId, indices: [bd.index], mode: 'set' })
        } else if (!bd.moved) {
          if (bd.ear) {
            const mode = bd.mode === 'remove' ? 'remove' : this.brim.isSelected(bd.ear.objectId, bd.ear.index) ? 'remove' : 'add'
            this.emit('brimselect', { objectId: bd.ear.objectId, indices: [bd.ear.index], mode })
          }
        } else this.brimRectSelect(bd.x0, bd.y0, e.clientX, e.clientY, bd.mode)
        return
      }
      if (this.scaleDrag) {
        this.scaleEnd(false)
        down = null
        return
      }
      if (this.rotDrag) {
        this.rotEnd(false)
        down = null
        return
      }
      if (this.cutDrag) {
        this.cutEnd(false)
        down = null
        return
      }
      if (this.sketchDrag) {
        if (sketchPending?.kind === 'drag') flushSketch()
        const h = this.sketchDrag.handle
        this.sketchDrag = null
        this.controls.enabled = true
        this.sketchEvent('release', e, h)
        down = null
        return
      }
      // A press that never became a push drag is a click.
      if (this.pushDrag && this.pushEnd(false)) {
        down = null
        return
      }
      if (this.painting) {
        this.painting = null
        this.controls.enabled = true
        this.painter.end()
        down = null
        return
      }
      const d = this.drag
      if (d) {
        this.drag = null
        this.controls.enabled = true
        this.emit('transform', { id: d.entry.id, transform: d.entry.group.matrix.toArray(), final: true })
        this.objectsMoved()
        down = null
        return
      }
      if (!down) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      down = null
      if (moved < 5 && this.sketchOn() && (e.button === 0 || e.button === 2)) {
        // Sketch clicks belong to the sketch: nothing is picked or selected.
        this.sketchEvent(e.button === 0 ? 'click' : 'context', e)
        return
      }
      if (moved >= 5 || e.button !== 0) return
      const p = pick(e)
      this.emit('pick', { objectId: p?.entry.id ?? null, partIndex: p?.part ?? null, point: p ? this.worldToBed(p.point) : null, triangle: p && p.face >= 0 ? p.face : null, bed: bedHit(e), ...(e.shiftKey ? { shift: true } : {}) })
      if (this.pathsShown() && !p) {
        // A click on a toolpath: which path it is, so the app can show the setting that made it.
        setRay(e)
        const toBed = this.stage.bedRoot.matrixWorld.clone().invert()
        const o = ray.ray.origin.clone().applyMatrix4(toBed)
        const d = ray.ray.direction.clone().transformDirection(toBed)
        const r = el.getBoundingClientRect()
        const hitPath = this.toolpaths.pick(o, d, (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / Math.max(1, r.height))
        this.emit('pathpick', hitPath ? { ...hitPath, screen: [e.clientX - r.left, e.clientY - r.top] } : null)
        return
      }
      // The probe tool only reports: the selection stays as it is.
      if (this.tool === 'probe') return
      if (this.tool === 'face' && p) {
        const f = this.faceFromHit(p)
        if (f) this.emit('facepick', f.pick)
      }
      if (this.tool === 'brim' && p && this.mode === 'prepare') {
        const pt = this.worldToBed(p.point)
        // A click on or near an ear never adds one; while ears are selected a click on the model only deselects them.
        if (!this.brim.hit(pt[0], pt[1])) {
          if (this.brim.anySelected) this.emit('brimselect', { objectId: p.entry.id, indices: [], mode: 'set' })
          else this.emit('brimadd', { objectId: p.entry.id, point: pt })
        }
        return
      }
      if (this.mode === 'prepare') this.selectIds(p ? [p.entry.id] : [])
    }
    const onCancel = (): void => {
      this.brimDrag = null
      this.hideBrimRect()
      this.scaleEnd(true)
      this.rotEnd(true)
      this.cutEnd(true)
      this.pushEnd(true)
      if (this.sketchDrag) {
        this.sketchDrag = null
        sketchPending = null
      }
      if (this.painting) {
        this.painting = null
        this.painter.end()
      }
      if (this.drag) {
        this.drag.entry.group.matrix.fromArray(this.drag.start)
        this.drag.entry.group.matrixWorldNeedsUpdate = true
        this.drag = null
        this.invalidate()
      }
      this.controls.enabled = true
      down = null
    }
    const onWheel = (e: WheelEvent): void => {
      if (this.tool === 'brim' && this.mode === 'prepare' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        e.stopPropagation()
        this.emit('brimwheel', { delta: e.deltaY < 0 ? 1 : -1 })
        return
      }
      this.routeWheel(e)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') this.selectIds([])
      if (e.code === 'Space') {
        this.spaceDown = true
        e.preventDefault()
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space') this.spaceDown = false
    }
    const onBlur = (): void => {
      this.spaceDown = false
    }
    const onDouble = (e: MouseEvent): void => {
      if (e.button !== 0 || this.mode !== 'prepare') return
      const dc = this.controlsMap.doubleClick
      const p = pick(e as PointerEvent)
      if (p && dc.object === 'zoom') {
        p.entry.group.updateMatrixWorld(true)
        this.frameBox(new Box3().setFromObject(p.entry.group))
      } else if (!p && dc.empty === 'fit') this.view('fit', { animate: true })
    }
    el.addEventListener('pointerdown', onDown, true)
    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    const onLeave = () => this.hoverSolid(null)
    el.addEventListener('pointerleave', onLeave)
    this.cleanups.push(() => el.removeEventListener('pointerleave', onLeave))
    el.addEventListener('keydown', onKey)
    el.addEventListener('keyup', onKeyUp)
    el.addEventListener('blur', onBlur)
    el.addEventListener('dblclick', onDouble)
    this.cleanups.push(() => {
      el.removeEventListener('pointerdown', onDown, true)
      el.removeEventListener('wheel', onWheel, true)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('keyup', onKeyUp)
      el.removeEventListener('blur', onBlur)
      el.removeEventListener('dblclick', onDouble)
    })
  }

  private selectIds(ids: string[]): void {
    const same = ids.length === this.selection.length && ids.every((id, i) => id === this.selection[i])
    this.selection = ids
    this.invalidate()
    if (!same) this.emit('select', { ids: [...ids] })
  }

  /** Object bounds in bed coordinates (x, y in mm; z up). */
  private bedBox(o: ObjectEntry): Box3 {
    const group: Group = o.group
    group.updateMatrixWorld(true)
    const b = new Box3().setFromObject(group)
    return b.applyMatrix4(this.stage.bedMatrix().invert())
  }

  arrange(opts: { animate?: boolean; gapMm?: number } = {}): Record<string, number[]> {
    const gap = opts.gapMm ?? 14
    const bed = this.stage.bed
    const usable = bed.widthMm - 20
    const items = [...this.objects.values()].map((o) => {
      const b = this.bedBox(o)
      return { o, w: b.max.x - b.min.x, d: b.max.y - b.min.y, cx: (b.min.x + b.max.x) / 2, cy: (b.min.y + b.max.y) / 2 }
    })
    items.sort((a, b) => b.d - a.d)
    const rows: { items: typeof items; w: number; d: number }[] = []
    for (const it of items) {
      let row = rows.find((r) => r.w + gap + it.w <= usable)
      if (!row) {
        row = { items: [], w: -gap, d: 0 }
        rows.push(row)
      }
      row.w += gap + it.w
      row.d = Math.max(row.d, it.d)
      row.items.push(it)
    }
    const totalD = rows.reduce((a, r) => a + r.d, 0) + gap * Math.max(0, rows.length - 1)
    if (totalD > bed.depthMm - 20) this.emit('degrade', { message: 'These models do not all fit on one plate. Scale one down or remove one.' })
    const out: Record<string, number[]> = {}
    const moves: { o: ObjectEntry; from: Matrix4; dx: number; dy: number }[] = []
    let y = bed.depthMm / 2 + totalD / 2
    for (const r of rows) {
      let x = bed.widthMm / 2 - r.w / 2
      for (const it of r.items) {
        const tx = x + it.w / 2
        const ty = y - r.d / 2
        const from = it.o.group.matrix.clone()
        const m = from.clone()
        m.elements[12] = (m.elements[12] ?? 0) + (tx - it.cx)
        m.elements[13] = (m.elements[13] ?? 0) + (ty - it.cy)
        out[it.o.id] = m.toArray()
        moves.push({ o: it.o, from, dx: tx - it.cx, dy: ty - it.cy })
        x += it.w + gap
      }
      y -= r.d + gap
    }
    const reduce = reducedMotion()
    const finish = (): void => {
      for (const mv of moves) this.emit('transform', { id: mv.o.id, transform: mv.o.group.matrix.toArray(), final: true })
      this.objectsMoved()
    }
    if (!opts.animate || reduce) {
      for (const mv of moves) {
        mv.o.group.matrix.fromArray(out[mv.o.id] ?? mv.from.toArray())
        mv.o.group.matrixWorldNeedsUpdate = true
      }
      finish()
      return out
    }
    let t0 = -1
    this.arrangeAnim = (now: number): boolean => {
      if (t0 < 0) t0 = now
      const k = Math.min(1, (now - t0) / 420)
      const e = 1 - Math.pow(1 - k, 3)
      for (const mv of moves) {
        const m = mv.from.clone()
        m.elements[12] = (m.elements[12] ?? 0) + mv.dx * e
        m.elements[13] = (m.elements[13] ?? 0) + mv.dy * e
        mv.o.group.matrix.copy(m)
        mv.o.group.matrixWorldNeedsUpdate = true
      }
      if (k >= 1) {
        this.arrangeAnim = null
        finish()
        return false
      }
      return true
    }
    this.invalidate()
    return out
  }

  // ---------- preview ----------

  setPreview(buffers: PreviewBuffers | null): void {
    this.previewGen++
    this.previewSetAt = performance.now()
    this.firstFrameMs = null
    this.toolpaths.set(buffers)
    this.shadowDirty = true
    this.invalidate()
  }

  setPreviewStale(stale: boolean): void {
    if (this.toolpaths.setStale(stale)) this.invalidate()
  }

  setPreviewOrigin(x: number, y: number): void {
    const root = this.stage.previewRoot
    if (root.position.x === -x && root.position.y === -y) return
    root.position.set(-x, -y, 0)
    this.shadowDirty = true
    this.invalidate()
  }

  setPreviewGhost(buffers: PreviewBuffers | null): void {
    if (!buffers) {
      if (!this.ghost) return
      this.ghost.root.removeFromParent()
      this.ghost.dispose()
      this.ghost = null
    } else {
      if (!this.ghost) {
        this.ghost = new Toolpaths(true)
        this.stage.previewRoot.add(this.ghost.root)
      }
      this.ghost.set(buffers)
      this.ghost.setRange(this.toolpaths.lo, this.toolpaths.hi, null)
    }
    this.invalidate()
  }

  /** Turns the bed outline orange (an object is off the bed). */
  setBedAlert(on: boolean): void {
    this.stage.setBedAlert(on)
    this.invalidate()
  }

  setGround(on: boolean): void {
    this.stage.setGround(on)
    this.invalidate()
  }

  /** Brightens one dual nozzle zone (by id); null resets. */
  setExcludedAreas(areas: readonly (readonly [number, number])[][]): void {
    this.stage.setExcludedAreas(areas)
    this.invalidate()
  }

  setZoneHighlight(id: string | null): void {
    this.stage.setZoneHighlight(id)
    this.invalidate()
  }

  setLayerRange(lo: number, hi: number): void {
    this.toolpaths.setRange(lo, hi, this.toolpaths.moveCut)
    this.ghost?.setRange(lo, hi, null)
    this.scrubbed = true
    this.shadowDirty = true
    this.invalidate()
  }

  setMoveCut(moves: number | null): void {
    this.toolpaths.setRange(this.toolpaths.lo, this.toolpaths.hi, moves)
    this.scrubbed = true
    this.shadowDirty = true
    this.invalidate()
  }

  setColorMode(mode: ColorMode): void {
    this.toolpaths.setColorMode(mode)
    this.invalidate()
  }

  setToolColors(colors: string[]): void {
    this.toolpaths.setToolColors(colors)
    this.invalidate()
  }

  setToolFinishes(finishes: ToolpathFinish[]): void {
    this.toolpaths.setToolFinishes(finishes)
    this.invalidate()
  }

  setPlateStyle(style: PlateStyle): void {
    this.stage.setPlateStyle(style)
    this.shadowDirty = true
    this.invalidate()
  }

  /** The printer family's toolhead, for a printer with one nozzle (`headFor` maps a profile id to it). */
  setHeadModel(model: HeadModel): void {
    this.toolpaths.setHeadModel(model)
    this.shadowDirty = true
    this.invalidate()
  }

  /** The printer's tool changer (toolhead, rack or dock to draw); null draws the printer's own single head. */
  setToolChanger(spec: ToolChangerSpec | null): void {
    this.toolpaths.setToolChanger(spec)
    this.shadowDirty = true
    this.invalidate()
  }

  /** Plays the tool change before `segment` at `seconds` into it; null returns the head to the current move. */
  setToolChange(c: { segment: number; seconds: number; fixed: number } | null): void {
    this.toolpaths.setToolChange(c)
    this.scrubbed = true
    this.shadowDirty = true
    this.invalidate()
  }

  /** Preview's "Show toolhead": false hides the moving head and its carriage; the rack, dock, chute and wiper stay. */
  setShowToolhead(on: boolean): void {
    this.toolpaths.setShowToolhead(on)
    this.shadowDirty = true
    this.invalidate()
  }

  /**
   * Preview's "Follow the nozzle": while the head moves, the orbit target and the camera shift with it by the same
   * amount, so the view keeps its angle and zoom and the nozzle stays where it was on screen.
   */
  setFollowNozzle(on: boolean): void {
    this.toolpaths.onHead = on
      ? (x, y, z) => {
          const w = this.toolpaths.root.localToWorld(new Vector3(x, y, z))
          const d = w.sub(this.controls.target)
          if (d.lengthSq() < 1e-10) return
          this.controls.target.add(d)
          this.camera.position.add(d)
          this.invalidate()
        }
      : null
  }

  /** Each tool change's purge at the chute (from the G-code), drawn while the change plays; null for none. */
  setPurges(plans: readonly PurgePlan[] | null): void {
    this.toolpaths.setPurges(plans)
    this.invalidate()
  }

  setTravels(on: boolean): void {
    this.toolpaths.setTravels(on)
    this.invalidate()
  }

  setPreviewExtras(extras: PreviewExtras | null): void {
    this.toolpaths.setExtras(extras)
    this.invalidate()
  }

  previewExtras(): { fan: boolean; temperature: boolean } & Record<MarkerKind, boolean> {
    return { ...this.toolpaths.hasExtras(), ...this.toolpaths.hasMarkers() }
  }

  setMarkers(opts: Partial<Record<MarkerKind, boolean>>): void {
    this.toolpaths.setMarkers(opts)
    this.invalidate()
  }

  setGcodeMarkers(data: Partial<Record<'wipes' | 'toolChanges' | 'pauses', Float32Array | null>>): void {
    this.toolpaths.setGcodeMarkers(data)
    this.invalidate()
  }

  setGantry(spec: GantrySpec | null, hits: readonly GantryHit[] | null): void {
    this.toolpaths.setGantry(spec)
    this.toolpaths.setGantryHits(hits)
  }

  setStrikes(marks: readonly StrikeMark[] | null): void {
    this.strikes.set(marks)
    this.invalidate()
  }

  previewRanges(): PreviewRanges {
    return this.toolpaths.ranges()
  }

  previewLegend(): LegendFeature[] {
    const b = this.toolpaths.buffers
    if (!b) return []
    if (this.summaryFor !== b) {
      this.summary = summarizePreview(b)
      this.summaryFor = b
    }
    const s = this.summary
    if (!s) return []
    return FEATURE_COLORS.filter((f) => (s.featureMm[f.id] ?? 0) > 0).map((f) => ({
      id: f.id,
      label: f.label,
      color: this.theme.featureColors[FEATURE_COLORS.indexOf(f)] ?? f.color,
      timeS: s.featureTimeS[f.id] ?? 0,
      lengthMm: s.featureMm[f.id] ?? 0,
      visible: ((this.featureMask >>> f.id) & 1) === 1,
    }))
  }

  setFeatureVisible(id: number, visible: boolean): void {
    this.featureMask = visible ? this.featureMask | (1 << id) : this.featureMask & ~(1 << id)
    this.toolpaths.setFeatureMask(this.featureMask)
    this.invalidate()
  }

  setVisibleFeatures(ids: readonly number[]): void {
    this.featureMask = ids.reduce((m, id) => m | (1 << id), 0)
    this.toolpaths.setFeatureMask(this.featureMask)
    this.invalidate()
  }

  currentMove(): { segment: number; layer: number; gcodeLine: number } | null {
    return this.toolpaths.currentMove()
  }

  layerMoveCount(layer: number): number {
    const b = this.toolpaths.buffers
    if (!b || layer < 0 || layer >= b.layerCount) return 0
    return (b.layerStart[layer + 1] ?? 0) - (b.layerStart[layer] ?? 0)
  }

  // ---------- stats ----------

  stats(): ViewportStats {
    const frameMs = this.frameMs.values()
    const renderMs = this.renderMs.values()
    const costMs = this.costMs.values()
    const sorted = (costMs.length ? costMs : frameMs.length ? frameMs : renderMs).slice().sort((a, b) => a - b)
    const info = this.renderer.info
    const size = this.pipeline.size
    return {
      backend: 'webgl2',
      gpu: this.gpu,
      quality: this.quality,
      pixelRatio: this.pr,
      width: size.width,
      height: size.height,
      frames: this.frames,
      frameMs,
      renderMs,
      costMs,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      firstFrameMs: this.firstFrameMs,
      firstDrawMs: this.firstFrame.ms,
      objectBuilds: this.objectBuilds,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      segments: this.toolpaths.segmentCount,
      aoOn: this.aoOn,
      motionScale: this.pipeline.motionScale,
    }
  }

  resetStats(): void {
    this.frameMs.clear()
    this.renderMs.clear()
    this.costMs.clear()
    this.lastRenderT = 0
  }

  /** Turns the frame probe on or off (see probe.ts). Turning it on starts a fresh measurement. */
  setProbe(on: boolean): void {
    if (on && !this.probe && !this.disposed) this.probe = new FrameProbe(this.renderer)
    else if (!on && this.probe) {
      this.probe.dispose()
      this.probe = null
    }
    this.probe?.reset()
  }

  /** What the frame probe measured since it started or was reset; null while it is off. */
  probeStats(): ProbeStats | null {
    return this.probe?.stats() ?? null
  }

  resetProbe(): void {
    this.probe?.reset()
  }

  setGpuTiming(on: boolean): void {
    this.gpuTiming = on
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const p of this.parked.values()) {
      clearTimeout(p.timer)
      disposeObject(p.entry)
    }
    this.parked.clear()
    this.strikes.dispose()
    this.painter.dispose()
    this.gizmo.dispose()
    this.cutPreview.detach()
    this.rotRings.dispose()
    this.cutRings.dispose()
    this.cutGizmo.dispose()
    this.pushView.dispose()
    this.edgeView.dispose()
    this.sketchLayer.dispose()
    this.dims.dispose()
    this.gizmoLabel?.remove()
    this.probe?.dispose()
    this.probe = null
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    for (const c of this.cleanups) c()
    this.ro?.disconnect()
    this.io?.disconnect()
    this.controls.dispose()
    for (const o of this.objects.values()) disposeObject(o)
    this.objects.clear()
    this.ghost?.dispose()
    this.toolpaths.dispose()
    this.brim.dispose()
    this.brimRectEl?.remove()
    this.mats.dispose()
    this.pipeline.dispose()
    this.stage.dispose()
    this.listeners.clear()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
  }

  /** Canvas size in CSS pixels, for overlays. */
  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height }
  }
}
