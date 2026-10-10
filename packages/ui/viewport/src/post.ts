// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Frame pipeline: an MSAA HDR scene pass with a depth texture, depth-only
// ambient occlusion at half resolution (no second geometry pass, which matters
// with millions of toolpath instances), a selection outline from a mask,
// then one grade pass (Khronos PBR Neutral tone mapping, background, vignette,
// dither, sRGB) and FXAA to the canvas.
import {
  Color,
  CustomBlending,
  DepthTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  MaxEquation,
  Mesh,
  NearestFilter,
  NoBlending,
  OneFactor,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type Material,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
} from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js'
import { gpuDone } from './gpudone'
import { SCENE, hexToRgb, type SceneColors } from './palette'
import type { Quality } from './types'

const QUAD_VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

const AO_FS = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 proj;
uniform mat4 invProj;
uniform vec2 fullTexel;
uniform float radius;
uniform float bias;
uniform float frame;
varying vec2 vUv;

vec3 viewPos(vec2 uv, float d) {
  vec4 v = invProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return v.xyz / v.w;
}
float depthAt(vec2 uv) { return texture2D(tDepth, uv).x; }

void main() {
  float d = depthAt(vUv);
  if (d >= 1.0) { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); return; }
  vec3 P = viewPos(vUv, d);
  // Normal from depth: take the neighbor on the same surface on each axis so
  // silhouettes do not smear into the background.
  vec2 dx = vec2(fullTexel.x, 0.0), dy = vec2(0.0, fullTexel.y);
  vec3 pl = viewPos(vUv - dx, depthAt(vUv - dx)), pr = viewPos(vUv + dx, depthAt(vUv + dx));
  vec3 pd = viewPos(vUv - dy, depthAt(vUv - dy)), pu = viewPos(vUv + dy, depthAt(vUv + dy));
  // On a smooth surface the two one-sided steps agree, so the central difference is used: it does not
  // flip between neighbors as depth quantizes, which showed as bands sweeping across the plate.
  float ex1 = pr.z - P.z, ex0 = P.z - pl.z, ey1 = pu.z - P.z, ey0 = P.z - pd.z;
  float tolx = 0.25 * (abs(ex1) + abs(ex0)) + 0.001 * abs(P.z);
  float toly = 0.25 * (abs(ey1) + abs(ey0)) + 0.001 * abs(P.z);
  vec3 ddx = abs(ex1 - ex0) < tolx ? (pr - pl) * 0.5 : (abs(ex1) < abs(ex0) ? pr - P : P - pl);
  vec3 ddy = abs(ey1 - ey0) < toly ? (pu - pd) * 0.5 : (abs(ey1) < abs(ey0) ? pu - P : P - pd);
  vec3 N = normalize(cross(ddx, ddy));
  if (dot(N, P) > 0.0) N = -N;
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float ang = (ign + frame * 0.618034) * 6.2831853;
  vec3 rv = vec3(cos(ang), sin(ang), 0.37);
  vec3 T = normalize(rv - N * dot(rv, N));
  vec3 B = cross(N, T);
  float occ = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    float fi = (float(i) + 0.5) / float(SAMPLES);
    float r = sqrt(fi);
    float th = float(i) * 2.3999632;
    vec2 dsk = r * vec2(cos(th), sin(th));
    float h = sqrt(max(0.0, 1.0 - r * r));
    float s = radius * mix(0.15, 1.0, fi * fi);
    vec3 S = P + (T * dsk.x + B * dsk.y + N * h) * s;
    vec4 c = proj * vec4(S, 1.0);
    vec2 suv = clamp(c.xy / c.w * 0.5 + 0.5, vec2(0.0), vec2(1.0));
    float sz = viewPos(suv, depthAt(suv)).z;
    float range = smoothstep(0.0, 1.0, radius / abs(P.z - sz));
    occ += (sz >= S.z + bias + 0.002 * abs(P.z) ? 1.0 : 0.0) * range;
  }
  gl_FragColor = vec4(1.0 - occ / float(SAMPLES), -P.z, 0.0, 1.0);
}
`

const BLUR_FS = /* glsl */ `
uniform sampler2D tAO;
uniform vec2 dir;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tAO, vUv);
  float z = c.g;
  if (z <= 0.0) { gl_FragColor = c; return; }
  float W[5];
  W[0] = 0.2270; W[1] = 0.1946; W[2] = 0.1216; W[3] = 0.0541; W[4] = 0.0162;
  float sum = c.r * W[0], wsum = W[0];
  float tol = 0.02 * z + 0.4;
  for (int i = 1; i < 5; i++) {
    vec4 a = texture2D(tAO, vUv + dir * float(i));
    vec4 b = texture2D(tAO, vUv - dir * float(i));
    float wa = a.g > 0.0 ? W[i] * max(0.0, 1.0 - abs(a.g - z) / tol) : 0.0;
    float wb = b.g > 0.0 ? W[i] * max(0.0, 1.0 - abs(b.g - z) / tol) : 0.0;
    sum += a.r * wa + b.r * wb; wsum += wa + wb;
  }
  gl_FragColor = vec4(sum / wsum, z, 0.0, 1.0);
}
`

const MASK_VS = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
void main() {
  #include <begin_vertex>
  #include <project_vertex>
}
`

const MASK_FS = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 invSize;
void main() {
  float sd = texture2D(tDepth, gl_FragCoord.xy * invSize).x;
  float vis = gl_FragCoord.z <= sd + 0.00035 ? 1.0 : 0.0;
  gl_FragColor = vec4(1.0, vis, 0.0, 1.0);
}
`

const GRADE_FS = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tAO;
uniform sampler2D tMask;
uniform float aoOn;
uniform float aoStrength;
uniform float outlineOn;
uniform float exposure;
uniform float aspect;
uniform vec2 texel;
uniform float edgePx;
uniform vec3 bgTop;
uniform vec3 bgBot;
uniform vec3 bgGlow;
uniform vec3 edgeVis;
uniform vec3 edgeHid;
uniform float silOn;
uniform vec3 silColor;
uniform sampler2D tDepth;
uniform vec2 nearFar;
varying vec2 vUv;

// Model's silhouette: where a solid model meets what is behind it. Coverage comes from the color's alpha, which only
// opaque geometry fills, so the ground, its grid and the sky never outline; depth jumps inside the model add the inner
// contours.
float covered(vec2 uv) { return step(0.99, texture2D(tColor, uv).a); }
float viewZ(vec2 uv) {
  float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
  return 2.0 * nearFar.x * nearFar.y / (nearFar.y + nearFar.x - z * (nearFar.y - nearFar.x));
}
float silhouette(vec2 uv) {
  // only the model's own pixels carry the line, so the background and the ground cost one read
  if (covered(uv) < 0.5) return 0.0;
  float z0 = viewZ(uv);
  float k = 0.035 * z0 + 0.5;
  float e = 0.0;
  vec2 d = texel * edgePx * 0.75;
  vec2 o[4];
  o[0] = vec2(d.x, 0.0); o[1] = vec2(-d.x, 0.0); o[2] = vec2(0.0, d.y); o[3] = vec2(0.0, -d.y);
  for (int i = 0; i < 4; i++) {
    vec2 q = uv + o[i];
    if (covered(q) < 0.5) return 1.0;
    if (abs(viewZ(q) - z0) > k) e = 0.85;
  }
  return e;
}

// Khronos PBR Neutral: filament colors stay saturated instead of washing toward white.
vec3 neutral(vec3 color) {
  const float startC = 0.76; const float desat = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float off = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= off;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startC) return color;
  float d = 1.0 - startC;
  float np = 1.0 - d * d / (peak + d - startC);
  color *= np / peak;
  float g = 1.0 - 1.0 / (desat * (peak - np) + 1.0);
  return mix(color, vec3(np), g);
}
vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 tuv = vUv;
  vec4 c = texture2D(tColor, tuv);
  float a = clamp(c.a, 0.0, 1.0);
  vec3 col = max(c.rgb, 0.0);
  if (aoOn > 0.5) col *= mix(1.0, texture2D(tAO, tuv).r, aoStrength);
  col = neutral(col * exposure);
  vec2 q = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.58);
  vec3 bg = mix(bgBot, bgTop, smoothstep(0.0, 1.0, vUv.y));
  bg = mix(bg, bgGlow, (1.0 - smoothstep(0.0, 0.85, length(q))) * 0.8);
  vec3 lin = col + pow(bg, vec3(2.2)) * (1.0 - a);
  if (silOn > 0.5) lin = mix(lin, silColor, silhouette(tuv) * 0.95);
  if (outlineOn > 0.5) {
    float cov = texture2D(tMask, tuv).r;
    float mx = 0.0, vis = 0.0;
    for (int i = 0; i < 8; i++) {
      float an = float(i) * 0.7853982;
      vec2 d = vec2(cos(an), sin(an)) * texel * edgePx;
      vec2 m = max(texture2D(tMask, tuv + d).rg, texture2D(tMask, tuv + d * 0.5).rg);
      mx = max(mx, m.r); vis = max(vis, m.g);
    }
    float e = smoothstep(0.05, 0.55, mx - cov);
    lin = mix(lin, vis > 0.5 ? edgeVis : edgeHid, e);
  }
  vec3 o = toSRGB(lin);
  vec2 v = vUv - 0.5;
  o *= 1.0 - dot(v, v) * 0.42;
  o += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(o, 1.0);
}
`

function srgb01(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex)
  return [r / 255, g / 255, b / 255]
}

function linearColor(hex: string): Color {
  return new Color(hex)
}

export interface FrameOptions {
  ao: boolean
  /** 0 to 1 scale on AO strength, for fading it in when the camera stops. */
  aoMix: number
  /** Draw without MSAA (the camera is moving; FXAA still runs). Still frames use MSAA 4x. */
  fast: boolean
  outline: readonly Object3D[]
  /** Model's CAD look: a near-black silhouette where solid models meet what is behind them. */
  silhouette?: boolean
  /** Increments per frame so AO noise rotates; still frames average it away. */
  frameIndex: number
}

export class Pipeline {
  readonly main: WebGLRenderTarget
  /** Single-sample twin of `main` for frames drawn while the camera moves. */
  private readonly fast: WebGLRenderTarget
  private readonly ao: WebGLRenderTarget
  private readonly aoBlur: WebGLRenderTarget
  private readonly mask: WebGLRenderTarget
  private readonly ldr: WebGLRenderTarget
  /** `ldr` twin at the moving-frame scale. */
  private readonly ldrFast: WebGLRenderTarget
  private readonly aoMat: ShaderMaterial
  private readonly blurMat: ShaderMaterial
  private readonly maskMat: ShaderMaterial
  private readonly gradeMat: ShaderMaterial
  private readonly fxaaMat: ShaderMaterial
  private readonly quad = new FullScreenQuad()
  private width = 1
  private height = 1
  private pixelRatio = 1
  private scale = 1
  aoRadius = 6
  aoStrength = 0.9
  exposure = 1

  /** Background gradient and selection outline colors. */
  /** The silhouette's color, a CSS hex (linear in the shader). */
  setSilhouetteColor(hex: string): void {
    const u = this.gradeMat.uniforms.silColor
    if (u) u.value = linearColor(hex)
  }

  setSceneColors(scene: SceneColors): void {
    const u = this.gradeMat.uniforms
    if (u.bgTop) u.bgTop.value = srgb01(scene.bgTop)
    if (u.bgBot) u.bgBot.value = srgb01(scene.bgBottom)
    if (u.bgGlow) u.bgGlow.value = srgb01(scene.bgGlow)
    if (u.edgeVis) u.edgeVis.value = linearColor(scene.selection)
    if (u.edgeHid) u.edgeHid.value = linearColor(scene.selectionHidden)
  }

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly quality: Quality,
  ) {
    const depthTexture = new DepthTexture(1, 1, FloatType)
    this.main = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      samples: quality === 'low' ? 0 : 4,
      depthTexture,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    })
    const fastDepth = new DepthTexture(1, 1, FloatType)
    fastDepth.minFilter = fastDepth.magFilter = NearestFilter
    this.fast = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 0, depthTexture: fastDepth, minFilter: LinearFilter, magFilter: LinearFilter })
    const aoOpts = { type: HalfFloatType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter }
    this.ao = new WebGLRenderTarget(1, 1, aoOpts)
    this.aoBlur = new WebGLRenderTarget(1, 1, aoOpts)
    this.mask = new WebGLRenderTarget(1, 1, { type: UnsignedByteType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter })
    this.ldr = new WebGLRenderTarget(1, 1, { type: UnsignedByteType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter })
    this.ldrFast = new WebGLRenderTarget(1, 1, { type: UnsignedByteType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter })

    this.aoMat = new ShaderMaterial({
      defines: { SAMPLES: quality === 'high' ? 12 : 8 },
      uniforms: {
        tDepth: { value: depthTexture },
        proj: { value: null },
        invProj: { value: null },
        fullTexel: { value: new Vector2() },
        radius: { value: this.aoRadius },
        bias: { value: 0.05 },
        frame: { value: 0 },
      },
      vertexShader: QUAD_VS,
      fragmentShader: AO_FS,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    })
    this.blurMat = new ShaderMaterial({
      uniforms: { tAO: { value: null }, dir: { value: new Vector2() } },
      vertexShader: QUAD_VS,
      fragmentShader: BLUR_FS,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    })
    this.maskMat = new ShaderMaterial({
      uniforms: { tDepth: { value: depthTexture }, invSize: { value: new Vector2() } },
      vertexShader: MASK_VS,
      fragmentShader: MASK_FS,
      depthTest: false,
      depthWrite: false,
      blending: CustomBlending,
      blendEquation: MaxEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
    })
    const [tr, tg, tb] = srgb01(SCENE.bgTop)
    const [br, bgc, bb] = srgb01(SCENE.bgBottom)
    const [gr, gg, gb] = srgb01(SCENE.bgGlow)
    this.gradeMat = new ShaderMaterial({
      uniforms: {
        tColor: { value: this.main.texture },
        tAO: { value: this.ao.texture },
        tMask: { value: this.mask.texture },
        aoOn: { value: 0 },
        aoStrength: { value: this.aoStrength },
        outlineOn: { value: 0 },
        exposure: { value: this.exposure },
        aspect: { value: 1 },
        texel: { value: new Vector2() },
        edgePx: { value: 1.5 },
        bgTop: { value: [tr, tg, tb] },
        bgBot: { value: [br, bgc, bb] },
        bgGlow: { value: [gr, gg, gb] },
        edgeVis: { value: linearColor(SCENE.selection) },
        edgeHid: { value: linearColor(SCENE.selectionHidden) },
        silOn: { value: 0 },
        silColor: { value: new Color(0, 0, 0) },
        tDepth: { value: depthTexture },
        nearFar: { value: new Vector2(1, 1000) },
      },
      vertexShader: QUAD_VS,
      fragmentShader: GRADE_FS,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    })
    this.fxaaMat = new ShaderMaterial({
      uniforms: { tDiffuse: { value: this.ldr.texture }, resolution: { value: new Vector2() } },
      vertexShader: FXAAShader.vertexShader,
      fragmentShader: FXAAShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    })
    this.mask.texture.minFilter = LinearFilter
    this.ao.texture.magFilter = LinearFilter
    depthTexture.minFilter = NearestFilter
    depthTexture.magFilter = NearestFilter
  }

  private readonly probe = new WebGLRenderTarget(1, 1, { depthBuffer: false })
  private readonly probePx = new Uint8Array(4)

  /**
   * Waits until the GPU has finished every command issued so far. It clears and reads a 1x1
   * target queued after the frame; reading the canvas itself would also wait for the display.
   */
  waitForGpu(): void {
    const r = this.renderer
    const prev = r.getRenderTarget()
    r.setRenderTarget(this.probe)
    r.clear(true, false, false)
    r.readRenderTargetPixels(this.probe, 0, 0, 1, 1, this.probePx)
    r.setRenderTarget(prev)
  }

  /** When the GPU has finished every command issued so far, without stalling the page (gpudone.ts). */
  gpuDone(): Promise<number> {
    return gpuDone(this.renderer.getContext(), () => this.waitForGpu())
  }

  get fxaa(): boolean {
    return this.quality !== 'low'
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    const w = Math.max(1, Math.round(width * pixelRatio))
    const h = Math.max(1, Math.round(height * pixelRatio))
    this.width = w
    this.height = h
    this.pixelRatio = pixelRatio
    this.main.setSize(w, h)
    this.resizeFast()
    const aw = Math.max(1, Math.round(w / 2))
    const ah = Math.max(1, Math.round(h / 2))
    this.ao.setSize(aw, ah)
    this.aoBlur.setSize(aw, ah)
    this.mask.setSize(w, h)
    this.ldr.setSize(w, h)
    ;(this.aoMat.uniforms.fullTexel?.value as Vector2).set(1 / w, 1 / h)
    ;(this.maskMat.uniforms.invSize?.value as Vector2).set(1 / w, 1 / h)
    const g = this.gradeMat.uniforms
    if (g.aspect) g.aspect.value = width / Math.max(1, height)
    ;(g.texel?.value as Vector2).set(1 / w, 1 / h)
    if (g.edgePx) g.edgePx.value = 2 * pixelRatio
  }

  private resizeFast(): void {
    const w = Math.max(1, Math.round(this.width * this.scale))
    const h = Math.max(1, Math.round(this.height * this.scale))
    this.fast.setSize(w, h)
    this.ldrFast.setSize(w, h)
  }

  /** Resolution of moving frames as a fraction of the still frame (1 = same). The final pass upsamples them to the canvas. */
  get motionScale(): number {
    return this.scale
  }

  set motionScale(k: number) {
    const v = Math.min(1, Math.max(0.25, Math.round(k * 20) / 20))
    if (v === this.scale) return
    this.scale = v
    this.resizeFast()
  }

  render(scene: Scene, camera: PerspectiveCamera, opts: FrameOptions): void {
    const r = this.renderer
    const target = opts.fast ? this.fast : this.main
    if (this.aoMat.uniforms.tDepth) this.aoMat.uniforms.tDepth.value = target.depthTexture
    if (this.maskMat.uniforms.tDepth) this.maskMat.uniforms.tDepth.value = target.depthTexture
    if (this.gradeMat.uniforms.tColor) this.gradeMat.uniforms.tColor.value = target.texture
    const gu = this.gradeMat.uniforms
    if (gu.tDepth) gu.tDepth.value = target.depthTexture
    if (gu.silOn) gu.silOn.value = opts.silhouette ? 1 : 0
    if (gu.nearFar) (gu.nearFar.value as Vector2).set(camera.near, camera.far)
    r.setRenderTarget(target)
    r.setClearColor(0x000000, 0)
    r.clear(true, true, true)
    r.render(scene, camera)

    const g = this.gradeMat.uniforms
    const ao = opts.ao
    if (ao) {
      const u = this.aoMat.uniforms
      if (u.proj) u.proj.value = camera.projectionMatrix
      if (u.invProj) u.invProj.value = camera.projectionMatrixInverse
      if (u.radius) u.radius.value = this.aoRadius
      if (u.frame) u.frame.value = 0
      this.pass(this.aoMat, this.ao)
      const b = this.blurMat.uniforms
      if (b.tAO) b.tAO.value = this.ao.texture
      ;(b.dir?.value as Vector2).set(1 / this.ao.width, 0)
      this.pass(this.blurMat, this.aoBlur)
      if (b.tAO) b.tAO.value = this.aoBlur.texture
      ;(b.dir?.value as Vector2).set(0, 1 / this.ao.height)
      this.pass(this.blurMat, this.ao)
    }
    if (g.aoOn) g.aoOn.value = ao ? 1 : 0
    if (g.aoStrength) g.aoStrength.value = this.aoStrength * opts.aoMix
    if (g.exposure) g.exposure.value = this.exposure

    const outline = opts.outline.length > 0
    if (outline) this.renderMask(opts.outline, camera)
    if (g.outlineOn) g.outlineOn.value = outline ? 1 : 0

    if (this.fxaa) {
      const ldr = opts.fast ? this.ldrFast : this.ldr
      const gu = g.texel?.value as Vector2
      gu.set(1 / ldr.width, 1 / ldr.height)
      if (g.edgePx) g.edgePx.value = 2 * this.pixelRatio * (ldr.width / this.width)
      ;(this.fxaaMat.uniforms.resolution?.value as Vector2).set(1 / ldr.width, 1 / ldr.height)
      if (this.fxaaMat.uniforms.tDiffuse) this.fxaaMat.uniforms.tDiffuse.value = ldr.texture
      this.pass(this.gradeMat, ldr)
      this.pass(this.fxaaMat, null)
    } else {
      this.pass(this.gradeMat, null)
    }
  }

  private pass(mat: Material, target: WebGLRenderTarget | null): void {
    this.quad.material = mat
    this.renderer.setRenderTarget(target)
    this.quad.render(this.renderer)
  }

  private renderMask(objects: readonly Object3D[], camera: Camera): void {
    const r = this.renderer
    r.setRenderTarget(this.mask)
    r.setClearColor(0x000000, 0)
    r.clear(true, false, false)
    const swapped: { mesh: Mesh; mat: Material | Material[] }[] = []
    const hidden: Object3D[] = []
    for (const root of objects) {
      root.traverse((o) => {
        // wide edge quads (LineSegments2) are meshes to three.js but lines here: hidden from the mask like the thin ones
        const wide = (o as { isLineSegments2?: boolean }).isLineSegments2 === true
        if ((o as Mesh).isMesh && o.visible && !wide) {
          const m = o as Mesh
          swapped.push({ mesh: m, mat: m.material })
          m.material = this.maskMat
        } else if (o !== root && o.visible && (wide || (!(o as Mesh).isMesh && (o.type === 'LineSegments' || o.type === 'Line')))) {
          hidden.push(o)
          o.visible = false
        }
      })
    }
    const prevAuto = r.shadowMap.autoUpdate
    r.shadowMap.autoUpdate = false
    for (const root of objects) r.render(root, camera)
    r.shadowMap.autoUpdate = prevAuto
    for (const s of swapped) s.mesh.material = s.mat
    for (const h of hidden) h.visible = true
  }

  dispose(): void {
    this.main.depthTexture?.dispose()
    this.main.dispose()
    this.fast.depthTexture?.dispose()
    this.fast.dispose()

    this.ao.dispose()
    this.aoBlur.dispose()
    this.mask.dispose()
    this.ldr.dispose()
    this.ldrFast.dispose()
    this.aoMat.dispose()
    this.blurMat.dispose()
    this.maskMat.dispose()
    this.gradeMat.dispose()
    this.fxaaMat.dispose()
    this.quad.dispose()
    this.probe.dispose()
  }

  get size(): { width: number; height: number; pixelRatio: number } {
    return { width: this.width, height: this.height, pixelRatio: this.pixelRatio }
  }
}
