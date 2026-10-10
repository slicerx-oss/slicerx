// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Prepare materials: per-filament physical materials, clay, overhang heat map,
// X-ray and flat filament colors, plus the "print look" layer-groove shading
// ported from the concept renderer (LAYER_GLSL).
import {
  Color,
  CustomBlending,
  DataTexture,
  DoubleSide,
  FloatType,
  LineBasicMaterial,
  Material,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NearestFilter,
  OneFactor,
  RedFormat,
  ShaderMaterial,
  SrcAlphaFactor,
  ZeroFactor,
  type WebGLProgramParametersWithUniforms,
} from 'three'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { HEAT_RAMP, SCENE, displayHex, type SceneColors } from './palette'
import type { DisplayStyle, FilamentFinish, RenderMode } from './types'

/** Uniforms shared by every Prepare material, so one write updates all of them. */
export const shared = {
  layerH: { value: 0.2 },
  gmin: { value: 4 },
  lines: { value: 1 },
  overhangDeg: { value: 55 },
  /** sleipnir: layer tops as a texture (4096 per row), their count, and the heat band settings. */
  tops: { value: new DataTexture(new Float32Array(1), 1, 1, RedFormat, FloatType) },
  topsN: { value: 0 },
  band: { value: 0 },
  bandRange: { value: [0.1, 0.3] as [number, number] },
  bandThin: { value: new Color(HEAT_RAMP[0]) },
  bandMid: { value: new Color(HEAT_RAMP[2]) },
  bandThick: { value: new Color(HEAT_RAMP[3]) },
  red: { value: new Color(SCENE.overhangRed) },
  amber: { value: new Color(SCENE.overhangAmber) },
}

/*
 * Print look: FDM layer grooves. The line width follows fwidth, and when one
 * layer is thinner than a few pixels the groove period steps up by octaves of
 * the layer height, crossfaded, so the lines always read and never alias into
 * moire. Valleys get a cavity darkening so they hold light like real beads.
 */
const LAYER_LOOKUP = /* glsl */ `
uniform sampler2D uTops;
uniform float uTopsN;
uniform float uBand;
uniform vec2 uBandRange;
uniform vec3 uBandThin;
uniform vec3 uBandMid;
uniform vec3 uBandThick;
float sxTop(int i) { return texelFetch(uTops, ivec2(i % 4096, i / 4096), 0).r; }
// Layer index plus the fraction through the layer at height z (x), and that layer's thickness in mm (y).
vec2 sxLayerAt(float z) {
  int lo = 0;
  int hi = int(uTopsN) - 1;
  for (int i = 0; i < 15; i++) {
    if (lo >= hi) break;
    int mid = (lo + hi) / 2;
    if (sxTop(mid) < z) lo = mid + 1; else hi = mid;
  }
  float t1 = sxTop(lo);
  float t0 = lo > 0 ? sxTop(lo - 1) : 0.0;
  float th = max(t1 - t0, 1e-4);
  return vec2(float(lo) + clamp((z - t0) / th, 0.0, 1.0), t1 - t0);
}
`

const GROOVE_PRE = /* glsl */ `
float sxTilt = 0.0;
{
  // With sleipnir heights the groove phase follows the real layer coordinate, scaled to uLayerH units.
  vec2 sxL = uTopsN > 0.5 ? sxLayerAt(vSxW.y) : vec2(0.0);
  float sxY = uTopsN > 0.5 ? sxL.x * uLayerH : vSxW.y;
  if (uTopsN > 0.5 && uBand > 0.001) {
    float k = clamp((sxL.y - uBandRange.x) / max(1e-4, uBandRange.y - uBandRange.x), 0.0, 1.0);
    vec3 heat = k < 0.5 ? mix(uBandThin, uBandMid, k * 2.0) : mix(uBandMid, uBandThick, k * 2.0 - 1.0);
    diffuseColor.rgb = mix(diffuseColor.rgb, heat, uBand);
  }
  float px = max(fwidth(sxY), 1e-5);
  float L = max(0.0, log2(uGMin * px / uLayerH));
  float o = floor(L), f = fract(L);
  float cav = 0.0, tilt = 0.0;
  for (int k = 0; k < 2; k++) {
    float per = uLayerH * exp2(o + float(k));
    float ph = fract(sxY / per);
    float w = clamp(px / per * 1.5, 0.02, 0.5);
    float edge = smoothstep(0.0, w, ph) * smoothstep(0.0, w, 1.0 - ph);
    float t = (ph - 0.5) * 2.0 * edge;
    float c = 1.0 - smoothstep(0.0, 0.5, min(ph, 1.0 - ph) + w * 0.5);
    float wt = k == 0 ? 1.0 - f : f;
    tilt += t * wt; cav += c * wt;
  }
  float far = 1.0 - smoothstep(4.0, 6.5, L);
  float amp = uLines * far / (1.0 + 0.18 * o);
  vec3 nW = normalize(cross(dFdx(vSxW), dFdy(vSxW)));
  float side = 1.0 - abs(nW.y); side *= side;
  sxTilt = tilt * amp * side;
  diffuseColor.rgb *= 1.0 - cav * 0.42 * amp * side;
}
`

const GROOVE_NORMAL = /* glsl */ `
{
  vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  normal = normalize(normal + upV * sxTilt * 0.95);
}
`

function addWorldPos(sh: WebGLProgramParametersWithUniforms): void {
  sh.vertexShader = 'varying vec3 vSxW;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n\tvSxW = (modelMatrix * vec4(transformed, 1.0)).xyz;')
  sh.fragmentShader = 'varying vec3 vSxW;\n' + sh.fragmentShader
}

function withLayerLines<M extends Material>(m: M, key: string): M {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLayerH = shared.layerH
    sh.uniforms.uLines = shared.lines
    sh.uniforms.uGMin = shared.gmin
    sh.uniforms.uTops = shared.tops
    sh.uniforms.uTopsN = shared.topsN
    sh.uniforms.uBand = shared.band
    sh.uniforms.uBandRange = shared.bandRange
    sh.uniforms.uBandThin = shared.bandThin
    sh.uniforms.uBandMid = shared.bandMid
    sh.uniforms.uBandThick = shared.bandThick
    addWorldPos(sh)
    sh.fragmentShader =
      'uniform float uLayerH;\nuniform float uLines;\nuniform float uGMin;\n' +
      LAYER_LOOKUP +
      sh.fragmentShader
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + GROOVE_PRE)
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + GROOVE_NORMAL)
  }
  m.customProgramCacheKey = () => 'sx-layer-' + key
  return m
}

/** Adds color but leaves destination alpha alone, so the grade pass still sees the background as empty. */
const ADDITIVE_KEEP_ALPHA = { blending: CustomBlending, blendSrc: OneFactor, blendDst: OneFactor, blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor } as const

function lin(hex: string): Color {
  return new Color(hex)
}

export function studioMaterial(color: string, finish: FilamentFinish): MeshPhysicalMaterial {
  const c = lin(displayHex(color))
  const white = new Color(1, 1, 1)
  // Plastics reflect little and softly, and the room's reflection stays weak, so a face never takes on another hue.
  // Silk keeps its sheen, its reflection tinted by the filament.
  const base = {
    color: c,
    polygonOffset: true,
    sheenColor: c.clone().lerp(white, 0.45),
  }
  let m: MeshPhysicalMaterial
  switch (finish) {
    case 'silk':
      m = new MeshPhysicalMaterial({ ...base, roughness: 0.26, metalness: 0.28, specularColor: c.clone().lerp(white, 0.3), clearcoat: 1, clearcoatRoughness: 0.07, sheen: 0.9, sheenRoughness: 0.3, envMapIntensity: 1.1 })
      break
    case 'matte':
      m = new MeshPhysicalMaterial({ ...base, roughness: 0.82, metalness: 0, specularIntensity: 0.5, clearcoat: 0, sheen: 0.35, sheenRoughness: 0.7, envMapIntensity: 0.55 })
      break
    case 'petg':
      m = new MeshPhysicalMaterial({ ...base, roughness: 0.6, metalness: 0, specularIntensity: 0.7, clearcoat: 0.45, clearcoatRoughness: 0.2, sheen: 0.2, sheenRoughness: 0.4, envMapIntensity: 0.65 })
      break
    case 'translucent':
      m = new MeshPhysicalMaterial({ ...base, roughness: 0.28, metalness: 0, transmission: 0.55, thickness: 6, ior: 1.5, attenuationColor: c, attenuationDistance: 12, clearcoat: 0.3, clearcoatRoughness: 0.2, envMapIntensity: 0.8 })
      break
    default:
      m = new MeshPhysicalMaterial({ ...base, roughness: 0.65, metalness: 0, specularIntensity: 0.6, clearcoat: 0.08, clearcoatRoughness: 0.5, sheen: 0.3, sheenRoughness: 0.55, envMapIntensity: 0.6 })
  }
  return withLayerLines(m, 'studio')
}

export function filamentMaterial(color: string): MeshStandardMaterial {
  const c = lin(displayHex(color))
  return new MeshStandardMaterial({ color: c, roughness: 0.92, metalness: 0, envMapIntensity: 0.55, emissive: c.clone().multiplyScalar(0.22), polygonOffset: true })
}

let xrayTint: string = SCENE.xrayTint

export function xrayMaterial(color: string): ShaderMaterial {
  const c = lin(displayHex(color)).lerp(lin(xrayTint), 0.35)
  return new ShaderMaterial({
    uniforms: { col: { value: c } },
    vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform vec3 col; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.4); gl_FragColor = vec4(col * (0.035 + f * 0.95), 1.0); }',
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    ...ADDITIVE_KEEP_ALPHA,
  })
}

/** The CAD look's edge width, in CSS pixels. */
export const CAD_EDGE_PX = 1.5

let sharedMats: { clay: MeshStandardMaterial; overhang: MeshStandardMaterial; edgeDark: LineBasicMaterial; edgeXray: LineBasicMaterial; cad: MeshPhysicalMaterial; edgeCad: LineBasicMaterial; edgeCadWide: LineMaterial } | null = null

/** Pulls line vertices a hair toward the camera so feature edges win the depth test against their own faces. */
function edgeBias<M extends Material>(m: M): M {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n\tmvPosition.xyz *= 0.99935;\n\tgl_Position = projectionMatrix * mvPosition;')
  }
  m.customProgramCacheKey = () => 'sx-edge'
  return m
}

export function sharedMaterials(): NonNullable<typeof sharedMats> {
  if (sharedMats) return sharedMats
  const clay = withLayerLines(new MeshStandardMaterial({ color: lin(SCENE.clay), roughness: 0.74, metalness: 0, envMapIntensity: 0.85, polygonOffset: true }), 'clay')
  const overhang = new MeshStandardMaterial({ color: lin(SCENE.overhangBase), roughness: 0.7, metalness: 0, flatShading: true, envMapIntensity: 0.8, polygonOffset: true })
  overhang.onBeforeCompile = (sh) => {
    sh.uniforms.uTh = shared.overhangDeg
    sh.uniforms.uRed = shared.red
    sh.uniforms.uAmber = shared.amber
    addWorldPos(sh)
    sh.fragmentShader =
      'uniform float uTh;\nuniform vec3 uRed;\nuniform vec3 uAmber;\n' +
      sh.fragmentShader.replace(
        '#include <color_fragment>',
        [
          '#include <color_fragment>',
          'vec3 fnw = normalize(cross(dFdx(vSxW), dFdy(vSxW)));',
          'float ang = degrees(asin(clamp(-fnw.y, 0.0, 1.0)));',
          'if (vSxW.y > 0.45) { if (ang > uTh) diffuseColor.rgb = uRed; else if (ang > uTh - 15.0) diffuseColor.rgb = uAmber; }',
        ].join('\n'),
      )
  }
  overhang.customProgramCacheKey = () => 'sx-over'
  const edgeDark = edgeBias(new LineBasicMaterial({ color: lin(SCENE.edgeDark), transparent: true, opacity: 0.22, depthWrite: false }))
  const edgeXray = edgeBias(new LineBasicMaterial({ color: lin(SCENE.edgeXray), transparent: true, opacity: 0.5, depthWrite: false, ...ADDITIVE_KEEP_ALPHA, blendSrc: SrcAlphaFactor }))
  // Model's CAD look: a mid gray (the studio's key light lifts it to a light gray) with a soft sheen so faces part by
  // their light, and edges dark enough to draw the shape
  const look = cadLook(SCENE.bgTop)
  const cad = new MeshPhysicalMaterial({ color: lin(look.body), roughness: 0.5, metalness: 0, clearcoat: 0.2, clearcoatRoughness: 0.35, envMapIntensity: 0.6, polygonOffset: true })
  const edgeCad = edgeBias(new LineBasicMaterial({ color: lin(look.edge), transparent: true, opacity: 0.9, depthWrite: false }))
  // the CAD look's edges as screen-space quads, so they keep a 1.5 px width (GL lines draw at 1 px)
  const edgeCadWide = new LineMaterial({ color: lin(look.edge).getHex(), linewidth: CAD_EDGE_PX, transparent: true, opacity: 0.95, depthWrite: false })
  edgeCadWide.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('gl_Position = clip;', 'clip.z -= 0.0006 * clip.w;\n\t\t\tgl_Position = clip;')
  }
  edgeCadWide.customProgramCacheKey = () => 'sx-edge-wide'
  sharedMats = { clay, overhang, edgeDark, edgeXray, cad, edgeCad, edgeCadWide }
  return sharedMats
}

export interface PartLook {
  color: string
  finish: FilamentFinish
}

/** Caches one material per (mode, color, finish) so switching modes never recompiles. */
export class MaterialCache {
  private readonly map = new Map<string, Material>()

  get(mode: RenderMode, look: PartLook): Material {
    const s = sharedMaterials()
    if (mode === 'clay') return s.clay
    if (mode === 'overhang') return s.overhang
    if (mode === 'cad') return s.cad
    const key = `${mode}:${look.color}:${look.finish}`
    let m = this.map.get(key)
    if (!m) {
      m = mode === 'xray' ? xrayMaterial(look.color) : mode === 'filament' ? filamentMaterial(look.color) : studioMaterial(look.color, look.finish)
      this.map.set(key, m)
    }
    return m
  }

  dispose(): void {
    for (const m of this.map.values()) m.dispose()
    this.map.clear()
  }
}

/**
 * Applies scene colors to the materials every viewport on the page shares
 * (clay, overhang heat map, edges). Cached per-color materials are dropped by
 * MaterialCache.dispose(), so call that too when the x-ray tint changes.
 */
export function setSharedSceneColors(scene: SceneColors): void {
  shared.red.value.set(scene.overhangRed)
  shared.amber.value.set(scene.overhangAmber)
  xrayTint = scene.xrayTint
  if (!sharedMats) return
  sharedMats.clay.color.copy(lin(scene.clay))
  sharedMats.overhang.color.copy(lin(scene.overhangBase))
  sharedMats.edgeDark.color.copy(lin(scene.edgeDark))
  sharedMats.edgeXray.color.copy(lin(scene.edgeXray))
  const look = cadLook(scene.bgTop)
  sharedMats.cad.color.copy(lin(look.body))
  sharedMats.edgeCad.color.copy(lin(look.edge))
  sharedMats.edgeCadWide.color.copy(lin(look.edge))
}

/** The drawing buffer size, for the wide edge material's pixel widths. */
export function setEdgeResolution(width: number, height: number): void {
  sharedMaterials().edgeCadWide.resolution.set(width, height)
}

/** Which edge material a part's feature edges take in a render mode, and whether they show with this display style. */
export function edgeLook(mode: RenderMode, display: DisplayStyle): { edge: 'xray' | 'cad' | 'dark'; visible: boolean } {
  if (mode === 'xray') return { edge: 'xray', visible: true }
  // Model's CAD look always draws the feature edges; wireframe is its own drawing
  if (mode === 'cad') return { edge: 'cad', visible: display !== 'wireframe' }
  return { edge: 'dark', visible: display === 'edges' }
}

/** The CAD gray for a studio: neutral in a light one, a little cooler in a dark one, and its edge color. */
export function cadLook(bgTop: string): { body: string; edge: string } {
  const c = new Color(bgTop)
  const light = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b > 0.5
  return light ? { body: '#7b7e83', edge: '#121318' } : { body: '#6f757e', edge: '#08090c' }
}

/** sleipnir heights for the Prepare shaders. Null clears them. Shared by every viewport on the page. */
export function setSharedLayerTops(tops: ArrayLike<number> | null, band: boolean): void {
  const old = shared.tops.value
  if (!tops || tops.length === 0) {
    shared.topsN.value = 0
    shared.band.value = 0
    return
  }
  const n = Math.min(tops.length, 4096 * 8)
  const rows = Math.ceil(n / 4096)
  const data = new Float32Array(4096 * rows)
  let mn = Infinity
  let mx = 0
  let prev = 0
  for (let i = 0; i < n; i++) {
    const t = tops[i] ?? 0
    data[i] = t
    mn = Math.min(mn, t - prev)
    mx = Math.max(mx, t - prev)
    prev = t
  }
  const tex = new DataTexture(data, 4096, rows, RedFormat, FloatType)
  tex.minFilter = tex.magFilter = NearestFilter
  tex.needsUpdate = true
  shared.tops.value = tex
  old.dispose()
  shared.topsN.value = n
  // Keep a visible span even when every layer is the same thickness.
  shared.bandRange.value = mx - mn < 0.01 ? [Math.max(0, mn - 0.05), mx + 0.05] : [mn, mx]
  shared.band.value = band ? 0.55 : 0
}

/** Colors of the thin, middle and thick ends of the heat band. */
export function setSharedBandColors(thin: string, mid: string, thick: string): void {
  shared.bandThin.value.set(thin)
  shared.bandMid.value.set(mid)
  shared.bandThick.value.set(thick)
}
