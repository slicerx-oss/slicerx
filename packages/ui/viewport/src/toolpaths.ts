// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Preview renderer for SXPV toolpath buffers. The raw segment records go to
// the GPU as they are (32 bytes each, read as two uvec4 instance attributes),
// and the vertex shader expands every record into a bead with a diamond
// cross-section (8 vertices, 8 triangles). The CPU never
// builds triangles. Layer and move scrubbing only rebind the instance range,
// and color modes only change a uniform.
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  FloatType,
  Group,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  LinearFilter,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshDepthMaterial,
  MeshPhongMaterial,
  MeshPhysicalMaterial,
  NearestFilter,
  Points,
  RedFormat,
  RGBADepthPacking,
  RGBAFormat,
  ShaderMaterial,
  Vector3,
  Vector4,
  type WebGLProgramParametersWithUniforms,
} from 'three'
import { SXPV_EXTRA_BYTES, SXPV_EXTRA_FLAG, SXPV_SEGMENT, SXPV_SEGMENT_BYTES, SXPV_TRAVEL_BYTES, objectOfSegment, type PreviewBuffers } from '@slicerx/contracts'
import type { MarkerKind, PreviewExtras, PreviewRanges } from './types'
import { DEFAULT_TOOL_COLORS, FEATURE_COLORS, HEAT_RAMP, SCENE, displayHex, hexToRgb, srgbToLinear, type ResolvedTheme, type SceneColors } from './palette'
import type { ColorMode, FilamentFinish, ToolpathFinish } from './types'
import { ToolheadRig } from './toolhead'
import { PurgeRig, type PurgePlan } from './purge'
import { GantryRig, type GantryHit, type GantrySpec } from './gantry'
import type { HeadModel } from './heads'
import { headAt, type HeadSeg } from './headpath'
import { changeSequence, poseAt, printedTop, type ChangeSequence, type ToolChangerSpec, type V3 } from './toolchanger'

/** Instances per draw call. Keeps each GPU buffer well under driver limits. */
const CHUNK = 1 << 20
const LAYER_LUT_W = 1024
const COLOR_MODE: Record<ColorMode, number> = { feature: 0, tool: 1, speed: 2, flow: 3, layerTime: 4, width: 5, height: 6, fan: 7, temperature: 8 }

export const MARKER_KINDS: readonly MarkerKind[] = ['retractions', 'seams', 'lifts', 'wipes', 'toolChanges', 'pauses']
/** Point shape per kind: 0 disc, 1 square, 2 diamond. */
const MARKER_SHAPE: Record<MarkerKind, number> = { retractions: 0, seams: 0, lifts: 0, wipes: 2, toolChanges: 1, pauses: 1 }

function markerColorsOf(scene: Pick<SceneColors, 'retraction' | 'seam' | 'lift' | 'wipe' | 'toolChange' | 'pause'>): Record<MarkerKind, string> {
  return { retractions: scene.retraction, seams: scene.seam, lifts: scene.lift, wipes: scene.wipe, toolChanges: scene.toolChange, pauses: scene.pause }
}

/**
 * Base bead: a 4-point diamond profile at both ends, 8 vertices and 8 triangles.
 * position = (across, up, along), normal = (across, up, along). There are no caps: the far
 * end is pushed half a line width past the segment end (see sxBead), so each bead overlaps
 * the start of the next one and corners close. Caps cost far more than their few pixels:
 * on Apple GPUs a capped bead took about 2.4 times as long per frame.
 */
function beadGeometry(): InstancedBufferGeometry {
  const prof: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]]
  const pos: number[] = []
  const nrm: number[] = []
  for (let t = 0; t < 2; t++) {
    for (const [u, v] of prof) {
      pos.push(u, v, t)
      nrm.push(u, v, 0)
    }
  }
  const idx: number[] = []
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    idx.push(i, 4 + i, 4 + j, i, 4 + j, j)
  }
  const g = new InstancedBufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3))
  g.setIndex(idx)
  return g
}

const BEAD_DECL = /* glsl */ `
in uvec4 aSegA;
in uvec4 aSegB;
in float aLayer;
in vec2 aExtra;
uniform uint uFeatureMask;
uniform vec2 uWidthRange;
uniform vec2 uHeightRange;
uniform vec2 uFanRange;
uniform vec2 uTempRange;
uniform float uHasExtras;
uniform float uCurLayer;
uniform int uColorMode;
uniform sampler2D uFeatureLut;
uniform sampler2D uToolLut;
uniform sampler2D uFinishLut;
uniform sampler2D uRamp;
uniform sampler2D uLayerLut;
uniform vec2 uSpeedRange;
uniform vec2 uFlowRange;
uniform vec3 uCamObj;
uniform float uViewH;
uniform vec4 uPartSeg;
uniform float uPartZ;
uniform float uPartFrac;
varying vec3 vSegColor;
varying float vLive;
varying vec4 vFinish;
varying float vSurf;
// Across and along the bead in plate space, and how far the normals keep their round shape (1) or turn to face the camera
// (level of detail): sxBead sets them for the per-pixel shading.
vec2 sxSide;
vec2 sxDir;
float sxK = 1.0;
float sxPx = 8.0;
void sxBead(out vec3 p, out vec3 n) {
  vec2 a = vec2(uintBitsToFloat(aSegA.x), uintBitsToFloat(aSegA.y));
  vec2 b = vec2(uintBitsToFloat(aSegA.z), uintBitsToFloat(aSegA.w));
  float zTop = uintBitsToFloat(aSegB.x);
  // Playback: the move under the nozzle is drawn only as far as the head has gone along it.
  if (uPartFrac < 1.0 && a == uPartSeg.xy && b == uPartSeg.zw && zTop == uPartZ) b = mix(a, b, uPartFrac);
  float hw = float(aSegB.y & 0xffffu) * 0.0005;
  float hh = float(aSegB.y >> 16u) * 0.0005;
  vec2 d = b - a;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 side = vec2(dir.y, -dir.x);
  sxSide = side;
  sxDir = dir;
  vec2 base = mix(a, b, position.z) + side * (position.x * hw) + dir * (position.z * hw);
  p = vec3(base, zTop - hh + position.y * hh);
  // Hidden feature types collapse to a point far outside the view, so they draw nothing and cast no shadow.
  if (((uFeatureMask >> min(aSegB.z & 0xffu, 31u)) & 1u) == 0u) { p = vec3(0.0, 0.0, -1.0e6); n = vec3(0.0, 0.0, 1.0); return; }
  n = normalize(vec3(side * normal.x + dir * normal.z, normal.y));
  // Level of detail: when a bead is only a few pixels tall its ridge normals alias into
  // moire, so they blend toward the normal of a round bead facing the camera.
  float depth = max(1e-3, -(modelViewMatrix * vec4(p, 1.0)).z);
  float px = 2.0 * hh * projectionMatrix[1][1] * 0.5 * uViewH / depth;
  sxPx = px;
  float k = mix(0.3, 1.0, smoothstep(0.7, 2.2, px));
  sxK = abs(aLayer - uCurLayer) > 0.5 ? k : 1.0;
  if (k < 1.0 && abs(aLayer - uCurLayer) > 0.5) {
    vec3 d3 = vec3(dir, 0.0);
    vec3 v = normalize(uCamObj - p);
    vec3 f = v - d3 * dot(v, d3);
    float fl = length(f);
    if (fl > 1e-4) n = normalize(mix(f / fl, n, k));
  }
}
`

const BEAD_COLOR = /* glsl */ `
{
  uint feat = aSegB.z & 0xffu;
  uint tool = (aSegB.z >> 8u) & 0xffu;
  vec3 c;
  if (uColorMode == 0) c = texelFetch(uFeatureLut, ivec2(int(min(feat, 15u)), 0), 0).rgb;
  else if (uColorMode == 1) c = texelFetch(uToolLut, ivec2(int(min(tool, 15u)), 0), 0).rgb;
  else if (uColorMode == 2) {
    float s = float(aSegB.z >> 16u) * 0.1;
    c = texture(uRamp, vec2(clamp((s - uSpeedRange.x) / max(1e-3, uSpeedRange.y - uSpeedRange.x), 0.0, 1.0), 0.5)).rgb;
  } else if (uColorMode == 3) {
    float f = uintBitsToFloat(aSegB.w);
    c = texture(uRamp, vec2(clamp((f - uFlowRange.x) / max(1e-4, uFlowRange.y - uFlowRange.x), 0.0, 1.0), 0.5)).rgb;
  } else if (uColorMode == 5) {
    float w = float(aSegB.y & 0xffffu) * 0.001;
    c = texture(uRamp, vec2(clamp((w - uWidthRange.x) / max(1e-4, uWidthRange.y - uWidthRange.x), 0.0, 1.0), 0.5)).rgb;
  } else if (uColorMode == 6) {
    float h = float(aSegB.y >> 16u) * 0.001;
    c = texture(uRamp, vec2(clamp((h - uHeightRange.x) / max(1e-4, uHeightRange.y - uHeightRange.x), 0.0, 1.0), 0.5)).rgb;
  } else if (uColorMode == 7) {
    c = uHasExtras > 0.5 ? texture(uRamp, vec2(clamp((aExtra.x - uFanRange.x) / max(1e-4, uFanRange.y - uFanRange.x), 0.0, 1.0), 0.5)).rgb : vec3(0.3);
  } else if (uColorMode == 8) {
    c = uHasExtras > 0.5 ? texture(uRamp, vec2(clamp((aExtra.y - uTempRange.x) / max(1e-4, uTempRange.y - uTempRange.x), 0.0, 1.0), 0.5)).rgb : vec3(0.3);
  } else {
    int li = int(aLayer);
    float t = texelFetch(uLayerLut, ivec2(li % ${LAYER_LUT_W}, li / ${LAYER_LUT_W}), 0).r;
    c = texture(uRamp, vec2(t, 0.5)).rgb;
  }
  vSegColor = c;
  vFinish = texelFetch(uFinishLut, ivec2(int(min(tool, 15u)), 0), 0);
  // What surface the bead belongs to from afar: a wall (1), a flat top, bottom or solid layer (2), anything else (0).
  vSurf = feat <= 2u || feat == 13u ? 1.0 : feat == 3u || feat == 4u || feat == 5u || feat == 7u || feat == 11u ? 2.0 : 0.0;
  // Only the walls of the live layer glow, so it reads as a lit ring at the nozzle height rather than a plane.
  vLive = abs(aLayer - uCurLayer) < 0.5 && feat <= 2u ? 1.0 : 0.0;
}
`

/** Declarations for per-vertex bead lighting; three.js supplies the light and shadow uniforms. */
const BEAD_LIGHT_DECL = /* glsl */ `
#include <bsdfs>
#include <lights_pars_begin>
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
uniform sampler2DShadow directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ];
#endif
uniform vec3 uEnvSH[ 9 ];
uniform float uEnvDiffuse;
uniform float uEnvSpec;
uniform vec3 uLiveColor;
uniform float uGlow;
varying vec3 vLit;
`

/** Runs after three.js computed transformedNormal, mvPosition and the shadow coordinates. */
const BEAD_LIGHT = /* glsl */ `
{
  vec3 n = normalize( transformedNormal );
  vec3 v = normalize( - mvPosition.xyz );
  vec3 albedo = vSegColor;
  vec3 c = getLightProbeIrradiance( uEnvSH, n ) * uEnvDiffuse * BRDF_Lambert( albedo );
  #if NUM_DIR_LIGHTS > 0
  IncidentLight L;
  for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
    getDirectionalLightInfo( directionalLights[ i ], L );
    float shadow = 1.0;
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    if ( i == 0 && receiveShadow ) {
      // three.js orders shadow-casting lights first, so light 0 is the key light and owns shadow map 0.
      vec4 sc = vDirectionalShadowCoord[ 0 ];
      sc.xyz /= sc.w;
      sc.z += directionalLightShadows[ 0 ].shadowBias;
      if ( sc.x >= 0.0 && sc.x <= 1.0 && sc.y >= 0.0 && sc.y <= 1.0 && sc.z <= 1.0 ) {
        shadow = mix( 1.0, texture( directionalShadowMap[ 0 ], sc.xyz ), directionalLightShadows[ 0 ].shadowIntensity );
      }
    }
    #endif
    vec3 irr = saturate( dot( n, L.direction ) ) * L.color * shadow;
    c += irr * ( BRDF_Lambert( albedo ) + BRDF_BlinnPhong( L.direction, v, n, vec3( 0.04 ), 36.0 ) );
  }
  #endif
  vec3 fr = F_Schlick( vec3( 0.04 ), 1.0, saturate( dot( n, v ) ) );
  // The glossy environment term uses the room's mean radiance (the SH constant band): at this
  // roughness the reflection is a soft wash, and one lookup less per vertex is measurable.
  c += uEnvSH[ 0 ] * 0.886227 * RECIPROCAL_PI * fr * uEnvSpec;
  if ( vLive > 0.5 ) {
    float rim = pow( 1.0 - saturate( abs( dot( n, v ) ) ), 1.5 );
    c += mix( albedo, uLiveColor, 0.9 ) * ( 0.7 + rim * uGlow );
  }
  vLit = c;
}
`

/**
 * Per-pixel bead shading. The vertex shader hands over the bead's frame in view space and where on its cross-section the
 * vertex sits; across a face the profile point runs along the diamond's edge, so normalizing it per pixel gives the
 * normal of a round bead. The beads are then lit by three.js's physical material, the one the model view uses, with the
 * same room, lights, finish and tone, so a sliced plate reads like the model.
 */
const BEAD_PIXEL_DECL = /* glsl */ `
varying vec3 vSideV;
varying vec3 vUpV;
varying vec3 vAlongV;
varying vec2 vProf;
varying float vK;
varying float vLayer;
varying float vBeadPx;
`

const BEAD_PIXEL = /* glsl */ `
{
  vSideV = normalize( normalMatrix * vec3( sxSide, 0.0 ) );
  vUpV = normalize( normalMatrix * vec3( 0.0, 0.0, 1.0 ) );
  vAlongV = normalize( normalMatrix * vec3( sxDir, 0.0 ) );
  vProf = position.xy;
  vK = sxK;
  vLayer = aLayer;
  vBeadPx = sxPx;
}
`

/** Declarations the bead fragment code below reads, on top of the physical material's own. */
const BEAD_FRAG_DECL = /* glsl */ `
uniform vec3 uLiveColor;
uniform float uGlow;
uniform float uCrease;
varying vec3 vSegColor;
varying float vLive;
varying vec4 vFinish;
varying float vSurf;
${BEAD_PIXEL_DECL}
`

/**
 * The bead's normal per pixel. Where the cross-section turns more than about half its width within one pixel its detail
 * cannot be drawn, so the round normal fades out there and a bead a pixel or two tall shades evenly instead of in moire.
 * From afar a bead stands for the surface it is part of: stacked walls face out, solid layers face up, and a lone bead
 * (infill, support) shows its round side to the camera. `sxOcc` is the groove where a bead sits on the one below; it
 * lasts a little longer than the round shape, so layer lines still read at a middle distance.
 */
const BEAD_NORMAL = /* glsl */ `
float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
float sxPl = length( vProf );
vec2 sxQ = sxPl > 1e-4 ? vProf / sxPl : vec2( 0.0, 1.0 );
// The part of a bead that shows: in a wall the beads above and below hide most of its top and bottom, in a solid layer
// its neighbors hide its sides. The hidden part's normals are squashed out, so a wall keeps its face's light.
vec2 sxShow = vSurf > 1.5 ? vec2( 0.6, 1.0 ) : vSurf > 0.5 ? vec2( 1.0, 0.6 ) : vec2( 1.0 );
vec3 sxRound = normalize( vSideV * sxQ.x * sxShow.x + vUpV * sxQ.y * sxShow.y );
float sxFw = fwidth( vProf.x ) + fwidth( vProf.y );
float sxKeep = vK * saturate( 1.6 - 1.4 * sxFw );
vec3 sxV = normalize( vViewPosition );
vec3 sxAcross = sxV - vAlongV * dot( sxV, vAlongV );
vec3 sxFacing = length( sxAcross ) > 1e-4 ? normalize( sxAcross ) : vUpV;
// The side of the bead this face is on (from the profile, not the view, so a face seen edge-on never flips).
vec3 sxOut = sxQ.x >= 0.0 ? vSideV : - vSideV;
vec3 sxMacro = vSurf > 1.5 ? vUpV : vSurf > 0.5 ? normalize( sxOut + vUpV * 0.15 ) : sxFacing;
vec3 normal = sxKeep >= 0.999 ? sxRound : normalize( mix( sxMacro, sxRound, sxKeep ) );
vec3 nonPerturbedNormal = normal;
// The groove under a wall bead or beside a solid-layer bead, while the bead's cross-section is drawn.
float sxEdge = vSurf > 1.5 ? abs( sxQ.x ) : - sxQ.y;
float sxOcc = 1.0 - uCrease * smoothstep( 0.3, 0.97, sxEdge ) * sxKeep;
// Farther out a wall's layers read as even lines, the way the model view draws them: a darker band under every layer
// while a layer is a few pixels tall, then under every 2nd, 4th, 8th layer as they shrink, so the lines stay about
// three pixels apart and never turn to moire.
if ( vSurf > 0.5 && vSurf < 1.5 ) {
  // The bead's height on screen comes from the vertex shader, smooth across the wall, so neighbors pick the same lines.
  float sxEvery = exp2( max( 0.0, ceil( log2( 3.0 / max( vBeadPx, 0.05 ) ) ) ) );
  float sxFirst = mod( vLayer + 0.5, sxEvery ) < 1.0 ? 1.0 : 0.0;
  // The whole bead darkens, not just its lower edge: a band a pixel or two tall that sampling cannot break into dots.
  float sxStripe = sxFirst * ( 1.0 - smoothstep( 8.0, 32.0, sxEvery ) ) * min( 1.0, 2.0 / sxEvery + 0.5 );
  sxOcc = mix( 1.0 - 0.22 * sxStripe, sxOcc, smoothstep( 3.0, 6.0, vBeadPx ) );
}
`

/** The finish's gloss on top of the physical material's (one value per tool): clearcoat and sheen, as the model view sets them. */
const BEAD_FINISH = /* glsl */ `
#ifdef USE_CLEARCOAT
material.clearcoat = vFinish.y;
#endif
#ifdef USE_SHEEN
material.sheenColor = mix( diffuseColor.rgb, vec3( 1.0 ), 0.45 ) * vFinish.z;
#endif
`

/** The groove's occlusion, the silk streak along the bead, and the live layer's glow. */
const BEAD_AFTER_LIGHTS = /* glsl */ `
reflectedLight.indirectDiffuse *= sxOcc;
reflectedLight.directDiffuse *= sxOcc;
reflectedLight.directSpecular *= mix( 1.0, sxOcc, 0.5 );
reflectedLight.indirectSpecular *= mix( 1.0, sxOcc, 0.5 );
#if NUM_DIR_LIGHTS > 0
if ( vFinish.w > 0.0 ) {
  // Silk: a bright streak across the bead, along its length (Kajiya-Kay), tinted by the filament.
  vec3 sxL = directionalLights[ 0 ].direction;
  float sxTh = dot( vAlongV, normalize( sxL + sxV ) );
  float sxStreak = pow( sqrt( max( 0.0, 1.0 - sxTh * sxTh ) ), 90.0 ) * vFinish.w * 0.5 * saturate( dot( normal, sxL ) );
  reflectedLight.directSpecular += sxStreak * directionalLights[ 0 ].color * mix( vec3( 1.0 ), diffuseColor.rgb, 0.55 );
}
#endif
if ( vLive > 0.5 ) {
  float sxRim = pow( 1.0 - saturate( abs( dot( normal, sxV ) ) ), 1.5 );
  totalEmissiveRadiance += mix( diffuseColor.rgb, uLiveColor, 0.9 ) * ( 0.7 + sxRim * uGlow );
}
`

/**
 * Fan, nozzle temperature, retraction and seam markers read from the per-segment extras of an SXPV
 * buffer, or null when it has none. Retractions and seams are placed at the start of the segment
 * that carries the flag.
 */
export function extrasFromBuffers(b: PreviewBuffers): PreviewExtras | null {
  if (b.extrasOffset < 0) return null
  const S = b.segmentCount
  const ex = new Uint8Array(b.raw, b.extrasOffset, S * SXPV_EXTRA_BYTES)
  const exView = new DataView(b.raw, b.extrasOffset, S * SXPV_EXTRA_BYTES)
  const seg = new Float32Array(b.raw, b.segmentsOffset, S * (SXPV_SEGMENT_BYTES / 4))
  const fan = new Uint8Array(S)
  const temp = new Uint16Array(S)
  const retr: number[] = []
  const seams: number[] = []
  const lifts: number[] = []
  for (let i = 0; i < S; i++) {
    const o = i * SXPV_EXTRA_BYTES
    fan[i] = Math.round(((ex[o] ?? 0) * 100) / 255)
    temp[i] = exView.getUint16(o + 2, true)
    const flags = ex[o + 1] ?? 0
    if (flags & (SXPV_EXTRA_FLAG.retract | SXPV_EXTRA_FLAG.seam | SXPV_EXTRA_FLAG.lift)) {
      const q = i * (SXPV_SEGMENT_BYTES / 4)
      const x = seg[q] ?? 0
      const y = seg[q + 1] ?? 0
      const z = seg[q + 4] ?? 0
      if (flags & SXPV_EXTRA_FLAG.retract) retr.push(x, y, z)
      if (flags & SXPV_EXTRA_FLAG.seam) seams.push(x, y, z)
      if (flags & SXPV_EXTRA_FLAG.lift) lifts.push(x, y, z)
    }
  }
  return { fanPct: fan, nozzleC: temp, retractions: new Float32Array(retr), seams: new Float32Array(seams), lifts: new Float32Array(lifts) }
}

function layerOfSegment(b: PreviewBuffers, segment: number): number {
  let lo = 0
  let hi = b.layerCount - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((b.layerStart[mid] ?? 0) <= segment) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** G-code line (1-based) of a segment, or 0 when unknown. */
export function gcodeLineOf(b: PreviewBuffers, segment: number): number {
  if (b.extrasOffset < 0 || segment < 0 || segment >= b.segmentCount) return 0
  return new DataView(b.raw).getUint32(b.extrasOffset + segment * SXPV_EXTRA_BYTES + 4, true)
}

/** Layer index whose top is at or just above `z` (markers sit on the layer they were printed in). */
export function layerOfZ(layerZ: ArrayLike<number>, z: number): number {
  let lo = 0
  let hi = layerZ.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((layerZ[mid] ?? 0) + 1e-3 < z) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * How each finish lights, as the bead shader reads it: roughness, clearcoat, sheen and the silk streak. They are the
 * model view's values for the same finish (studioMaterial), so a matte or silk print looks the same sliced or not.
 */
export const BEAD_FINISHES: Record<ToolpathFinish, readonly [number, number, number, number]> = {
  matte: [0.82, 0, 0.35, 0],
  satin: [0.52, 0.16, 0.3, 0],
  glossy: [0.3, 0.6, 0.2, 0],
  silk: [0.26, 1, 0.9, 1],
}

/** The finish a model part's look draws its toolpaths with. */
export function beadFinish(f: FilamentFinish | ToolpathFinish | undefined): ToolpathFinish {
  return f === 'matte' || f === 'silk' || f === 'glossy' ? f : f === 'petg' || f === 'translucent' ? 'glossy' : 'satin'
}

/** One finish per tool (16 at most), satin for tools without one. */
function finishTexture(finishes: readonly (ToolpathFinish | undefined)[], size = 16): DataTexture {
  const data = new Float32Array(size * 4)
  for (let i = 0; i < size; i++) data.set(BEAD_FINISHES[finishes[i] ?? finishes[0] ?? 'satin'], i * 4)
  const t = new DataTexture(data, size, 1, RGBAFormat, FloatType)
  t.minFilter = NearestFilter
  t.magFilter = NearestFilter
  t.needsUpdate = true
  return t
}

function lutTexture(colors: readonly string[], size = 16): DataTexture {
  const data = new Float32Array(size * 4)
  for (let i = 0; i < size; i++) {
    const hex = colors[i] ?? colors[colors.length - 1] ?? '#ffffff'
    const [r, g, b] = hexToRgb(displayHex(hex))
    data[4 * i] = srgbToLinear(r)
    data[4 * i + 1] = srgbToLinear(g)
    data[4 * i + 2] = srgbToLinear(b)
    data[4 * i + 3] = 1
  }
  const t = new DataTexture(data, size, 1, RGBAFormat, FloatType)
  t.minFilter = t.magFilter = NearestFilter
  t.needsUpdate = true
  return t
}

function rampTexture(stops: readonly string[], size = 256): DataTexture {
  const data = new Float32Array(size * 4)
  const lin = stops.map((h) => hexToRgb(h).map(srgbToLinear))
  for (let i = 0; i < size; i++) {
    const t = (i / (size - 1)) * (lin.length - 1)
    const k = Math.min(lin.length - 2, Math.floor(t))
    const f = t - k
    const a = lin[k] ?? [0, 0, 0]
    const b = lin[k + 1] ?? a
    for (let j = 0; j < 3; j++) data[4 * i + j] = (a[j] ?? 0) + ((b[j] ?? 0) - (a[j] ?? 0)) * f
    data[4 * i + 3] = 1
  }
  const t = new DataTexture(data, size, 1, RGBAFormat, FloatType)
  t.minFilter = t.magFilter = LinearFilter
  t.needsUpdate = true
  return t
}

/** One segment far below the bed, used to compile the bead shaders before the first real preview arrives. */
export function warmupBuffers(): PreviewBuffers {
  const N = 1
  const raw = new ArrayBuffer(32 + (N + 1) * 4 + N * 8 + SXPV_SEGMENT_BYTES)
  const layerStart = new Uint32Array(raw, 32, N + 1)
  layerStart.set([0, 1])
  const layerZ = new Float32Array(raw, 32 + (N + 1) * 4, N)
  const layerTimeS = new Float32Array(raw, 32 + (N + 1) * 4 + N * 4, N)
  const segmentsOffset = 32 + (N + 1) * 4 + N * 8
  const f = new Float32Array(raw, segmentsOffset, 8)
  const u = new Uint32Array(raw, segmentsOffset, 8)
  f.set([0, 0, 1, 0, -500])
  u[5] = 420 | (200 << 16)
  return { raw, version: 1, segmentCount: 1, layerCount: N, travelCount: 0, toolCount: 1, layerHeight: 0.2, layerStart, layerZ, layerTimeS, travelStart: null, segmentsOffset, travelsOffset: -1, extrasOffset: -1, travelFlagsOffset: -1, objectsOffset: -1 }
}

interface Chunk {
  start: number
  end: number
  mesh: Mesh
  geo: InstancedBufferGeometry
  seg: InstancedInterleavedBuffer
  layer: InstancedInterleavedBuffer
  drawn: [number, number]
  extra?: InstancedInterleavedBuffer | undefined
}

export class Toolpaths {
  readonly root = new Group()
  private readonly base = beadGeometry()
  private readonly material: MeshPhongMaterial | MeshPhysicalMaterial
  private readonly depthMaterial: MeshDepthMaterial
  private readonly uniforms = {
    uCurLayer: { value: -1 },
    uColorMode: { value: 0 },
    uFeatureLut: { value: lutTexture(FEATURE_COLORS.map((f) => f.color)) },
    uToolLut: { value: lutTexture(DEFAULT_TOOL_COLORS) },
    uFinishLut: { value: finishTexture([]) },
    uCrease: { value: 0.55 },
    uRamp: { value: rampTexture(HEAT_RAMP) },
    uLayerLut: { value: new DataTexture(new Float32Array(1), 1, 1, RedFormat, FloatType) },
    uSpeedRange: { value: [0, 300] as [number, number] },
    uFlowRange: { value: [0, 30] as [number, number] },
    uWidthRange: { value: [0.2, 0.8] as [number, number] },
    uHeightRange: { value: [0.1, 0.4] as [number, number] },
    uFanRange: { value: [0, 100] as [number, number] },
    uTempRange: { value: [180, 260] as [number, number] },
    uHasExtras: { value: 0 },
    uFeatureMask: { value: 0x7fff },
    uLiveColor: { value: new Color(SCENE.liveLayer) },
    uGlow: { value: 3 },
    uCamObj: { value: new Vector3() },
    uEnvSH: { value: Array.from({ length: 9 }, (_, i) => (i === 0 ? new Vector3(0.9, 0.9, 0.95) : new Vector3())) },
    uEnvDiffuse: { value: 0.9 },
    uEnvSpec: { value: 0.9 },
    uViewH: { value: 800 },
    // The partly drawn move during playback: its ends and height pick it out, the share says how far it goes.
    uPartSeg: { value: new Vector4() },
    uPartZ: { value: 0 },
    uPartFrac: { value: 1 },
  }
  private chunks: Chunk[] = []
  private travelColor: string = SCENE.travel
  private themeToolColors: readonly string[] = DEFAULT_TOOL_COLORS
  private userToolColors: readonly string[] | null = null
  private extras: PreviewExtras | null = null
  private readonly markers: Record<MarkerKind, Points | null> = { retractions: null, seams: null, lifts: null, wipes: null, toolChanges: null, pauses: null }
  private readonly markerShown: Record<MarkerKind, boolean> = { retractions: false, seams: false, lifts: false, wipes: false, toolChanges: false, pauses: false }
  private markerColors: Record<MarkerKind, string> = markerColorsOf(SCENE)
  /** Wipes, tool changes and pauses come from the G-code, which the app reads; they stay apart from the buffer's own extras. */
  private gcodeMarkers: Partial<Record<MarkerKind, Float32Array>> = {}
  private readonly markerRange = { value: [0, 0] as [number, number] }
  private buf: PreviewBuffers | null = null
  private rangesReady = false
  private travels: LineSegments | null = null
  private travelsOn = false
  private readonly head = new ToolheadRig()
  /** The purge chute and the blob a change flushes into it (Bambu printers), by the change's first segment. */
  private readonly purge = new PurgeRig()
  private purges: Map<number, PurgePlan> | null = null
  /** heimdall's gantry beam over the moving head, red where it runs through a part it strikes. */
  private readonly gantry = new GantryRig()
  private changer: ToolChangerSpec | null = null
  /** Preview's "Show toolhead": off hides the moving head; the rack, dock, chute and wiper stay. */
  private headOn = true
  private change: { segment: number; seconds: number; fixed: number } | null = null
  private changeSeq: { key: string; seq: ChangeSequence } | null = null
  /** Segments where the tool differs from the one before, in order, with the tools either side. */
  private changes: { segment: number; from: number; to: number }[] = []
  lo = 0
  hi = 0
  /** Moves drawn on the top layer; a fraction draws the next move part of the way (playback). */
  moveCut: number | null = null
  /** Playback's partly drawn move and the head's point on it, or null at a whole move. */
  private part: { index: number; f: number } | null = null
  /** Told where the moving head is after each change, in bed millimetres (the follow-the-nozzle camera). */
  onHead: ((x: number, y: number, z: number) => void) | null = null
  colorMode: ColorMode = 'feature'

  /** `ghost` draws the paths as a faint gray layer with no shadows or toolhead: the slice before a change, for comparison. */
  constructor(private readonly ghost = false) {
    this.root.name = ghost ? 'toolpaths-ghost' : 'toolpaths'
    const u = this.uniforms
    // The live paths are lit per pixel by the model view's physical material (round bead normals, the room, the lights,
    // the finish's clearcoat and sheen, tone). The ghost stays lit per vertex by Phong: it is a faint gray layer.
    this.material = ghost
      ? new MeshPhongMaterial({ color: 0xffffff, specular: new Color(0.04, 0.04, 0.04), shininess: 36 })
      : new MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.52, metalness: 0, clearcoat: 0.16, clearcoatRoughness: 0.3, sheen: 1, sheenRoughness: 0.55, envMapIntensity: 0.95 })
    this.material.onBeforeCompile = (sh: WebGLProgramParametersWithUniforms) => {
      Object.assign(sh.uniforms, u)
      sh.vertexShader =
        BEAD_DECL +
        sh.vertexShader
          .replace('#include <common>', '#include <common>\n' + (ghost ? BEAD_LIGHT_DECL : BEAD_PIXEL_DECL))
          .replace('#include <beginnormal_vertex>', 'vec3 sxP; vec3 objectNormal; sxBead(sxP, objectNormal);\n' + BEAD_COLOR)
          .replace('#include <begin_vertex>', 'vec3 transformed = sxP;')
          .replace('#include <shadowmap_vertex>', '#include <shadowmap_vertex>\n' + (ghost ? BEAD_LIGHT : BEAD_PIXEL))
      sh.fragmentShader = ghost
        ? 'varying vec3 vLit;\nvoid main() {\n  float g = dot( vLit, vec3( 0.299, 0.587, 0.114 ) );\n  gl_FragColor = vec4( vec3( g * 0.6 + 0.35 ), 0.3 );\n}\n'
        : BEAD_FRAG_DECL +
          sh.fragmentShader
            .replace('#include <color_fragment>', 'diffuseColor.rgb = vSegColor;')
            .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vFinish.x;')
            .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vFinish.w * 0.28;')
            .replace('#include <normal_fragment_begin>', BEAD_NORMAL)
            .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n' + BEAD_FINISH)
            .replace('#include <aomap_fragment>', BEAD_AFTER_LIGHTS)
    }
    if (ghost) {
      this.material.transparent = true
      this.material.depthWrite = false
    }
    this.material.customProgramCacheKey = () => (ghost ? 'sx-bead-ghost' : 'sx-bead-pixel')
    this.depthMaterial = new MeshDepthMaterial({ depthPacking: RGBADepthPacking })
    this.depthMaterial.onBeforeCompile = (sh: WebGLProgramParametersWithUniforms) => {
      Object.assign(sh.uniforms, u)
      sh.vertexShader = BEAD_DECL + sh.vertexShader.replace('#include <begin_vertex>', 'vec3 sxP; vec3 sxN; sxBead(sxP, sxN);\nvec3 transformed = sxP;')
      sh.vertexShader = sh.vertexShader.replace('varying vec3 vSegColor;\nvarying float vLive;\nvarying vec4 vFinish;\nvarying float vSurf;\n', '')
    }
    this.depthMaterial.customProgramCacheKey = () => 'sx-bead-depth'
    this.root.add(this.head.root, this.purge.root, this.gantry.root)
  }

  /** Room irradiance as nine spherical-harmonic coefficients (three.js LightProbe order). */
  setEnvironment(sh: readonly Vector3[]): void {
    sh.forEach((c, i) => this.uniforms.uEnvSH.value[i]?.copy(c))
  }

  /** Camera position in bed coordinates and the drawing buffer height in pixels, for bead level of detail. */
  setView(camBed: Vector3, viewHeightPx: number): void {
    this.uniforms.uCamObj.value.copy(camBed)
    this.uniforms.uViewH.value = viewHeightPx
  }

  get buffers(): PreviewBuffers | null {
    return this.buf
  }

  get segmentCount(): number {
    return this.buf?.segmentCount ?? 0
  }

  set(buffers: PreviewBuffers | null): void {
    this.clearChunks()
    this.buf = buffers
    this.extras = null
    this.gcodeMarkers = {}
    this.uniforms.uHasExtras.value = 0
    this.buildMarkers()
    this.rangesReady = false
    if (!buffers || buffers.segmentCount === 0 || buffers.layerCount === 0) return
    const S = buffers.segmentCount
    const N = buffers.layerCount
    const words = new Uint32Array(buffers.raw, buffers.segmentsOffset, S * (SXPV_SEGMENT_BYTES / 4))
    const layer = N < 65536 ? new Uint16Array(S) : new Float32Array(S)
    for (let k = 0; k < N; k++) layer.fill(k, buffers.layerStart[k] ?? 0, buffers.layerStart[k + 1] ?? S)
    for (let start = 0; start < S; start += CHUNK) {
      const end = Math.min(S, start + CHUNK)
      const seg = new InstancedInterleavedBuffer(words.subarray(start * 8, end * 8), 8, 1)
      const lb = new InstancedInterleavedBuffer(layer.subarray(start, end), 1, 1)
      const geo = new InstancedBufferGeometry()
      geo.index = this.base.index
      geo.setAttribute('position', this.base.getAttribute('position'))
      geo.setAttribute('normal', this.base.getAttribute('normal'))
      const mesh = new Mesh(geo, this.material)
      mesh.customDepthMaterial = this.depthMaterial
      mesh.frustumCulled = false
      mesh.castShadow = !this.ghost
      mesh.receiveShadow = !this.ghost
      if (this.ghost) mesh.renderOrder = 3
      const c: Chunk = { start, end, mesh, geo, seg, layer: lb, drawn: [-1, -1] }
      this.bind(c, 0, end - start)
      this.chunks.push(c)
      this.root.add(mesh)
    }
    this.updateLayerLut()
    this.changes = changePoints(buffers)
    this.changeSeq = null
    this.lo = 0
    this.hi = N - 1
    this.moveCut = null
    this.apply()
    if (this.travelsOn) this.buildTravels()
    const native = extrasFromBuffers(buffers)
    if (native) this.setExtras(native)
  }

  private bind(c: Chunk, from: number, to: number): void {
    if (c.drawn[0] === from && c.drawn[1] === to) return
    // New attribute objects with a shifted offset rebind the same GPU buffer at a new start; nothing is uploaded again.
    c.geo.setAttribute('aSegA', new InterleavedBufferAttribute(c.seg, 4, from * 8))
    c.geo.setAttribute('aSegB', new InterleavedBufferAttribute(c.seg, 4, from * 8 + 4))
    c.geo.setAttribute('aLayer', new InterleavedBufferAttribute(c.layer, 1, from))
    if (c.extra) c.geo.setAttribute('aExtra', new InterleavedBufferAttribute(c.extra, 2, from * 2))
    c.geo.instanceCount = to - from
    c.drawn = [from, to]
  }

  private updateLayerLut(): void {
    const b = this.buf
    if (!b) return
    const N = b.layerCount
    const h = Math.max(1, Math.ceil(N / LAYER_LUT_W))
    const data = new Float32Array(LAYER_LUT_W * h)
    let mn = Infinity
    let mx = 0
    for (let k = 0; k < N; k++) {
      const t = b.layerTimeS[k] ?? 0
      if (t < mn) mn = t
      if (t > mx) mx = t
    }
    const span = Math.max(1e-3, mx - mn)
    for (let k = 0; k < N; k++) data[k] = ((b.layerTimeS[k] ?? 0) - mn) / span
    const old = this.uniforms.uLayerLut.value
    const t = new DataTexture(data, LAYER_LUT_W, h, RedFormat, FloatType)
    t.minFilter = t.magFilter = NearestFilter
    t.needsUpdate = true
    this.uniforms.uLayerLut.value = t
    old.dispose()
  }

  /** Speed and flow ranges need a pass over every segment, so they run only when a mode needs them. */
  private ensureRanges(): void {
    const b = this.buf
    if (!b || this.rangesReady) return
    const S = b.segmentCount
    const u16 = new Uint16Array(b.raw, b.segmentsOffset, S * 16)
    const f32 = new Float32Array(b.raw, b.segmentsOffset, S * 8)
    let smin = Infinity, smax = 0, fmin = Infinity, fmax = 0, wmin = Infinity, wmax = 0, hmin = Infinity, hmax = 0
    for (let i = 0; i < S; i++) {
      const sp = (u16[i * 16 + 13] ?? 0) * 0.1
      const fl = f32[i * 8 + 7] ?? 0
      const w = (u16[i * 16 + 10] ?? 0) * 0.001
      const h = (u16[i * 16 + 11] ?? 0) * 0.001
      if (w > 0) {
        if (w < wmin) wmin = w
        if (w > wmax) wmax = w
      }
      if (h > 0) {
        if (h < hmin) hmin = h
        if (h > hmax) hmax = h
      }
      if (sp > 0) {
        if (sp < smin) smin = sp
        if (sp > smax) smax = sp
      }
      if (fl > 0) {
        if (fl < fmin) fmin = fl
        if (fl > fmax) fmax = fl
      }
    }
    this.uniforms.uSpeedRange.value = [Number.isFinite(smin) ? smin : 0, smax]
    this.uniforms.uFlowRange.value = [Number.isFinite(fmin) ? fmin : 0, fmax]
    this.uniforms.uWidthRange.value = [Number.isFinite(wmin) ? wmin : 0, wmax]
    this.uniforms.uHeightRange.value = [Number.isFinite(hmin) ? hmin : 0, hmax]
    this.rangesReady = true
  }

  ranges(): PreviewRanges {
    this.ensureRanges()
    const u = this.uniforms
    return {
      speed: [...u.uSpeedRange.value],
      flow: [...u.uFlowRange.value],
      width: [...u.uWidthRange.value],
      height: [...u.uHeightRange.value],
      fan: this.extras?.fanPct ? [...u.uFanRange.value] : null,
      temperature: this.extras?.nozzleC ? [...u.uTempRange.value] : null,
    }
  }

  /** True when per-segment fan or temperature data is loaded, so those color schemes have something to show. */
  hasMarkers(): Record<MarkerKind, boolean> {
    const m = this.markers
    return { retractions: !!m.retractions, seams: !!m.seams, lifts: !!m.lifts, wipes: !!m.wipes, toolChanges: !!m.toolChanges, pauses: !!m.pauses }
  }

  hasExtras(): { fan: boolean; temperature: boolean } {
    return { fan: !!this.extras?.fanPct, temperature: !!this.extras?.nozzleC }
  }

  setColorMode(mode: ColorMode): void {
    this.colorMode = mode
    if (mode !== 'feature' && mode !== 'tool' && mode !== 'layerTime') this.ensureRanges()
    this.uniforms.uColorMode.value = COLOR_MODE[mode]
  }

  /** Bit per feature id; a cleared bit hides that feature type. */
  setFeatureMask(mask: number): void {
    this.uniforms.uFeatureMask.value = mask >>> 0
  }

  /**
   * Per-segment fan and nozzle temperature, and marker positions. Arrays follow segment order.
   * Passing null clears them.
   */
  setExtras(extras: PreviewExtras | null): void {
    this.extras = extras
    const b = this.buf
    const u = this.uniforms
    u.uHasExtras.value = extras && (extras.fanPct || extras.nozzleC) ? 1 : 0
    if (b && extras && (extras.fanPct || extras.nozzleC)) {
      const S = b.segmentCount
      const data = new Float32Array(S * 2)
      let fmin = Infinity, fmax = -Infinity, tmin = Infinity, tmax = -Infinity
      for (let i = 0; i < S; i++) {
        const f = extras.fanPct?.[i] ?? 0
        const t = extras.nozzleC?.[i] ?? 0
        data[2 * i] = f
        data[2 * i + 1] = t
        if (extras.fanPct) {
          if (f < fmin) fmin = f
          if (f > fmax) fmax = f
        }
        if (extras.nozzleC && t > 0) {
          if (t < tmin) tmin = t
          if (t > tmax) tmax = t
        }
      }
      if (fmax >= fmin) u.uFanRange.value = [fmin, Math.max(fmax, fmin + 1)]
      if (tmax >= tmin) u.uTempRange.value = [tmin, Math.max(tmax, tmin + 1)]
      for (const c of this.chunks) c.extra = new InstancedInterleavedBuffer(data.subarray(c.start * 2, c.end * 2), 2, 1)
    } else {
      for (const c of this.chunks) c.extra = undefined
    }
    for (const c of this.chunks) {
      const [from, to] = c.drawn
      c.drawn = [-1, -1]
      this.bind(c, Math.max(0, from), Math.max(0, to))
      if (!c.extra) c.geo.deleteAttribute('aExtra')
    }
    this.buildMarkers()
  }

  private buildMarkers(): void {
    for (const kind of MARKER_KINDS) {
      const m = this.markers[kind]
      if (!m) continue
      m.geometry.dispose()
      ;(m.material as ShaderMaterial).dispose()
      m.removeFromParent()
      this.markers[kind] = null
    }
    const b = this.buf
    if (!b) return
    const ex = this.extras
    const make = (kind: MarkerKind, xyz: Float32Array | undefined): Points | null => {
      if (!xyz || xyz.length < 3) return null
      const n = Math.floor(xyz.length / 3)
      const layer = new Float32Array(n)
      for (let i = 0; i < n; i++) layer[i] = layerOfZ(b.layerZ, xyz[3 * i + 2] ?? 0)
      const g = new BufferGeometry()
      g.setAttribute('position', new BufferAttribute(xyz.subarray(0, n * 3), 3))
      g.setAttribute('aLayer', new BufferAttribute(layer, 1))
      const m = new ShaderMaterial({
        uniforms: { uCol: { value: new Color(this.markerColors[kind]) }, uRange: this.markerRange, uSize: { value: MARKER_SHAPE[kind] === 0 ? 10 : 11 }, uShape: { value: MARKER_SHAPE[kind] } },
        vertexShader: 'attribute float aLayer; uniform vec2 uRange; uniform float uSize; void main(){ vec4 mv = modelViewMatrix * vec4(position + vec3(0.0, 0.0, 0.3), 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = (aLayer < uRange.x || aLayer > uRange.y) ? 0.0 : uSize; if (gl_PointSize == 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }',
        // Shapes tell the kinds apart without color: discs for retractions, seams and lifts, a diamond for wipes, a square for tool changes and pauses.
        fragmentShader: 'uniform vec3 uCol; uniform float uShape; void main(){ vec2 d = gl_PointCoord - 0.5; float r = uShape > 1.5 ? abs(d.x) + abs(d.y) : uShape > 0.5 ? max(abs(d.x), abs(d.y)) : length(d); if (r > 0.5) discard; float rim = smoothstep(0.5, 0.36, r); gl_FragColor = vec4(mix(vec3(0.02), uCol, rim), 1.0); }',
        depthTest: true,
        depthWrite: false,
      })
      const pts = new Points(g, m)
      pts.frustumCulled = false
      pts.renderOrder = 2
      pts.raycast = () => {}
      this.root.add(pts)
      return pts
    }
    this.markers.retractions = make('retractions', ex?.retractions)
    this.markers.seams = make('seams', ex?.seams)
    this.markers.lifts = make('lifts', ex?.lifts)
    this.markers.wipes = make('wipes', this.gcodeMarkers.wipes ?? ex?.wipes)
    this.markers.toolChanges = make('toolChanges', this.gcodeMarkers.toolChanges ?? ex?.toolChanges)
    this.markers.pauses = make('pauses', this.gcodeMarkers.pauses ?? ex?.pauses)
    this.applyMarkers()
  }

  /**
   * Wipe, tool change and pause positions (x, y, z per marker, bed frame mm) read from the G-code. They keep
   * until the next preview; null removes a kind.
   */
  setGcodeMarkers(data: Partial<Record<'wipes' | 'toolChanges' | 'pauses', Float32Array | null>>): void {
    for (const [k, v] of Object.entries(data) as ['wipes' | 'toolChanges' | 'pauses', Float32Array | null][]) {
      if (v) this.gcodeMarkers[k] = v
      else delete this.gcodeMarkers[k]
    }
    this.buildMarkers()
  }

  /** Show or hide each kind of marker. They follow the layer range. */
  setMarkers(opts: Partial<Record<MarkerKind, boolean>>): void {
    for (const kind of MARKER_KINDS) {
      const on = opts[kind]
      if (on !== undefined) this.markerShown[kind] = on
    }
    this.applyMarkers()
  }

  private applyMarkers(): void {
    for (const kind of MARKER_KINDS) {
      const m = this.markers[kind]
      if (m) m.visible = this.markerShown[kind]
    }
    this.markerRange.value = [this.lo, this.hi]
  }

  /** The finish each tool's filament prints with (tool 1 first): matte, satin, glossy or silk. A tool without one is satin. */
  setToolFinishes(finishes: readonly ToolpathFinish[]): void {
    const old = this.uniforms.uFinishLut.value
    this.uniforms.uFinishLut.value = finishTexture(finishes)
    old.dispose()
  }

  /** How dark the groove between stacked layers is, 0 (none) to 1. */
  setCrease(amount: number): void {
    this.uniforms.uCrease.value = Math.max(0, Math.min(1, amount))
  }

  setToolColors(colors: readonly string[]): void {
    this.userToolColors = colors.length ? colors : null
    this.uploadToolColors()
  }

  /** Feature colors, heat ramp, default tool colors, live layer and travel colors. Tool colors from setToolColors stay. */
  setTheme(t: ResolvedTheme): void {
    const u = this.uniforms
    const old = [u.uFeatureLut.value, u.uRamp.value]
    u.uFeatureLut.value = lutTexture(t.featureColors)
    u.uRamp.value = rampTexture(t.heatRamp)
    for (const o of old) o.dispose()
    u.uLiveColor.value.set(t.scene.liveLayer)
    this.travelColor = t.scene.travel
    if (this.travels) (this.travels.material as LineBasicMaterial).color.set(t.scene.travel)
    this.themeToolColors = t.toolColors
    this.uploadToolColors()
    this.markerColors = markerColorsOf(t.scene)
    for (const kind of MARKER_KINDS) {
      const m = this.markers[kind]
      if (m) (m.material as ShaderMaterial).uniforms.uCol?.value.set(this.markerColors[kind])
    }
  }

  private uploadToolColors(): void {
    const old = this.uniforms.uToolLut.value
    this.uniforms.uToolLut.value = lutTexture(this.userToolColors ?? this.themeToolColors)
    old.dispose()
    this.head.setColors(this.userToolColors ?? this.themeToolColors)
    this.purge.setColors(this.userToolColors ?? this.themeToolColors)
  }

  setRange(lo: number, hi: number, moveCut: number | null): void {
    const b = this.buf
    if (!b) return
    const N = b.layerCount
    this.hi = Math.max(0, Math.min(N - 1, Math.round(hi)))
    this.lo = Math.max(0, Math.min(this.hi, Math.round(lo)))
    // Whole moves stay whole; playback hands a fraction, which draws the next move part of the way.
    this.moveCut = moveCut === null ? null : Math.max(0, Math.abs(moveCut - Math.round(moveCut)) < 1e-6 ? Math.round(moveCut) : moveCut)
    this.apply()
  }

  /** The last move drawn: its segment index, layer and G-code line (0 when the buffer has none). Null with no preview. */
  currentMove(): { segment: number; layer: number; gcodeLine: number } | null {
    const b = this.buf
    if (!b) return null
    const [from, to] = this.visibleRange()
    if (to <= from) return null
    const segment = to - 1
    return { segment, layer: layerOfSegment(b, segment), gcodeLine: gcodeLineOf(b, segment) }
  }

  /**
   * The drawn toolpath a ray hits first, for a click in Preview. The ray is in bed coordinates; `pxAngle` is the
   * angle one screen pixel covers, so thin paths far away can still be hit. Hidden features and layers are skipped.
   */
  pick(origin: Vector3, dir: Vector3, pxAngle: number): { segment: number; layer: number; feature: number; tool: number; gcodeLine: number; object: number; point: [number, number, number] } | null {
    const b = this.buf
    if (!b) return null
    const [from, to] = this.visibleRange()
    const f = new Float32Array(b.raw, b.segmentsOffset, b.segmentCount * 8)
    const bytes = new Uint8Array(b.raw, b.segmentsOffset, b.segmentCount * SXPV_SEGMENT_BYTES)
    const u16 = new Uint16Array(b.raw, b.segmentsOffset, b.segmentCount * 16)
    const mask = this.uniforms.uFeatureMask.value
    const ox = origin.x, oy = origin.y, oz = origin.z
    const dx = dir.x, dy = dir.y, dz = dir.z
    let best = -1
    let bestT = Infinity
    for (let i = from; i < to; i++) {
      const k = i * 8
      const feature = bytes[i * SXPV_SEGMENT_BYTES + SXPV_SEGMENT.feature] ?? 0
      if (!((mask >> feature) & 1)) continue
      const ax = f[k] as number, ay = f[k + 1] as number, bx = f[k + 2] as number, by = f[k + 3] as number, z = f[k + 4] as number
      // Closest approach of the ray (o + t d) and the segment (a + s e), e flat in z.
      const ex = bx - ax, ey = by - ay
      const wx = ox - ax, wy = oy - ay, wz = oz - z
      const ee = ex * ex + ey * ey
      const de = dx * ex + dy * ey
      const dw = dx * wx + dy * wy + dz * wz
      const ew = ex * wx + ey * wy
      const den = ee - de * de
      let sSeg = den > 1e-9 ? (ew - de * dw) / den : 0
      sSeg = sSeg < 0 ? 0 : sSeg > 1 ? 1 : sSeg
      const t = de * sSeg - dw
      if (t <= 0 || t >= bestT) continue
      const px = ox + dx * t - (ax + ex * sSeg), py = oy + dy * t - (ay + ey * sSeg), pz = oz + dz * t - z
      const r = ((u16[i * 16 + SXPV_SEGMENT.widthUm / 2] ?? 400) / 2000) + 2.5 * t * pxAngle
      if (px * px + py * py + pz * pz > r * r) continue
      best = i
      bestT = t
    }
    if (best < 0) return null
    return {
      segment: best,
      layer: layerOfSegment(b, best),
      feature: bytes[best * SXPV_SEGMENT_BYTES + SXPV_SEGMENT.feature] ?? 0,
      tool: bytes[best * SXPV_SEGMENT_BYTES + SXPV_SEGMENT.tool] ?? 0,
      gcodeLine: gcodeLineOf(b, best),
      object: objectOfSegment(b, best),
      point: [ox + dx * bestT, oy + dy * bestT, oz + dz * bestT],
    }
  }

  /** Segment index range [from, to) currently drawn. */
  visibleRange(): [number, number] {
    const b = this.buf
    if (!b) return [0, 0]
    const from = b.layerStart[this.lo] ?? 0
    const layerA = b.layerStart[this.hi] ?? 0
    const layerB = b.layerStart[this.hi + 1] ?? b.segmentCount
    if (this.moveCut === null) return [from, layerB]
    const n = Math.floor(this.moveCut + 1e-6)
    const p = this.partOf(layerA + n, this.moveCut - n, layerB)
    return [from, Math.min(layerB, layerA + n + (p && p.reveal > 0 ? 1 : 0))]
  }

  /** One move from the buffer, as the head path reads it; null outside it. */
  private seg = (i: number): HeadSeg | null => {
    const b = this.buf
    if (!b || i < 0 || i >= b.segmentCount) return null
    const f = new Float32Array(b.raw, b.segmentsOffset + i * SXPV_SEGMENT_BYTES, 5)
    return { x0: f[0] ?? 0, y0: f[1] ?? 0, x1: f[2] ?? 0, y1: f[3] ?? 0, z: f[4] ?? 0 }
  }

  /** The move `index` drawn `f` of the way (0 < f < 1) on the top layer, or null when the cut is at a whole move. */
  private partOf(index: number, f: number, layerB: number): { index: number; f: number; reveal: number } | null {
    if (f <= 1e-6 || f >= 1 - 1e-6 || index >= layerB) return null
    return { index, f, reveal: headAt(this.seg, index, f).reveal }
  }

  private apply(): void {
    const b = this.buf
    if (!b) return
    const [from, to] = this.visibleRange()
    this.updatePart()
    for (const c of this.chunks) {
      const s = Math.max(from, c.start)
      const e = Math.min(to, c.end)
      c.mesh.visible = e > s
      if (e > s) this.bind(c, s - c.start, e - c.start)
    }
    const scrubbing = this.moveCut !== null || this.hi < b.layerCount - 1
    this.uniforms.uCurLayer.value = scrubbing ? this.hi : -1
    this.placeNozzle(from, to)
    this.applyTravels()
    this.applyMarkers()
  }

  /** Points the shader at playback's partly drawn move, or turns that off at a whole move. */
  private updatePart(): void {
    const b = this.buf
    const u = this.uniforms
    this.part = null
    u.uPartFrac.value = 1
    if (!b || this.moveCut === null) return
    const layerA = b.layerStart[this.hi] ?? 0
    const layerB = b.layerStart[this.hi + 1] ?? b.segmentCount
    const n = Math.floor(this.moveCut + 1e-6)
    const p = this.partOf(layerA + n, this.moveCut - n, layerB)
    if (!p) return
    this.part = { index: p.index, f: p.f }
    const s = this.seg(p.index)!
    u.uPartSeg.value.set(s.x0, s.y0, s.x1, s.y1)
    u.uPartZ.value = s.z
    u.uPartFrac.value = p.reveal
  }

  /**
   * Draws the toolhead once, far below the bed, so its shaders, shadow program and buffers exist before the first
   * layer scrub shows it. Without this the first scrubbed frame compiled them (a 200 ms frame). `false` hides it
   * again; the next range change places it as usual.
   */
  warmNozzle(on: boolean): void {
    this.head.warm(on)
  }

  /** The printer family's head for a printer with one nozzle (`headFor` in heads.ts). */
  setHeadModel(model: HeadModel): void {
    this.head.setModel(model)
    this.apply()
  }

  /** The printer's tool changer, so the head and its rack or dock match the machine; null draws the printer's own single head. */
  setToolChanger(spec: ToolChangerSpec | null): void {
    this.changer = spec
    this.changeSeq = null
    this.head.setSpec(spec)
    this.purge.setSpec(spec)
    this.apply()
  }

  /** The printer's gantry, for the beam drawn over the moving head; null draws none. */
  setGantry(spec: GantrySpec | null): void {
    this.gantry.setSpec(spec)
    this.apply()
  }

  /** heimdall's gantry strikes: the beam shows on their layers even with the head hidden, red through the part. */
  setGantryHits(hits: readonly GantryHit[] | null): void {
    this.gantry.setHits(hits)
    this.apply()
  }

  setGantryColor(hit: string): void {
    this.gantry.setColor(hit)
  }

  /** Shows or hides the moving head and its carriage. The machine's fixed parts stay and still follow the print. */
  setShowToolhead(on: boolean): void {
    if (on === this.headOn) return
    this.headOn = on
    this.apply()
  }

  /** Each change's purge, read from the G-code; null when there is none to show. */
  setPurges(plans: readonly PurgePlan[] | null): void {
    this.purges = plans?.length ? new Map(plans.map((p) => [p.segment, p])) : null
    this.apply()
  }

  /**
   * Plays the tool change before `segment` at `seconds` into it (`fixed` is the firmware's own seconds for it,
   * from the playback timeline); null returns the head to the current move.
   */
  setToolChange(c: { segment: number; seconds: number; fixed: number } | null): void {
    this.change = c
    this.apply()
  }

  /** Segments where the tool differs from the one before (the first move of each new tool), in print order. */
  changePoints(): readonly { segment: number; from: number; to: number }[] {
    return this.changes
  }

  /** The change sequence that ends at `segment`, built once per change and reused while it plays. */
  private sequenceFor(segment: number, fixed: number): ChangeSequence | null {
    const b = this.buf
    const spec = this.changer
    if (!b || !spec) return null
    const key = `${segment}:${fixed}`
    if (this.changeSeq && this.changeSeq.key === key) return this.changeSeq.seq
    const idx = this.changes.findIndex((c) => c.segment === segment)
    if (idx < 0) return null
    const c = this.changes[idx]!
    const seq = changeSequence(spec, c.from, c.to, segmentEnd(b, segment - 1), segmentStart(b, segment), fixed, this.changes.slice(0, idx).map((h) => [h.from, h.to]), printedTop(b, segment))
    this.changeSeq = { key, seq }
    return seq
  }

  private placeNozzle(from: number, to: number): void {
    const b = this.buf
    // The rack, dock, chute and wiper show whenever a preview is up; the moving head only while scrubbing.
    const fixtures = !this.ghost && !!b && b.segmentCount > 0
    const moving = fixtures && (this.moveCut !== null || this.hi < b.layerCount - 1) && to > from
    this.head.visible = fixtures
    this.head.headVisible = moving && this.headOn
    this.purge.visible = fixtures
    if (!b || !fixtures) {
      this.gantry.place(false, 0, 0, 0)
      return
    }
    const beam = moving && (this.headOn || this.gantry.striking(this.hi))
    // With nothing drawn yet the machine stands as the print starts.
    to = Math.max(1, Math.min(to, b.segmentCount))
    const bytes = new Uint8Array(b.raw, b.segmentsOffset, b.segmentCount * SXPV_SEGMENT_BYTES)
    const change = this.change && this.change.segment === to ? this.change : null
    const seq = change ? this.sequenceFor(change.segment, change.fixed) : null
    if (seq && change) {
      // The change precedes segment `to`: the head is somewhere on its way; the paths drawn stop before it.
      const pose = poseAt(seq, change.seconds)
      const tool = bytes[to * SXPV_SEGMENT_BYTES + SXPV_SEGMENT.tool] ?? 0
      this.head.place(pose.x, pose.y, pose.z, tool, pose, pose.slots)
      this.placePurge(pose.x, pose.y, pose.z + 0.05, seq, change)
      this.gantry.place(beam, pose.y, pose.z, this.hi)
      return
    }
    const cur = this.part ? this.part.index : to - 1
    const tool = bytes[cur * SXPV_SEGMENT_BYTES + SXPV_SEGMENT.tool] ?? 0
    // Racks keep what the changes so far left in them.
    if (this.changer && this.changer.kind !== 'dual-nozzle' && this.changer.kind !== 'filament-swap') {
      const k = this.changes.filter((c) => c.segment <= to - 1).length
      const last = k > 0 ? this.changes[k - 1]! : null
      // The rack's contents after a change do not depend on the change's seconds, so 0 serves here.
      const seq = last ? this.sequenceFor(last.segment, 0) : null
      this.head.rest(seq ? seq.slotsAfter : null, seq ? seq.rowAfter : 0)
    }
    // Along the move at the head's own pace (playback), else at the last drawn move's end, corners eased.
    const at = this.part ? headAt(this.seg, this.part.index, this.part.f) : headAt(this.seg, to - 1, 1)
    this.head.place(at.x, at.y, at.z, tool, null, null)
    if (this.headOn && this.head.headVisible) this.onHead?.(at.x, at.y, at.z)
    this.placePurge(at.x, at.y, at.z + 0.05, null, null)
    this.gantry.place(beam, at.y, at.z, this.hi)
  }

  /** The chute at the head's height and, inside a change with a purge, the blob; the head's shadow only over the bed. */
  private placePurge(x: number, y: number, z: number, seq: ChangeSequence | null, change: { segment: number; seconds: number } | null): void {
    const plan = change ? this.purges?.get(change.segment) : undefined
    this.purge.place(z, seq && change && plan ? { seq, plan, seconds: change.seconds } : null)
    const bed = this.changer?.bed
    const shadow = this.head.root.getObjectByName('shadow')
    if (shadow) shadow.visible = !bed || (x >= -5 && y >= -5 && x <= bed.widthMm + 5 && y <= bed.depthMm + 5)
  }

  setTravels(on: boolean): void {
    this.travelsOn = on
    if (on && !this.travels) this.buildTravels()
    this.applyTravels()
  }

  private buildTravels(): void {
    const b = this.buf
    if (!b || b.travelsOffset < 0 || !b.travelStart || b.travelCount === 0) return
    const T = b.travelCount
    const src = new Float32Array(b.raw, b.travelsOffset, T * (SXPV_TRAVEL_BYTES / 4))
    const pos = new Float32Array(T * 6)
    for (let k = 0; k < b.layerCount; k++) {
      const z = (b.layerZ[k] ?? 0) + 0.1
      const e = b.travelStart[k + 1] ?? T
      for (let i = b.travelStart[k] ?? 0; i < e; i++) {
        pos[6 * i] = src[4 * i] ?? 0
        pos[6 * i + 1] = src[4 * i + 1] ?? 0
        pos[6 * i + 2] = z
        pos[6 * i + 3] = src[4 * i + 2] ?? 0
        pos[6 * i + 4] = src[4 * i + 3] ?? 0
        pos[6 * i + 5] = z
      }
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(pos, 3))
    const m = new LineBasicMaterial({ color: new Color(this.travelColor), transparent: true, opacity: 0.45, depthWrite: false })
    this.travels = new LineSegments(g, m)
    this.travels.frustumCulled = false
    this.root.add(this.travels)
  }

  private applyTravels(): void {
    const t = this.travels
    const b = this.buf
    if (!t) return
    t.visible = this.travelsOn && !!b
    if (!b || !b.travelStart) return
    const from = b.travelStart[this.lo] ?? 0
    const to = b.travelStart[this.hi + 1] ?? b.travelCount
    t.geometry.setDrawRange(from * 2, Math.max(0, to - from) * 2)
  }

  /** Bed-frame xy bounds from a strided sample of segment starts, and the top z. */
  bounds(): { min: [number, number, number]; max: [number, number, number] } | null {
    const b = this.buf
    if (!b || b.segmentCount === 0) return null
    const S = b.segmentCount
    const f = new Float32Array(b.raw, b.segmentsOffset, S * 8)
    const step = Math.max(1, Math.floor(S / 20000))
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let i = 0; i < S; i += step) {
      const x = f[i * 8] ?? 0
      const y = f[i * 8 + 1] ?? 0
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    return { min: [x0, y0, 0], max: [x1, y1, b.layerZ[b.layerCount - 1] ?? 0] }
  }

  private clearChunks(): void {
    for (const c of this.chunks) {
      c.geo.dispose()
      c.mesh.removeFromParent()
    }
    this.chunks = []
    if (this.travels) {
      this.travels.geometry.dispose()
      ;(this.travels.material as LineBasicMaterial).dispose()
      this.travels.removeFromParent()
      this.travels = null
    }
    this.head.visible = false
    this.purge.visible = false
    this.gantry.place(false, 0, 0, 0)
    this.changes = []
    this.changeSeq = null
  }

  dispose(): void {
    this.clearChunks()
    this.extras = null
    this.buildMarkers()
    this.base.dispose()
    this.material.dispose()
    this.depthMaterial.dispose()
    this.uniforms.uFeatureLut.value.dispose()
    this.uniforms.uToolLut.value.dispose()
    this.uniforms.uRamp.value.dispose()
    this.uniforms.uLayerLut.value.dispose()
    this.head.dispose()
    this.purge.dispose()
    this.gantry.dispose()
  }
}

/** Where segment `i` starts and ends (x, y, z), mm. */
function segmentStart(b: PreviewBuffers, i: number): V3 {
  const f = new Float32Array(b.raw, b.segmentsOffset + Math.max(0, Math.min(b.segmentCount - 1, i)) * SXPV_SEGMENT_BYTES, 5)
  return [f[0] ?? 0, f[1] ?? 0, f[4] ?? 0]
}
function segmentEnd(b: PreviewBuffers, i: number): V3 {
  const f = new Float32Array(b.raw, b.segmentsOffset + Math.max(0, Math.min(b.segmentCount - 1, i)) * SXPV_SEGMENT_BYTES, 5)
  return [f[2] ?? 0, f[3] ?? 0, f[4] ?? 0]
}

/** Segments where the tool byte differs from the segment before, in order. */
export function changePoints(b: PreviewBuffers): { segment: number; from: number; to: number }[] {
  const out: { segment: number; from: number; to: number }[] = []
  if (b.toolCount < 2) return out
  const bytes = new Uint8Array(b.raw, b.segmentsOffset, b.segmentCount * SXPV_SEGMENT_BYTES)
  let prev = bytes[SXPV_SEGMENT.tool] ?? 0
  for (let i = 1; i < b.segmentCount; i++) {
    const t = bytes[i * SXPV_SEGMENT_BYTES + SXPV_SEGMENT.tool] ?? 0
    if (t !== prev) {
      out.push({ segment: i, from: prev, to: t })
      prev = t
    }
  }
  return out
}
