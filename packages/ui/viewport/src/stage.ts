// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The studio set: generated room environment (PMREM, no HDR files), key light
// with soft PCF shadows, cool rim light, the textured build plate, the floor
// grid and the baked contact shadow under objects.
import {
  BufferGeometry,
  DoubleSide,
  Sprite,
  SpriteMaterial,
  type PerspectiveCamera,
  CanvasTexture,
  Line,
  LineBasicMaterial,
  ShapeGeometry,
  Vector2,
  Color,
  CubeCamera,
  HalfFloatType,
  DirectionalLight,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  PCFShadowMap,
  PMREMGenerator,
  PlaneGeometry,
  Scene,
  Shape,
  ShaderMaterial,
  CustomBlending,
  Vector3,
  WebGLCubeRenderTarget,
  WebGLRenderTarget,
  type Object3D,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { LightProbeGenerator } from 'three/addons/lights/LightProbeGenerator.js'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import type { Bed } from '@slicerx/contracts'
import { SCENE, type SceneColors } from './palette'

/** Objects sit this far above the plate top so their bottoms never fight it for depth. */
export const LIFT_MM = 0.02
/**
 * The floor overlays (the plate outline and grid, nozzle zones, excluded areas, the contact shadow) all lie at
 * FLOOR_Y, under the bed root's lift, so the first layer's beads (which start at LIFT_MM) never share a depth with
 * them. They had sat a few thousandths of a millimetre apart around LIFT_MM, closer than a depth buffer resolves at
 * a normal viewing distance, and the floor flickered against the first layer as the view moved. Being transparent
 * and writing no depth, the overlays stack by render order alone, and a polygon offset keeps them behind any bead.
 */
export const FLOOR_Y = 0
export const FLOOR_ORDER = { plate: -4, fill: -3, line: -2, contact: 1 } as const
/** Pushes a floor overlay back in depth, so a bead at the same depth always draws over it. */
const FLOOR_OFFSET = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 } as const

const CONTACT_BLUR_FS = /* glsl */ `
uniform sampler2D tDiffuse; uniform vec2 dir; varying vec2 vUv;
void main(){
  vec4 s = vec4(0.0);
  s += texture2D(tDiffuse, vUv - 4.0*dir)*0.051; s += texture2D(tDiffuse, vUv - 3.0*dir)*0.0918;
  s += texture2D(tDiffuse, vUv - 2.0*dir)*0.12245; s += texture2D(tDiffuse, vUv - dir)*0.1531;
  s += texture2D(tDiffuse, vUv)*0.1633; s += texture2D(tDiffuse, vUv + dir)*0.1531;
  s += texture2D(tDiffuse, vUv + 2.0*dir)*0.12245; s += texture2D(tDiffuse, vUv + 3.0*dir)*0.0918;
  s += texture2D(tDiffuse, vUv + 4.0*dir)*0.051;
  gl_FragColor = s;
}`

const CONTACT_DEPTH_FS = /* glsl */ `
uniform float darkness; uniform float range; varying float vH;
void main(){ gl_FragColor = vec4(0.0, 0.0, 0.0, min(1.0, max(clamp(1.0 - vH / range, 0.0, 1.0) * darkness, 0.6))); }`

const CONTACT_DEPTH_VS = /* glsl */ `
varying float vH;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vH = w.y; gl_Position = projectionMatrix * viewMatrix * w; }`

const PLATE_OUTLINE_FS = /* glsl */ `
uniform vec3 edge; uniform vec3 edgeAlt; uniform float alert; uniform vec3 grid; uniform vec2 hb; varying vec2 vP;
float lines(vec2 p, float s){ vec2 q = p / s; vec2 w = fwidth(q); vec2 g = abs(fract(q - 0.5) - 0.5) / max(w, vec2(1e-4)); return (1.0 - min(min(g.x, g.y), 1.0)) * (1.0 - smoothstep(0.3, 0.7, max(w.x, w.y))); }
void main(){
  vec2 q = abs(vP) - hb;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  float px = max(fwidth(d), 1e-3);
  float line = 1.0 - smoothstep(0.0, 1.0, abs(d) / (px * 1.1));
  float glow = exp(-abs(d) / 2.2) * (d < 0.0 ? 0.18 : 0.1);
  // Four identical L brackets starting exactly at each corner, both legs inside the outline.
  vec2 c = hb - abs(vP);
  float inset = 1.1, th = 0.8, len = 14.0;
  float bx = (1.0 - smoothstep(th, th + px, abs(c.y - inset))) * step(0.0, c.x) * (1.0 - smoothstep(len, len + px, c.x));
  float by = (1.0 - smoothstep(th, th + px, abs(c.x - inset))) * step(0.0, c.y) * (1.0 - smoothstep(len, len + px, c.y));
  float br = max(bx, by);
  vec2 r = abs(vP) / hb;
  float fade = 1.0 - smoothstep(0.35, 1.0, max(r.x, r.y));
  float inside = 1.0 - smoothstep(-0.4, 0.0, d);
  float gl = (lines(vP + hb, 10.0) * 0.35 + lines(vP + hb, 50.0) * 0.75) * fade * inside * 0.3;
  float inner = exp(d / 10.0) * inside * 0.045;
  float aEdge = clamp(line * 0.9 + glow + br * 0.7, 0.0, 1.0);
  float aG = clamp(gl + inner, 0.0, 1.0);
  float a = clamp(aEdge + aG * (1.0 - aEdge), 0.0, 1.0);
  vec3 col = (mix(edge, edgeAlt, alert) * aEdge + grid * aG * (1.0 - aEdge));
  gl_FragColor = vec4(col, a);
}`

/** An area only one nozzle can reach, in bed coordinates (mm, origin front left). */
export interface NozzleZone {
  id: string
  label: string
  color: string
  polygon: [number, number][]
}

/** The irradiance bake ended after its stage was disposed; nothing is wrong, the result is just not wanted. */
export class StageDisposedError extends Error {
  constructor() {
    super('The stage was disposed before the environment bake finished')
    this.name = 'StageDisposedError'
  }
}

export class Stage {
  readonly scene = new Scene()
  /** Bed frame: Z up, mm, origin at the bed's front left corner. Everything slicer-side hangs here. */
  readonly bedRoot = new Group()
  readonly objectsRoot = new Group()
  readonly previewRoot = new Group()
  readonly key: DirectionalLight
  readonly rim: DirectionalLight
  bed: Bed = { widthMm: 256, depthMm: 256, heightMm: 256 }
  private decor = new Group()
  private zoneGroup = new Group()
  private outline: ShaderMaterial | null = null
  private zoneLabels: { sprite: Sprite; centre: Vector3; thin: Vector3 }[] = []
  private alert = false
  private zones: readonly NozzleZone[] = []
  private zoneDisposables: { dispose(): void }[] = []
  private excluded: readonly (readonly [number, number])[][] = []
  private excludeGroup = new Group()
  private excludeDisposables: { dispose(): void }[] = []
  private envTex: Texture | null = null
  private contact: {
    plane: Mesh
    rt: WebGLRenderTarget
    rtb: WebGLRenderTarget
    cam: OrthographicCamera
    mat: ShaderMaterial
    blur: ShaderMaterial
    quad: FullScreenQuad
    size: number
  } | null = null
  private label = 'Textured PEI'
  private colors: SceneColors = SCENE
  private disposables: { dispose(): void }[] = []

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly weak: boolean,
  ) {
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = PCFShadowMap
    renderer.shadowMap.autoUpdate = false

    const pm = new PMREMGenerator(renderer)
    const room = new RoomEnvironment()
    // Prefiltering runs before the first frame; on a software renderer the 256 px cube took about 140 ms of it.
    this.envTex = pm.fromScene(room, 0.04, 0.1, 100, { size: weak ? 128 : 256 }).texture
    pm.dispose()
    this.scene.environment = this.envTex
    this.envSH = this.bakeSH(room).finally(() => room.dispose())

    // Intensities are the concept's legacy-light values times pi (three.js now uses physical units).
    const key = new DirectionalLight(new Color(0xfff3e6), 1.6 * Math.PI)
    key.position.set(-150, 300, 190)
    key.castShadow = true
    const sz = weak ? 1024 : 2048
    key.shadow.mapSize.set(sz, sz)
    key.shadow.bias = -0.00025
    key.shadow.normalBias = 0.35
    key.shadow.radius = 3
    this.scene.add(key, key.target)
    this.key = key
    const rim = new DirectionalLight(new Color(0xb7c3ff), 0.75 * Math.PI)
    rim.position.set(180, 140, -260)
    this.scene.add(rim)
    this.rim = rim

    this.bedRoot.matrixAutoUpdate = false
    this.bedRoot.add(this.objectsRoot, this.previewRoot)
    this.scene.add(this.decor, this.bedRoot)
    this.setBed(this.bed, this.label)
  }

  /** Bed coordinates (Z up, front left origin) to three.js world (Y up, bed center at origin). */
  /** Spherical-harmonic irradiance of the room environment, for materials that skip the prefiltered map. */
  readonly envSH: Promise<Vector3[]>

  /** The cube target the irradiance bake reads back, until the bake ends or the stage is disposed. */
  private shTarget: WebGLCubeRenderTarget | null = null
  private disposed = false

  /**
   * Runs once per stage. The read back spans several frames (one async read per cube face), so the stage can be
   * disposed, and the renderer with it, before it ends: then the target was already released by `dispose` while the
   * renderer still knew it. Releasing it again after `renderer.dispose()` makes three.js look up framebuffers it has
   * forgotten and throw.
   */
  private async bakeSH(room: Scene): Promise<Vector3[]> {
    const rt = new WebGLCubeRenderTarget(32, { type: HalfFloatType })
    this.shTarget = rt
    const cam = new CubeCamera(0.1, 100, rt)
    cam.update(this.renderer, room)
    try {
      const probe = await LightProbeGenerator.fromCubeRenderTarget(this.renderer, rt)
      if (this.disposed) throw new StageDisposedError()
      return probe.sh.coefficients.map((c) => c.clone())
    } finally {
      this.releaseShTarget(rt)
    }
  }

  private releaseShTarget(rt: WebGLCubeRenderTarget): void {
    if (this.shTarget !== rt) return
    this.shTarget = null
    rt.dispose()
  }

  bedMatrix(): Matrix4 {
    const { widthMm: W, depthMm: D } = this.bed
    return new Matrix4().set(1, 0, 0, -W / 2, 0, 0, 1, LIFT_MM, 0, -1, 0, D / 2, 0, 0, 0, 1)
  }

  setBed(bed: Bed, label?: string): void {
    const same = bed.widthMm === this.bed.widthMm && bed.depthMm === this.bed.depthMm && (label ?? this.label) === this.label && this.decor.children.length > 0
    this.bed = { ...bed }
    if (label !== undefined) this.label = label
    this.bedRoot.matrix.copy(this.bedMatrix())
    this.bedRoot.matrixWorldNeedsUpdate = true
    if (same) return
    for (const d of this.disposables) d.dispose()
    this.disposables = []
    this.decor.clear()
    this.buildPlate()
    this.buildContact()
    const span = Math.max(bed.widthMm, bed.depthMm) * 0.75
    const sc = this.key.shadow.camera
    sc.left = -span
    sc.right = span
    sc.top = span
    sc.bottom = -span
    sc.near = 60
    sc.far = 800 + Math.max(0, bed.heightMm - 256)
    sc.updateProjectionMatrix()
    this.renderer.shadowMap.needsUpdate = true
  }

  /** Bed and floor colors. Rebuilds the plate decor. */
  setSceneColors(colors: SceneColors): void {
    this.colors = colors
    for (const d of this.disposables) d.dispose()
    this.disposables = []
    this.decor.clear()
    this.buildPlate()
    this.buildContact()
    this.renderer.shadowMap.needsUpdate = true
  }

  /** Areas only one nozzle reaches, drawn as tinted floor patches (bed coordinates, mm, origin front left). */
  setNozzleZones(zones: readonly NozzleZone[]): void {
    this.zones = zones
    for (const d of this.zoneDisposables) d.dispose()
    this.zoneDisposables = []
    this.zoneGroup.clear()
    this.zoneLabels = []
    this.buildZones()
  }

  /**
   * Parts of the bed nothing may print on (the printer's `bed_exclude_area`), as polygons in bed coordinates (mm,
   * origin front left). Drawn once as hatched patches with an outline; nothing about them changes per frame.
   */
  setExcludedAreas(areas: readonly (readonly [number, number])[][]): void {
    this.excluded = areas
    for (const d of this.excludeDisposables) d.dispose()
    this.excludeDisposables = []
    this.excludeGroup.clear()
    const { widthMm: W, depthMm: D } = this.bed
    const color = new Color(this.colors.floorGrid)
    for (const poly of areas) {
      if (poly.length < 3) continue
      const geo = new ShapeGeometry(new Shape(poly.map(([x, y]) => new Vector2(x - W / 2, D / 2 - y)))).rotateX(Math.PI / 2)
      const mat = new ShaderMaterial({
        uniforms: { col: { value: color } },
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        vertexShader: 'varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        // Diagonal hatching 2.5 mm apart over a faint wash, antialiased with the screen derivative.
        fragmentShader: 'uniform vec3 col; varying vec2 vP; void main(){ float s = (vP.x + vP.y) / 2.5; float w = fwidth(s); float f = abs(fract(s) - 0.5); float stripe = 1.0 - smoothstep(0.16 - w, 0.16 + w, f); float a = 0.08 + stripe * 0.26; gl_FragColor = vec4(col * a, a); }',
        blending: CustomBlending,
        blendSrc: OneFactor,
        blendDst: OneMinusSrcAlphaFactor,
        blendSrcAlpha: OneFactor,
        blendDstAlpha: OneMinusSrcAlphaFactor,
        ...FLOOR_OFFSET,
      })
      const fill = new Mesh(geo, mat)
      fill.position.y = FLOOR_Y
      fill.renderOrder = FLOOR_ORDER.fill
      fill.name = 'excluded-area'
      const loop: Vector3[] = poly.map(([x, y]) => new Vector3(x - W / 2, FLOOR_Y, D / 2 - y))
      const lg = new BufferGeometry().setFromPoints([...loop, loop[0] as Vector3])
      const lm = new LineBasicMaterial({ color, transparent: true, opacity: 0.65, depthWrite: false, toneMapped: false })
      const line = new Line(lg, lm)
      line.renderOrder = FLOOR_ORDER.line
      this.excludeGroup.add(fill, line)
      this.excludeDisposables.push(geo, mat, lg, lm)
    }
  }

  /** The outline turns orange while an object sits off the bed. */
  setBedAlert(on: boolean): void {
    this.alert = on
    if (this.outline?.uniforms.alert) this.outline.uniforms.alert.value = on ? 1 : 0
  }

  /** Brightens one zone (by id) and leaves the others as they were; null resets all. */
  setZoneHighlight(id: string | null): void {
    for (const o of this.zoneGroup.children) {
      const on = id !== null && o.userData.zone === id
      const m = (o as Mesh).material as { opacity?: number; uniforms?: { boost?: { value: number } } }
      if (o.type === 'Line' && m.opacity !== undefined) m.opacity = on ? 1 : 0.8
      else if (m.uniforms?.boost) m.uniforms.boost.value = on ? 1.7 : 1
    }
  }

  private buildZones(): void {
    const { widthMm: W, depthMm: D } = this.bed
    for (const z of this.zones) {
      if (z.polygon.length < 3) continue
      const color = new Color(z.color)
      const xs = z.polygon.map((p) => p[0] - W / 2)
      const zs = z.polygon.map((p) => D / 2 - p[1])
      const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]
      // The strip runs along the bed edge it touches: full tint at its inner boundary, fading to the bed edge.
      const alongX = x1 - x0 < z1 - z0
      const outerIsLow = alongX ? x0 <= -W / 2 + 0.5 : z0 <= -D / 2 + 0.5
      const geo = new ShapeGeometry(new Shape(z.polygon.map(([x, y]) => new Vector2(x - W / 2, D / 2 - y)))).rotateX(Math.PI / 2)
      const mat = new ShaderMaterial({
        uniforms: { col: { value: color }, lo: { value: alongX ? x0 : z0 }, hi: { value: alongX ? x1 : z1 }, axisX: { value: alongX ? 1 : 0 }, outerLow: { value: outerIsLow ? 1 : 0 }, boost: { value: 1 } },
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        vertexShader: 'varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform vec3 col; uniform float lo; uniform float hi; uniform float axisX; uniform float outerLow; uniform float boost; varying vec2 vP; void main(){ float t = clamp(((axisX > 0.5 ? vP.x : vP.y) - lo) / max(hi - lo, 1e-3), 0.0, 1.0); float inner = outerLow > 0.5 ? t : 1.0 - t; float a = mix(0.07, 0.3, inner) * boost; gl_FragColor = vec4(col * a, a); }',
        blending: CustomBlending,
        blendSrc: OneFactor,
        blendDst: OneMinusSrcAlphaFactor,
        blendSrcAlpha: OneFactor,
        blendDstAlpha: OneMinusSrcAlphaFactor,
        ...FLOOR_OFFSET,
      })
      const fill = new Mesh(geo, mat)
      fill.position.y = FLOOR_Y
      fill.renderOrder = FLOOR_ORDER.fill
      const loop: Vector3[] = z.polygon.map(([x, y]) => new Vector3(x - W / 2, FLOOR_Y, D / 2 - y))
      const lg = new BufferGeometry().setFromPoints([...loop, loop[0] as Vector3])
      const lm = new LineBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false })
      const line = new Line(lg, lm)
      line.renderOrder = FLOOR_ORDER.line
      fill.userData.zone = z.id
      line.userData.zone = z.id
      this.zoneGroup.add(fill, line)
      this.zoneDisposables.push(geo, mat, lg, lm)
      // A screen-space mono label at the middle of the strip: horizontal, 11 px, faded out when the strip gets too thin.
      if (typeof document !== 'undefined') {
        const cv = document.createElement('canvas')
        cv.width = 384
        cv.height = 64
        const g = cv.getContext('2d')
        if (g) {
          g.font = '500 36px ui-monospace, Menlo, monospace'
          g.textAlign = 'center'
          g.textBaseline = 'middle'
          g.fillStyle = z.color
          g.fillText(z.label, 192, 34)
        }
        const tex = new CanvasTexture(cv)
        const lmat = new SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false, toneMapped: false, opacity: 0.8 })
        const label = new Sprite(lmat)
        label.position.set((x0 + x1) / 2, 0.3, (z0 + z1) / 2)
        label.renderOrder = 5
        label.userData.zone = z.id
        this.zoneGroup.add(label)
        const thin = alongX ? new Vector3(x1 - x0, 0, 0) : new Vector3(0, 0, z1 - z0)
        this.zoneLabels.push({ sprite: label, centre: label.position.clone(), thin })
        this.zoneDisposables.push(tex, lmat)
      }
    }
  }

  /** Keeps the zone labels 11 px tall whatever the camera does, and hides one while its strip is under 40 px wide on screen. */
  updateZoneLabels(camera: PerspectiveCamera, heightPx: number): void {
    if (this.zoneLabels.length === 0) return
    const k = 2 * Math.tan((camera.fov * Math.PI) / 360)
    const cssH = 16
    const p0 = new Vector3()
    const p1 = new Vector3()
    for (const l of this.zoneLabels) {
      l.sprite.scale.set((cssH * 6) / heightPx * k, (cssH / heightPx) * k, 1)
      const world = this.decor.localToWorld(l.centre.clone())
      p0.copy(world).project(camera)
      p1.copy(world).add(l.thin).project(camera)
      const px = Math.hypot((p1.x - p0.x) * camera.aspect, p1.y - p0.y) * 0.5 * heightPx
      const m = l.sprite.material
      m.opacity = px < 120 ? 0 : 0.8
    }
  }

  /**
   * The bed is an empty floor: a thin glowing outline of the printable area with corner marks and a faint grid
   * that fades toward the edges, all in one transparent quad, so nothing is shaded and no texture is sampled.
   */
  private buildPlate(): void {
    const bed = this.bed
    const half = new Vector2(bed.widthMm / 2, bed.depthMm / 2)
    const pad = 24
    const mat = new ShaderMaterial({
      uniforms: { edge: { value: new Color(this.colors.selection) }, edgeAlt: { value: new Color(this.colors.overhangAmber) }, alert: { value: this.alert ? 1 : 0 }, grid: { value: new Color(this.colors.floorGrid) }, hb: { value: half } },
      transparent: true,
      depthWrite: false,
      vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: PLATE_OUTLINE_FS,
      ...FLOOR_OFFSET,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
    })
    const geo = new PlaneGeometry(bed.widthMm + pad * 2, bed.depthMm + pad * 2)
    const quad = new Mesh(geo, mat)
    // Plane xy is bed xz: lie it flat with +y up.
    quad.rotation.x = -Math.PI / 2
    quad.position.y = FLOOR_Y
    quad.renderOrder = FLOOR_ORDER.plate
    this.outline = mat
    this.decor.add(quad)
    this.decor.add(this.zoneGroup)
    this.decor.add(this.excludeGroup)
    this.setNozzleZones(this.zones)
    this.setExcludedAreas(this.excluded)
    this.disposables.push(geo, mat)
  }

  private buildContact(): void {
    const bed = this.bed
    const SZ = Math.max(bed.widthMm, bed.depthMm) + 34
    const RES = this.weak ? 512 : 1024
    const rt = new WebGLRenderTarget(RES, RES)
    const rtb = new WebGLRenderTarget(RES, RES)
    rt.texture.generateMipmaps = false
    rtb.texture.generateMipmaps = false
    const planeGeo = new PlaneGeometry(SZ, SZ).rotateX(Math.PI / 2)
    const planeMat = new MeshBasicMaterial({ map: rt.texture, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false, ...FLOOR_OFFSET })
    const plane = new Mesh(planeGeo, planeMat)
    plane.scale.y = -1
    plane.position.y = FLOOR_Y
    plane.renderOrder = FLOOR_ORDER.contact
    this.decor.add(plane)
    const cam = new OrthographicCamera(-SZ / 2, SZ / 2, SZ / 2, -SZ / 2, 0, 22)
    cam.rotation.x = Math.PI / 2
    cam.updateMatrixWorld()
    const mat = new ShaderMaterial({ uniforms: { darkness: { value: 2.1 }, range: { value: 22 } }, vertexShader: CONTACT_DEPTH_VS, fragmentShader: CONTACT_DEPTH_FS, depthTest: false, depthWrite: false, transparent: true })
    const blur = new ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, dir: { value: [0, 0] } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: CONTACT_BLUR_FS,
      depthTest: false,
      depthWrite: false,
    })
    const quad = new FullScreenQuad(blur)
    this.contact = { plane, rt, rtb, cam, mat, blur, quad, size: RES }
    this.disposables.push(rt, rtb, planeGeo, planeMat, mat, blur, quad)
  }

  setContactVisible(on: boolean): void {
    if (this.contact) this.contact.plane.visible = on
  }

  private contactDirty = false

  /** Objects moved: the contact shadow is baked again before the next frame, once however many moves come first. */
  requestContact(): void {
    this.contactDirty = true
  }

  /** Bakes the contact shadow if objects moved since the last bake. The viewport calls it before each frame. */
  bakePendingContact(): void {
    if (!this.contactDirty) return
    this.contactDirty = false
    this.bakeContact()
  }

  /** Renders the objects from below the plate, darker where they are closer, and blurs it. */
  bakeContact(): void {
    const C = this.contact
    if (!C) return
    const r = this.renderer
    const sc = this.scene
    const hidden: Object3D[] = []
    sc.traverse((o) => {
      if (o.visible && (o === this.decor || o === this.previewRoot || o.type === 'LineSegments')) {
        hidden.push(o)
        o.visible = false
      }
    })
    const prevOverride = sc.overrideMaterial
    const prevEnv = sc.environment
    sc.overrideMaterial = C.mat
    r.setRenderTarget(C.rt)
    r.setClearColor(0x000000, 0)
    r.clear(true, true, true)
    r.render(sc, C.cam)
    sc.overrideMaterial = prevOverride
    sc.environment = prevEnv
    for (const o of hidden) o.visible = true
    const blur = (amt: number): void => {
      const u = C.blur.uniforms
      if (u.tDiffuse) u.tDiffuse.value = C.rt.texture
      if (u.dir) u.dir.value = [amt / C.size, 0]
      r.setRenderTarget(C.rtb)
      r.clear(true, false, false)
      C.quad.render(r)
      if (u.tDiffuse) u.tDiffuse.value = C.rtb.texture
      if (u.dir) u.dir.value = [0, amt / C.size]
      r.setRenderTarget(C.rt)
      r.clear(true, false, false)
      C.quad.render(r)
    }
    // A halo about 8 mm wide around the footprint, then progressively finer passes to remove banding.
    blur(9)
    blur(4.5)
    blur(2)
    blur(0.8)
    r.setRenderTarget(null)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // Released here, while the renderer is alive; the bake's own release then does nothing.
    if (this.shTarget) this.releaseShTarget(this.shTarget)
    for (const d of [...this.disposables, ...this.zoneDisposables, ...this.excludeDisposables]) d.dispose()
    this.disposables = []
    this.zoneDisposables = []
    this.excludeDisposables = []
    this.envTex?.dispose()
    this.key.shadow.map?.dispose()
  }
}
