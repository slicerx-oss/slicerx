// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The single-nozzle toolheads Preview draws at the current move, one per printer family, after the
// machines' product photos (sources in docs/toolchanger-sim.md, "The models"). Low poly: every part is a
// separate solid in millimeters, nozzle tip at the origin, z up, the front of the printer toward -y. Parts
// that meet only touch (test/toolhead.test.ts checks every head). Each head shows the printing filament on
// the filament inlet at its top, or on the H2S's nozzle display.
import { Color, ConeGeometry, CylinderGeometry, Group, MeshBasicMaterial, MeshStandardMaterial, type Material, type Mesh } from 'three'
import { amber, black, brass, deep, graphite, hotPlate, lightMat, part, post, prusaOrange, ring, silver, slab, sock, steel, white } from './headparts'

/** The head families Preview draws for printers with one nozzle. */
export const HEAD_MODELS = [
  'bambu-x1',
  'bambu-p1',
  'bambu-a1',
  'bambu-h2s',
  'prusa-nextruder',
  'prusa-mini',
  'voron-stealthburner',
  'sovol-sv08',
  'creality-k1',
  'creality-k2',
  'creality-ender3-v3',
  'creality-sprite',
  'elegoo-centauri',
  'elegoo-neptune4',
  'anycubic-kobra',
  'qidi',
  'snapmaker-module',
  'generic',
] as const
export type HeadModel = (typeof HEAD_MODELS)[number]

/** The head family for a printer profile id (`bambu-p1s`, `voron-2.4-350`); `generic` when none is close. */
export function headFor(printerId: string | undefined | null): HeadModel {
  const id = (printerId ?? '').toLowerCase()
  const table: [RegExp, HeadModel][] = [
    [/^bambu-x1/, 'bambu-x1'],
    [/^bambu-(p1|p2)/, 'bambu-p1'],
    [/^bambu-a1/, 'bambu-a1'],
    [/^bambu-h2/, 'bambu-h2s'],
    [/^bambu-/, 'bambu-p1'],
    [/^prusa-(mk4|mk3\.9|core-one|xl)/, 'prusa-nextruder'],
    [/^prusa-mini/, 'prusa-mini'],
    [/^prusa-/, 'prusa-nextruder'],
    [/^(voron-|vzbot|ratrig)/, 'voron-stealthburner'],
    [/^sovol-sv08/, 'sovol-sv08'],
    [/^creality-(k1|hi)/, 'creality-k1'],
    [/^creality-k2/, 'creality-k2'],
    [/^creality-ender-3-v3(-plus)?$/, 'creality-ender3-v3'],
    [/^creality-/, 'creality-sprite'],
    [/^elegoo-centauri/, 'elegoo-centauri'],
    [/^elegoo-/, 'elegoo-neptune4'],
    [/^anycubic-/, 'anycubic-kobra'],
    [/^qidi-/, 'qidi'],
    [/^snapmaker-(a250|a350|artisan|j1)/, 'snapmaker-module'],
  ]
  return table.find(([re]) => re.test(id))?.[1] ?? 'generic'
}

// Machine colors (not app tokens): the plastics and paints the printers ship in.
const bambuGray = new MeshStandardMaterial({ color: new Color('#aeb1b8'), metalness: 0.2, roughness: 0.45 })
const a1Gray = new MeshStandardMaterial({ color: new Color('#c3c6cc'), metalness: 0.15, roughness: 0.5 })
const gunmetal = new MeshStandardMaterial({ color: new Color('#555963'), metalness: 0.45, roughness: 0.4 })
const voronRed = new MeshStandardMaterial({ color: new Color('#c8312c'), metalness: 0.05, roughness: 0.5 })
const sovolBlue = new MeshStandardMaterial({ color: new Color('#86a9d4'), metalness: 0.05, roughness: 0.5 })
const enderSilver = new MeshStandardMaterial({ color: new Color('#b6b9bf'), metalness: 0.5, roughness: 0.35 })
const caution = new MeshStandardMaterial({ color: new Color('#f2c230'), metalness: 0.05, roughness: 0.5 })
const lidarGreen = new MeshBasicMaterial({ color: new Color('#3fd27a') })
const labelOrange = new MeshBasicMaterial({ color: new Color('#f26b21') })

export interface BuiltHead {
  group: Group
  /** Painted in the printing filament's color. */
  sleeve: Mesh
  /** Radius of the soft shadow under the head. */
  shadow: number
}

/** The nozzle under a silicone sock, tip at the origin, with the ring that marks the extrusion point. */
function nozzle(g: Group, sockHalf = 5, sockTop = 8): void {
  g.add(part(new ConeGeometry(1.6, 3, 24).rotateX(-Math.PI / 2), brass, 0, 0, 1.5, 'nozzle'), slab(sock, -sockHalf, sockHalf, -sockHalf, sockHalf, 3, sockTop, 'sock', 1.2))
  ring(g)
}

/** A round fan on a front face at y = `face`, centered at (x, z): the dark disc and the hub in front of it. */
function frontFan(g: Group, face: number, x: number, z: number, r: number, hubMat: Material = graphite): void {
  g.add(part(new CylinderGeometry(r, r, 1, 48), deep, x, face - 0.5, z, 'fan'), part(new CylinderGeometry(r * 0.32, r * 0.32, 1, 32), hubMat, x, face - 1.5, z, 'hub'))
}

/** The filament inlet on top of the head, in the filament's color. */
function inlet(g: Group, z: number, y = 0, h = 8): Mesh {
  const m = part(post(2.2, h, 20), steel, 0, y, z + h / 2, 'inlet')
  g.add(m)
  return m
}

/** Two part cooling outlets either side of the nozzle, under a body that starts at `z`. */
function sidePods(g: Group, z: number, mat: Material = black, half = 16, y0 = -15, y1 = 12): void {
  g.add(slab(mat, -half, -7, y0, y1, z - 6, z, 'duct', 1.5), slab(mat, 7, half, y0, y1, z - 6, z, 'duct', 1.5))
}

/** X1 Carbon, X1E (with the Micro Lidar) and P1P, P1S, P2S: a black head behind a light gray front with the round part cooling fan. */
function bambuX1(lidar: boolean): BuiltHead {
  const g = new Group()
  nozzle(g)
  g.add(
    slab(black, -26, 26, -20, 26, 8, 20, 'base', 2),
    slab(black, -28, 28, -16, 30, 20, 88, 'body', 4),
    slab(bambuGray, -28, 28, -25, -16, 20, 86, 'cover', 4.4),
    slab(deep, -11, 11, -25.4, -25, 76, 78.5, 'label'),
  )
  frontFan(g, -25, 0, 50, 17)
  if (lidar) g.add(slab(graphite, 28, 46, -24, -4, 4, 19.5, 'lidar', 1.5), slab(lidarGreen, 33, 43, -24.4, -24, 11, 13, 'lidar lens'))
  return { group: g, sleeve: inlet(g, 88, 6), shadow: 30 }
}

/**
 * A1 and A1 mini, estimated from Bambu's product photos: a low, wide light gray head (the hotend housing and its clip
 * under it, the round extruder window in front) with the cable chain leaving its left side, link by link, for the
 * frame.
 */
function bambuA1(): BuiltHead {
  const g = new Group()
  nozzle(g)
  g.add(
    slab(graphite, -15, 15, -14, 12, 8, 18, 'housing', 2),
    slab(steel, 15, 18, -10, 4, 9, 17, 'clip', 1),
    slab(a1Gray, -30, 30, -16, 22, 18, 60, 'body', 5),
    part(new CylinderGeometry(9, 9, 1, 40), deep, 10, -16.5, 42, 'window'),
    part(new CylinderGeometry(5.5, 5.5, 1, 32), amber, 10, -17.5, 42, 'gear'),
    slab(deep, -22, -8, -16.4, -16, 44, 46.5, 'label'),
  )
  // The cable chain: dark links stepping out and up from the left side.
  for (let i = 0; i < 5; i++) g.add(slab(deep, -30 - 7 * (i + 1), -30 - 7 * i, -4, 14, 40 + 3 * i, 48 + 3 * i, 'cable chain', 1))
  return { group: g, sleeve: inlet(g, 60, 6), shadow: 30 }
}

/** H2S: the H2 family head with one hotend: brushed cover over a black body, the nozzle display and the hot plate. */
function bambuH2S(): BuiltHead {
  const g = new Group()
  nozzle(g, 5, 7.8)
  const chip = slab(steel, 4, 7.2, -18.3, -18, 49.5, 52, 'chip')
  g.add(
    slab(black, -14, 14, -17, 17, 7.8, 58.5, 'body', 2),
    slab(black, -20, -14, -12, 14, 14, 58.5, 'fan', 2),
    slab(black, 14, 20, -12, 14, 14, 58.5, 'fan', 2),
    slab(deep, -8, 6, -18, -17, 48, 53.5, 'display'),
    chip,
    hotPlate(0, -17, 28),
    slab(deep, -18, 18, -15, 15, 58.5, 62, 'band'),
    slab(silver, -20, 20, -17, 17, 62, 92, 'cover', 5),
    slab(lightMat, -12, 12, -17.5, -17, 86, 87.4, 'light'),
    slab(steel, -10, 10, -17.4, -17, 70, 72.5, 'logo'),
  )
  return { group: g, sleeve: chip, shadow: 22 }
}

/** Prusa Nextruder (MK4, MK4S, Core One, XL): black, the planetary extruder on top with its label, the hotend fan in front, the blower at the side. */
function nextruder(): BuiltHead {
  const g = new Group()
  nozzle(g, 6, 10)
  g.add(
    slab(black, -20, 20, -18, 18, 10, 52, 'body', 3),
    slab(black, -14, 18, -22, -18, 18, 46, 'fan frame', 2),
    slab(black, -30, -20, -14, 16, 14, 46, 'blower', 3),
    slab(black, -24, -8, -16, -8, 6, 10, 'outlet', 1.5),
    slab(black, -20, 20, -14, 22, 52, 88, 'extruder', 3),
    slab(deep, -14, 14, -14.6, -14, 62, 84, 'plate'),
    slab(labelOrange, -10, 10, -14.9, -14.6, 70, 74, 'label'),
    slab(black, -6, 6, -10, 4, 88, 96, 'lever', 1.5),
  )
  frontFan(g, -22, 2, 32, 12)
  return { group: g, sleeve: inlet(g, 96, -3, 6), shadow: 24 }
}

/** Prusa MINI+: the orange printed shroud with its front fan, the black blower at the side, the extruder on top. */
function prusaMini(): BuiltHead {
  const g = new Group()
  nozzle(g, 5, 7)
  g.add(
    slab(steel, -8, 8, -6, 6, 7, 11, 'heater', 1),
    slab(prusaOrange, -18, 18, -16, 14, 11, 56, 'shroud', 3),
    slab(black, 18, 28, -12, 12, 16, 46, 'blower', 2),
    slab(black, 8, 22, -14, -6, 4, 11, 'outlet', 1),
    slab(black, -14, 14, -10, 16, 56, 76, 'extruder', 2),
  )
  frontFan(g, -16, 0, 34, 11, black)
  return { group: g, sleeve: inlet(g, 76, 3, 10), shadow: 20 }
}

/** Voron Stealthburner (and the SV08's head built on it): the faceted accent cover with the lit logo, the hotend fan, two ducts, the Clockwork extruder and its pancake motor. */
function stealthburner(accent: Material): BuiltHead {
  const g = new Group()
  nozzle(g, 6, 9)
  g.add(
    slab(black, -24, 24, -12, 22, 9, 40, 'body', 3),
    slab(accent, -24, 24, -20, -12, 12, 40, 'front', 3),
    slab(black, -24, -10, -20, -12, 4, 12, 'duct', 1.5),
    slab(black, 10, 24, -20, -12, 4, 12, 'duct', 1.5),
    slab(accent, -22, 22, -18, 10, 40, 72, 'cover', 4),
    slab(black, -22, 22, 10, 26, 40, 72, 'back', 3),
    slab(lightMat, -1.5, 1.5, -18.4, -18, 54, 66, 'logo'),
    slab(lightMat, -6, -3, -18.4, -18, 58, 62, 'logo'),
    slab(black, -12, 12, -8, 18, 72, 84, 'extruder', 2),
    part(new CylinderGeometry(14, 14, 10, 40), black, 0, 31, 58, 'motor'),
  )
  frontFan(g, -20, 0, 26, 12)
  return { group: g, sleeve: inlet(g, 84, 4, 8), shadow: 26 }
}

/** Creality K1, K1C, K1 Max, K1 SE, Hi: a black head behind a dark front with a large round fan and the label. */
function crealityK1(): BuiltHead {
  const g = new Group()
  nozzle(g)
  sidePods(g, 10, black, 18)
  g.add(
    slab(black, -24, 24, -18, 24, 10, 70, 'body', 4),
    slab(deep, -24, 24, -22, -18, 12, 70, 'cover', 1.8),
    slab(steel, -9, 9, -22.4, -22, 62, 64.5, 'label'),
  )
  frontFan(g, -22, 0, 40, 14, steel)
  return { group: g, sleeve: inlet(g, 70, 4), shadow: 26 }
}

/** Creality K2 Plus: the larger gunmetal head with a black front, a vertical light and the round fan. */
function crealityK2(): BuiltHead {
  const g = new Group()
  nozzle(g)
  sidePods(g, 10, black, 20)
  g.add(
    slab(gunmetal, -27, 27, -20, 26, 10, 82, 'body', 4),
    slab(black, -24, 24, -24, -20, 14, 78, 'front', 1.8),
    slab(lightMat, -1, 1, -24.4, -24, 54, 74, 'light'),
  )
  frontFan(g, -24, 0, 34, 12)
  return { group: g, sleeve: inlet(g, 82, 4), shadow: 28 }
}

/** Creality Ender-3 V3 and V3 Plus: a rounded silver head with the big round fan and two cooling pods, the extruder on top. */
function enderV3(): BuiltHead {
  const g = new Group()
  nozzle(g)
  sidePods(g, 14, graphite, 21, -16, 14)
  g.add(slab(enderSilver, -21, 21, -18, 20, 14, 68, 'body', 5), slab(black, -14, 14, -8, 18, 68, 82, 'extruder', 2))
  frontFan(g, -18, 0, 42, 14, steel)
  return { group: g, sleeve: inlet(g, 82, 5), shadow: 22 }
}

/** Creality Sprite heads (Ender-3 V3 SE and KE, older Enders): black, a yellow caution label, the round fan, the label strip. */
function crealitySprite(): BuiltHead {
  const g = new Group()
  nozzle(g)
  sidePods(g, 12, black, 18)
  g.add(
    slab(black, -20, 20, -18, 20, 12, 70, 'body', 3),
    slab(caution, -5, 5, -18.4, -18, 54, 61, 'caution'),
    slab(steel, -9, 9, -18.4, -18, 64, 66, 'label'),
  )
  frontFan(g, -18, 0, 34, 12)
  return { group: g, sleeve: inlet(g, 70, 4), shadow: 22 }
}

/** Elegoo Centauri Carbon: a black head with a gunmetal front, the round fan and the nozzle light under it. */
function elegooCentauri(): BuiltHead {
  const g = new Group()
  nozzle(g)
  sidePods(g, 10, black, 18)
  g.add(
    slab(black, -24, 24, -18, 24, 10, 72, 'body', 4),
    slab(gunmetal, -24, 24, -22, -18, 12, 72, 'cover', 1.8),
    slab(lightMat, -8, 8, -22.4, -22, 14, 15.5, 'light'),
    slab(steel, -8, 8, -22.4, -22, 64, 66, 'label'),
  )
  frontFan(g, -22, 0, 40, 13)
  return { group: g, sleeve: inlet(g, 72, 4), shadow: 26 }
}

/** Elegoo Neptune 4 family: an angular gray head with the hotend fan in front and a big blower on each side. */
function neptune4(): BuiltHead {
  const g = new Group()
  nozzle(g)
  g.add(
    slab(gunmetal, -20, 20, -16, 22, 14, 66, 'body', 3),
    slab(black, -32, -20, -14, 14, 10, 40, 'blower', 3),
    slab(black, 20, 32, -14, 14, 10, 40, 'blower', 3),
    slab(black, -24, -8, -12, 8, 4, 10, 'outlet', 1),
    slab(black, 8, 24, -12, 8, 4, 10, 'outlet', 1),
    slab(steel, -6, 6, -16.4, -16, 56, 59, 'logo'),
  )
  frontFan(g, -16, 0, 38, 11)
  return { group: g, sleeve: inlet(g, 66, 4), shadow: 26 }
}

/** Anycubic Kobra 3 and Kobra X: a black head with a graphite front, the round fan and the white name on top. */
function anycubic(): BuiltHead {
  const g = new Group()
  nozzle(g)
  sidePods(g, 12, black, 17)
  g.add(slab(black, -22, 22, -18, 22, 12, 70, 'body', 4), slab(graphite, -20, 20, -21, -18, 16, 56, 'front', 1.4), slab(white, -12, 12, -18.4, -18, 62, 64.5, 'label'))
  frontFan(g, -21, 0, 36, 12)
  return { group: g, sleeve: inlet(g, 70, 4), shadow: 24 }
}

/** QIDI Q1 Pro and X-Plus 4: a black head with a slotted vent, the white name and a blower on the right. */
function qidi(): BuiltHead {
  const g = new Group()
  nozzle(g)
  sidePods(g, 12, black, 17)
  g.add(slab(black, -22, 22, -18, 22, 12, 72, 'body', 4), slab(black, 22, 32, -14, 14, 16, 46, 'blower', 3), slab(white, -10, 10, -18.4, -18, 64, 66.5, 'label'))
  for (let i = 0; i < 5; i++) g.add(slab(deep, -14, 14, -18.4, -18, 24 + i * 6, 27 + i * 6, 'vent'))
  return { group: g, sleeve: inlet(g, 72, 4), shadow: 24 }
}

/** Snapmaker A250, A350, Artisan: the 3D printing module, a black aluminium box with a brushed top band and the fan grille. */
function snapmakerModule(): BuiltHead {
  const g = new Group()
  nozzle(g)
  g.add(slab(black, -26, 26, -20, 24, 8, 66, 'body', 2.5), slab(silver, -26, 26, -20, 24, 66, 74, 'band', 1.5), slab(white, -10, 10, -20.4, -20, 58, 60.5, 'label'))
  for (let i = 0; i < 6; i++) g.add(slab(deep, -14, 14, -20.4, -20, 16 + i * 6, 18.5 + i * 6, 'grille'))
  return { group: g, sleeve: inlet(g, 74, 6), shadow: 28 }
}

/** Every other printer: a tidy graphite head with a front fan, two cooling pods and the extruder on top. */
function generic(): BuiltHead {
  const g = new Group()
  nozzle(g)
  sidePods(g, 12, black, 17)
  g.add(slab(graphite, -20, 20, -16, 20, 12, 60, 'body', 4), slab(black, -12, 12, -8, 16, 60, 72, 'extruder', 2))
  frontFan(g, -16, 0, 34, 11)
  return { group: g, sleeve: inlet(g, 72, 4), shadow: 22 }
}

/** The head for `model`. */
export function buildHead(model: HeadModel): BuiltHead {
  switch (model) {
    case 'bambu-x1':
      return bambuX1(true)
    case 'bambu-p1':
      return bambuX1(false)
    case 'bambu-a1':
      return bambuA1()
    case 'bambu-h2s':
      return bambuH2S()
    case 'prusa-nextruder':
      return nextruder()
    case 'prusa-mini':
      return prusaMini()
    case 'voron-stealthburner':
      return stealthburner(voronRed)
    case 'sovol-sv08':
      return stealthburner(sovolBlue)
    case 'creality-k1':
      return crealityK1()
    case 'creality-k2':
      return crealityK2()
    case 'creality-ender3-v3':
      return enderV3()
    case 'creality-sprite':
      return crealitySprite()
    case 'elegoo-centauri':
      return elegooCentauri()
    case 'elegoo-neptune4':
      return neptune4()
    case 'anycubic-kobra':
      return anycubic()
    case 'qidi':
      return qidi()
    case 'snapmaker-module':
      return snapmakerModule()
    default:
      return generic()
  }
}
