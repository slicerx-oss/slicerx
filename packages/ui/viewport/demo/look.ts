// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Look lab: one still of a lab scene in a candidate look, for side by side picks.
// Query: scene (organic, mech, dark), look (current, A to D), studio (dark, light), tab (model, slice), cam (preset name).
// Sets window.__lookReady once the still frame has settled.
import type { Bed, ViewportTheme } from '../src/index'
import { createViewport } from '../src/index'
import { SphericalHarmonics3, Vector3 } from 'three'
import { subbanLight } from '../../src/themes'
import { labParts, type LabScene } from './look-models'
import { LOOKS, applyLook, type LookId, type Studio } from './looks'

declare global {
  interface Window {
    __lookReady?: boolean
    __lookInfo?: unknown
  }
}

const q = new URLSearchParams(location.search)
const scene = (q.get('scene') ?? 'organic') as LabScene
const base = LOOKS[(q.get('look') ?? 'current') as LookId] ?? LOOKS.current
// p: a JSON patch on the look, for tuning (shallow per top-level key, objects merged one level down)
const patch = JSON.parse(q.get('p') ?? '{}') as Record<string, unknown>
const look = { ...base } as Record<string, unknown>
for (const [k, v] of Object.entries(patch)) look[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(look[k] as object), ...v } : v
const studio = (q.get('studio') ?? 'dark') as Studio
const tab = q.get('tab') ?? 'slice'

function lightTheme(): ViewportTheme {
  const s = subbanLight.scene!
  const c = subbanLight.colors
  return {
    scene: {
      ...(s.top ? { bgTop: s.top } : {}),
      ...(s.bottom ? { bgBottom: s.bottom } : {}),
      ...(s.glow ? { bgGlow: s.glow } : {}),
      ...(s.plate ? { plateSide: s.plate } : {}),
      ...(s.grid ? { floorGrid: s.grid } : {}),
      ...(s.edge ? { edgeDark: s.edge } : {}),
      ...(s.xray ? { edgeXray: s.xray } : {}),
      selection: c.purple,
      liveLayer: c.cyan,
    },
  }
}

const canvas = document.getElementById('vp') as HTMLCanvasElement
const vp = createViewport(canvas, { quality: 'high', maxPixelRatio: 2, adaptive: false, reveal: false, ...(studio === 'light' ? { theme: lightTheme() } : {}) })
const bed: Bed = { widthMm: 256, depthMm: 256, heightMm: 256 }
const parts = labParts(scene)
vp.setPlate({
  bed,
  surfaceLabel: 'Textured PEI',
  objects: parts.map((p, i) => ({
    id: `p${i}`,
    name: p.name,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p.at[0], p.at[1], 0, 1],
    parts: [{ name: p.name, positions: p.positions, indices: p.indices, color: p.color, finish: 'basic' }],
  })),
})
vp.setMode('prepare')
vp.setRenderMode(tab === 'model' ? 'cad' : 'studio')

// one camera per scene, the same for every look
const CAMS: Record<LabScene, { target: [number, number, number]; azimuthDeg: number; elevationDeg: number; distanceMm: number }> = {
  organic: { target: [128, 128, 36], azimuthDeg: -24, elevationDeg: 20, distanceMm: 400 },
  mech: { target: [140, 105, 14], azimuthDeg: -32, elevationDeg: 34, distanceMm: 250 },
  dark: { target: [145, 118, 34], azimuthDeg: -28, elevationDeg: 26, distanceMm: 360 },
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function settle(): Promise<void> {
  for (let i = 0; i < 600; i++) {
    const s = vp.stats()
    if (s.refiningParts === 0 && !s.cameraMoving && s.firstDrawMs !== null) return
    await sleep(50)
  }
}

void (async () => {
  vp.setCamera(CAMS[scene], { animate: false })
  await settle()
  // a slow first build can frame the plate after the first call, so set the view again once it has settled
  vp.setCamera(CAMS[scene], { animate: false })
  await settle()
  await sleep(600)
  const t0 = performance.now()
  applyLook(vp, look as unknown as typeof base, studio)
  await sleep(900)
  // the still frame: AO at full quality once the view has stopped
  applyLook(vp, look as unknown as typeof base, studio)
  await sleep(900)
  const s = vp.stats()
  // the room environment's light: average radiance, and irradiance on faces pointing up and sideways
  const shc = (vp as unknown as { stage: { envSH: Vector3[] | null } }).stage.envSH
  let env: unknown = null
  if (shc) {
    const sh = new SphericalHarmonics3().set(shc)
    const v = (d: Vector3) => Math.round(sh.getIrradianceAt(d, new Vector3()).y * 1000) / 1000
    env = { avg: Math.round(shc[0]!.y * 0.282095 * 1000) / 1000, up: v(new Vector3(0, 1, 0)), side: v(new Vector3(1, 0, 0)), down: v(new Vector3(0, -1, 0)) }
  }
  window.__lookInfo = { env, gpu: s.gpu, quality: s.quality, pixelRatio: s.pixelRatio, width: s.width, height: s.height, aoOn: s.aoOn, applyMs: Math.round(performance.now() - t0) }
  window.__lookReady = true
})()
