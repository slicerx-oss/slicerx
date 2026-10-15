// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Candidate viewport looks for the look lab (look.html): each is a parameter set on the existing pipeline (light rig,
// exposure and tone curve, material response, ambient occlusion, edges, background, contact shadow). The lab reaches
// into the viewport's stage and pipeline at runtime, so nothing here changes the shipped viewport.
//
// Look D follows the shading of SolidCraft (https://github.com/bherbruck/solidcraft, MIT OR Apache-2.0, viewport.wgsl
// at cccbe125): a key light that rides with the camera, a head-on fill, a high ambient floor, a soft narrow highlight
// and no tone curve, so a face's brightness says which way it points and nothing clips. Ideas only, no code taken.
import { Color, HemisphereLight, MeshPhysicalMaterial, Vector3, type Camera, type DirectionalLight, type Material, type Scene, type ShaderMaterial } from 'three'
import { sharedMaterials } from '../src/materials'

export type LookId = 'current' | 'A' | 'B' | 'C' | 'D'
export type Studio = 'dark' | 'light'
export type Tone = 'neutral' | 'clamp' | 'aces'

/** A light's direction: world (x right, y up, z toward the bed front) or camera (x right, y up, z toward the viewer). */
interface LightSpec {
  /** Intensity in the viewport's units (times pi, as stage.ts sets them). */
  k: number
  dir: [number, number, number]
}

export interface Look {
  id: LookId
  name: string
  /** One line for the picks page on what changed. */
  line: string
  /** Lights ride with the camera (CAD style) instead of standing in the room. */
  rig: 'world' | 'camera'
  key: LightSpec
  fill: LightSpec
  rim: LightSpec
  /** Sky and ground ambient, in the viewport's units; 0 leaves it off. */
  hemi: { k: number; sky: string; ground: string }
  /** Scales the room environment's light on every material. */
  env: number
  keyShadow: boolean
  exposure: number
  tone: Tone
  /** Overrides for the filament (Slice) materials. */
  filament: { roughness: number; specular: number; clearcoat: number; sheen: number }
  /** Model's CAD material. */
  cad: { light: string; dark: string; roughness: number; specular: number; clearcoat: number }
  ao: { radius: number; strength: number }
  /** Model's feature edges and silhouette. */
  edges: { px: number; opacity: number; light: string; dark: string; silhouette: number }
  /** Background per studio; null keeps the theme's. glow is the center lift, vignette the corner falloff. */
  bg: Record<Studio, { top: string; bottom: string; glow: string } | null>
  glow: number
  vignette: number
  contact: { darkness: number; opacity: number }
}

const CURRENT: Look = {
  id: 'current',
  name: 'Current',
  line: 'What ships today.',
  rig: 'world',
  key: { k: 1.6, dir: [-150, 300, 190] },
  fill: { k: 0.35, dir: [220, 80, 200] },
  rim: { k: 0.5, dir: [180, 140, -260] },
  hemi: { k: 0, sky: '#ffffff', ground: '#ffffff' },
  env: 1,
  keyShadow: true,
  exposure: 1,
  tone: 'neutral',
  filament: { roughness: 0.65, specular: 0.6, clearcoat: 0.08, sheen: 0.3 },
  cad: { light: '#7b7e83', dark: '#6f757e', roughness: 0.5, specular: 1, clearcoat: 0.2 },
  ao: { radius: 6, strength: 0.9 },
  edges: { px: 1.5, opacity: 0.95, light: '#121318', dark: '#08090c', silhouette: 0.95 },
  bg: { dark: null, light: null },
  glow: 0.8,
  vignette: 0.42,
  contact: { darkness: 2.1, opacity: 0.95 },
}

export const LOOKS: Record<LookId, Look> = {
  current: CURRENT,
  A: {
    ...CURRENT,
    id: 'A',
    name: 'A. SolidWorks',
    line: 'Light gray to blue-gray backdrop, lights ride with the camera, crisp dark edges, a soft highlight, light shadow.',
    rig: 'camera',
    key: { k: 0.55, dir: [-0.45, 0.6, 0.66] },
    fill: { k: 0.15, dir: [0.5, -0.1, 0.86] },
    rim: { k: 0.3, dir: [0.2, 0.75, -0.62] },
    hemi: { k: 0.12, sky: '#ffffff', ground: '#8a8f99' },
    env: 0.12,
    keyShadow: false,
    exposure: 1,
    tone: 'neutral',
    filament: { roughness: 0.42, specular: 0.55, clearcoat: 0, sheen: 0.15 },
    cad: { light: '#bcc0c7', dark: '#aeb3bb', roughness: 0.38, specular: 0.6, clearcoat: 0 },
    ao: { radius: 5, strength: 0.55 },
    edges: { px: 1.25, opacity: 1, light: '#14161a', dark: '#0a0b0e', silhouette: 1 },
    bg: { light: { top: '#fbfcfd', bottom: '#bcc6d3', glow: '#ffffff' }, dark: { top: '#3a3f4b', bottom: '#1f232b', glow: '#454b58' } },
    glow: 0.25,
    vignette: 0,
    contact: { darkness: 1.4, opacity: 0.6 },
  },
  B: {
    ...CURRENT,
    id: 'B',
    name: 'B. Fusion',
    line: 'Studio gray backdrop, a high key that stays in the room, stronger and wider occlusion, softer gray edges, real shadows.',
    rig: 'world',
    key: { k: 0.6, dir: [-120, 320, 140] },
    fill: { k: 0.12, dir: [240, 60, 180] },
    rim: { k: 0.25, dir: [120, 160, -260] },
    hemi: { k: 0.12, sky: '#ffffff', ground: '#6d7078' },
    env: 0.22,
    keyShadow: true,
    exposure: 1,
    tone: 'neutral',
    filament: { roughness: 0.58, specular: 0.45, clearcoat: 0, sheen: 0.2 },
    cad: { light: '#b4b7bc', dark: '#a7abb1', roughness: 0.55, specular: 0.45, clearcoat: 0 },
    ao: { radius: 11, strength: 1 },
    edges: { px: 1, opacity: 0.55, light: '#2a2c31', dark: '#101114', silhouette: 0.6 },
    bg: { light: { top: '#e9eaec', bottom: '#b7babf', glow: '#f2f3f4' }, dark: { top: '#45474c', bottom: '#2a2b2f', glow: '#4d4f55' } },
    glow: 0.35,
    vignette: 0.2,
    contact: { darkness: 2.4, opacity: 0.9 },
  },
  C: {
    ...CURRENT,
    id: 'C',
    name: 'C. Current, fixed',
    line: 'Same palette and backdrop; the light budget cut to about half so whites stop clipping, a real key, fill and rim.',
    rig: 'world',
    key: { k: 0.62, dir: [-170, 260, 120] },
    fill: { k: 0.14, dir: [240, 40, 220] },
    rim: { k: 0.45, dir: [140, 180, -280] },
    hemi: { k: 0.1, sky: '#ffffff', ground: '#5a5e70' },
    env: 0.15,
    keyShadow: true,
    exposure: 1,
    tone: 'neutral',
    filament: { roughness: 0.55, specular: 0.55, clearcoat: 0.05, sheen: 0.2 },
    cad: { light: '#adb2b9', dark: '#a3a9b2', roughness: 0.45, specular: 0.7, clearcoat: 0.1 },
    ao: { radius: 7, strength: 0.9 },
  },
  D: {
    ...CURRENT,
    id: 'D',
    name: 'D. SolidCraft',
    line: 'SolidCraft shading: key and fill ride with the camera, high ambient floor, narrow highlight, no tone curve; our AO and contact shadow kept.',
    rig: 'camera',
    // SolidCraft's key sits up and to the left of the view direction, its fill is a headlight
    key: { k: 0.58, dir: [-0.3, 0.55, 0.78] },
    fill: { k: 0.12, dir: [0, 0, 1] },
    // not in SolidCraft: a faint rim from behind, so dark filaments keep their outline
    rim: { k: 0.22, dir: [0.3, 0.6, -0.75] },
    hemi: { k: 0.12, sky: '#ffffff', ground: '#6a6d75' },
    env: 0.1,
    keyShadow: false,
    exposure: 1,
    tone: 'clamp',
    filament: { roughness: 0.34, specular: 0.5, clearcoat: 0, sheen: 0 },
    cad: { light: '#bdc1c8', dark: '#b0b5bd', roughness: 0.34, specular: 0.45, clearcoat: 0 },
    ao: { radius: 5, strength: 0.5 },
    edges: { px: 1.25, opacity: 1, light: '#121418', dark: '#111319', silhouette: 1 },
    bg: { light: { top: '#eef0f4', bottom: '#cfd4dc', glow: '#f7f8fa' }, dark: { top: '#2b2f3a', bottom: '#1d2028', glow: '#323745' } },
    glow: 0.2,
    vignette: 0,
    contact: { darkness: 1.5, opacity: 0.55 },
  },
}

// The grade pass's tone step, vignette and center glow as uniforms (the shipped shader has them as constants).
const TONE_GLSL = /* glsl */ `
uniform float sxTone;
uniform float sxVig;
uniform float sxGlow;
vec3 sxAces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 sxToneMap(vec3 c) {
  if (sxTone > 1.5) return sxAces(c * 0.8);
  if (sxTone > 0.5) return min(c, vec3(1.0));
  return neutral(c);
}
`

interface Internals {
  stage: { scene: Scene; key: DirectionalLight; fill: DirectionalLight; rim: DirectionalLight; bakeKit?: { mat: ShaderMaterial }; contact?: { plane: { material: { opacity: number } } }; requestContact(): void }
  pipeline: { exposure: number; aoRadius: number; aoStrength: number; gradeMat: ShaderMaterial; render: (s: Scene, c: Camera, o: unknown) => void }
  mats: { map: Map<string, Material> }
  renderer: { shadowMap: { needsUpdate: boolean } }
  invalidate(): void
}

let hemi: HemisphereLight | null = null
let patched = false
let active: Look = CURRENT
const tmp = new Vector3()

function patchGrade(p: Internals['pipeline']): void {
  if (patched) return
  patched = true
  const g = p.gradeMat
  g.uniforms.sxTone = { value: 0 }
  g.uniforms.sxVig = { value: 0.42 }
  g.uniforms.sxGlow = { value: 0.8 }
  g.fragmentShader = g.fragmentShader
    .replace('float hash(vec2 p)', TONE_GLSL + 'float hash(vec2 p)')
    .replace('col = neutral(col * exposure);', 'col = sxToneMap(col * exposure);')
    .replace('* 0.8);', '* sxGlow);')
    .replace('dot(v, v) * 0.42', 'dot(v, v) * sxVig')
  g.needsUpdate = true
  // camera rig: the lights follow the view before every frame
  const render = p.render.bind(p)
  p.render = (s, c, o) => {
    placeLights(c)
    render(s, c, o)
  }
}

let internals: Internals | null = null

function placeLights(cam: Camera): void {
  const L = active
  cam.updateMatrixWorld()
  const st = internals!.stage
  const set = (light: DirectionalLight, spec: LightSpec) => {
    light.intensity = spec.k * Math.PI
    light.visible = spec.k > 0
    if (L.rig === 'camera') {
      tmp.set(...spec.dir).normalize().transformDirection(cam.matrixWorld)
      light.position.copy(light.target.position).addScaledVector(tmp, 400)
    } else {
      light.position.set(...spec.dir)
    }
    light.updateMatrixWorld()
  }
  set(st.key, L.key)
  set(st.fill, L.fill)
  set(st.rim, L.rim)
  if (L.rig === 'camera' && L.keyShadow) internals!.renderer.shadowMap.needsUpdate = true
}

function srgb01(hex: string): [number, number, number] {
  const c = new Color(hex)
  const s = c.clone().convertLinearToSRGB()
  return [s.r, s.g, s.b]
}

/** Applies a look to a viewport. Call after setTheme and setRenderMode, since both rebuild materials. */
export function applyLook(vp: unknown, look: Look, studio: Studio): void {
  const I = vp as Internals
  internals = I
  active = look
  patchGrade(I.pipeline)
  const st = I.stage
  st.key.castShadow = look.keyShadow
  I.renderer.shadowMap.needsUpdate = true
  if (!hemi) {
    hemi = new HemisphereLight(0xffffff, 0xffffff, 0)
    st.scene.add(hemi)
  }
  hemi.color.set(look.hemi.sky)
  hemi.groundColor.set(look.hemi.ground)
  hemi.intensity = look.hemi.k * Math.PI
  hemi.visible = look.hemi.k > 0
  st.scene.environmentIntensity = look.env
  const p = I.pipeline
  p.exposure = look.exposure
  p.aoRadius = look.ao.radius
  p.aoStrength = look.ao.strength
  const u = p.gradeMat.uniforms
  u.sxTone!.value = look.tone === 'neutral' ? 0 : look.tone === 'clamp' ? 1 : 2
  u.sxVig!.value = look.vignette
  u.sxGlow!.value = look.glow
  if (u.exposure) u.exposure.value = look.exposure
  const bg = look.bg[studio]
  if (bg) {
    u.bgTop!.value = srgb01(bg.top)
    u.bgBot!.value = srgb01(bg.bottom)
    u.bgGlow!.value = srgb01(bg.glow)
  }
  const edge = studio === 'light' ? look.edges.light : look.edges.dark
  u.silColor!.value = new Color(edge)
  // the silhouette's strength rides on its color: mixing toward the background's average weakens it
  if (look.edges.silhouette < 1) (u.silColor!.value as Color).lerp(new Color(bg ? bg.bottom : '#20222b'), 1 - look.edges.silhouette)
  // materials
  const sh = sharedMaterials()
  sh.cad.color.set(studio === 'light' ? look.cad.light : look.cad.dark)
  sh.cad.roughness = look.cad.roughness
  sh.cad.specularIntensity = look.cad.specular
  sh.cad.clearcoat = look.cad.clearcoat
  sh.edgeCad.color.set(edge)
  sh.edgeCadWide.color.set(edge)
  sh.edgeCadWide.linewidth = look.edges.px
  sh.edgeCadWide.opacity = look.edges.opacity
  sh.edgeCad.opacity = look.edges.opacity
  for (const m of I.mats.map.values()) {
    if (!(m instanceof MeshPhysicalMaterial)) continue
    m.roughness = look.filament.roughness
    m.specularIntensity = look.filament.specular
    m.clearcoat = look.filament.clearcoat
    m.sheen = look.filament.sheen
    m.needsUpdate = true
  }
  sh.cad.needsUpdate = true
  const kit = st.bakeKit
  if (kit?.mat.uniforms.darkness) kit.mat.uniforms.darkness.value = look.contact.darkness
  if (st.contact) st.contact.plane.material.opacity = look.contact.opacity
  st.requestContact()
  I.invalidate()
}
