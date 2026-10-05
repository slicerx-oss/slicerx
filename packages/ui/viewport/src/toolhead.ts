// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The toolhead Preview draws at the current move, and the printer's tool changer around it, after the real
// machines (product photos and the Bambu wiki; see docs/toolchanger-sim.md):
// - H2D and H2C: a brushed silver upper cover over a black lower body; the left hotend sits behind a
//   black front with the nozzle display and the "hot" plate, side housings hold the cooling fans. On the
//   H2C the right side is an open bay a Vortek hotend plugs into from below.
// - Vortek hotend: a slim black shaft with a rounded nozzle end, a collar the rack holds it by, and a
//   head block in the filament's color.
// - H2C rack: a black frame on the right wall, two rows of three holders with a white light each.
// - U1: black toolheads with an orange lever and the extruder motor at the back, hung by their coupling face
//   on the back of a white carriage and parked in a dock along the back of the frame.
// - UltiMaker S series: the white head with the front fan bracket and its grille, the side fan brackets and
//   their vents, two print cores in a cavity between them (the right one on the lift switch), the Bowden
//   tubes and the head cable on top, the lift switch lever on the right side, and the switch bay on the
//   right wall it runs into.
// Poses come from `toolchanger.ts`.
//
// Every part is a separate solid in millimeters, nozzle tip at the origin, z up, +y toward the back of the
// printer. Parts that meet only touch, so nothing flickers where two faces would share a plane, and the
// clearances keep the head out of the rack and dock through a whole change (test/toolhead.test.ts):
// - a Vortek hotend is 58 mm tall; its collar (z 30 to 32.5, r 5.5) rests on its holder's fork;
// - the head's bay is open at the back, the right and below, so a hotend leaves it by any of the moves
//   the sequence makes; the rest of the head stays 17 mm either side of the nozzles in y, 10 mm right of
//   the right nozzle in x, under 92 mm, so the other row (96 mm away) and the neighbors pass it by;
// - a U1 toolhead's coupling face is 1.5 mm behind the carriage, and the dock starts 1.5 mm behind the
//   toolhead's motor.
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
  type Material,
} from 'three'
import { displayHex } from './palette'
import { amber, black, block, brass, dark, deep, graphite, hotPlate, lightMat, part, post, prusaOrange, ring, silver, slab, sock, steel, white } from './headparts'
import { buildHead, type HeadModel } from './heads'
import { rackStateBefore, type Pose, type ToolChangerSpec } from './toolchanger'

/** Dimensions, mm. */
export const HOTEND = { collarZ: 30, collarR: 5.5, shaftR: 3.2, top: 58 } as const
export const HEAD = { bayTop: 58.5, front: -17, back: 17, top: 92, right: 10 } as const
export const RACK = { tineZ: [27.5, 30] as const, tineX: [-10, 8] as const, tineY: 5, holderX: [8, 18] as const } as const

/** A Vortek hotend, tip at the origin: silver tip, rounded nozzle end, slim shaft, the collar a holder grips, a head block in the filament color. */
function buildVortek(withRing: boolean): { group: Group; sleeve: Mesh } {
  const g = new Group()
  g.name = 'hotend'
  const head = slab(steel, -6, 6, -5, 5, 40, 50, 'label', 1)
  g.add(
    part(new ConeGeometry(1.3, 2.2, 24).rotateX(-Math.PI / 2), steel, 0, 0, 1.1, 'tip'),
    part(new CylinderGeometry(4.2, 3.0, 5, 28).rotateX(Math.PI / 2), black, 0, 0, 4.7, 'bulb'),
    part(post(HOTEND.shaftR, 22.8), black, 0, 0, 18.6, 'shaft'),
    part(post(HOTEND.collarR, 2.5, 40), steel, 0, 0, 31.25, 'collar'),
    part(post(HOTEND.shaftR, 7.5), black, 0, 0, 36.25, 'neck'),
    head,
    slab(black, -6, 6, -5, 5, 50, 55, 'cap', 1),
    part(post(1.8, 3, 16), steel, 0, 0, 56.5, 'inlet'),
  )
  if (withRing) ring(g)
  return { group: g, sleeve: head }
}

/** A fixed hotend as the head shows it: the nozzle under its silicone sock; the rest is inside the body. */
function buildFixedHotend(): Group {
  const g = new Group()
  g.name = 'hotend'
  g.add(part(new ConeGeometry(1.6, 3, 24).rotateX(-Math.PI / 2), brass, 0, 0, 1.5, 'nozzle'), slab(sock, -5, 5, -5, 5, 3, 7.8, 'sock', 1.2))
  ring(g)
  return g
}

/** The soft shadow the head throws on the path it just laid. */
function buildShadow(radius: number): Mesh {
  const sc = typeof document !== 'undefined' ? document.createElement('canvas') : null
  if (sc) sc.width = sc.height = 64
  const sx = sc?.getContext('2d')
  if (sx) {
    const g = sx.createRadialGradient(32, 32, 2, 32, 32, 32)
    g.addColorStop(0, 'rgba(0,0,0,.5)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    sx.fillStyle = g
    sx.fillRect(0, 0, 64, 64)
  }
  const shadow = new Mesh(new CircleGeometry(radius, 32), new MeshBasicMaterial({ map: sc ? new CanvasTexture(sc) : null, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }))
  shadow.name = 'shadow'
  shadow.position.z = -0.02
  return shadow
}


/**
 * The H2D and H2C head around nozzles `spacing` apart. `bay` leaves the right side open for a Vortek hotend
 * (H2C); without it the right side mirrors the left (H2D). The display chip shows the printing filament.
 */
function buildBambuHead(spacing: number, bay: boolean): { group: Group; left: Group; right: Group; rightSleeve: Mesh | null; chip: Mesh } {
  const g = new Group()
  const s = spacing / 2
  const { front: f, back: b, top, bayTop } = HEAD
  const xl = -s - 13
  const xr = s + HEAD.right
  const left = buildFixedHotend()
  left.position.x = -s
  let right: Group
  let rightSleeve: Mesh | null = null
  if (bay) {
    const v = buildVortek(true)
    right = v.group
    rightSleeve = v.sleeve
  } else right = buildFixedHotend()
  right.position.x = s
  const chip = slab(steel, -8.2, -5, f - 1.3, f - 1, 49.5, 52, 'chip')
  g.add(
    left,
    right,
    // Lower body: the left hotend's housing with the display and the hot plate on its front, a fan housing at the side.
    slab(black, xl, -s + 13, f, b, 8, bayTop, 'body', 2),
    slab(black, xl - 6, xl, f + 5, b - 3, 14, bayTop, 'fan', 2),
    slab(deep, -s - 9, -s + 5, f - 1, f, 48, 53.5, 'display'),
    chip,
    hotPlate(-s, f, 28),
  )
  if (bay) {
    // The bay: a front wall over the hotend's head block; open at the back, the right and below.
    g.add(slab(black, -s + 13, xr, f, -7, 34, bayTop, 'bay front', 2))
  } else {
    g.add(slab(black, -s + 13, -xl, f, b, 8, bayTop, 'body', 2), slab(black, -xl, -xl + 6, f + 5, b - 3, 14, bayTop, 'fan', 2), hotPlate(s, f, 28))
  }
  const xr2 = bay ? xr : -xl + 6
  g.add(
    // A recessed seam between the body and the cover.
    slab(deep, xl - 4, xr2 - 2, f + 2, b - 2, bayTop, 62, 'band'),
    // The brushed cover with its light strip along the top and the logo plate.
    slab(silver, xl - 6, xr2, f, b, 62, top, 'cover', 5),
    slab(lightMat, xl + 4, xr2 - 10, f - 0.5, f, top - 6, top - 4.6, 'light'),
    slab(steel, -10, 10, f - 0.4, f, 70, 72.5, 'logo'),
  )
  return { group: g, left, right, rightSleeve, chip }
}

/**
 * Prusa XL toolhead (a Nextruder on its own board), tip at the origin: the black body with the hotend fan on
 * its front, the side blower, the extruder on top with the filament inlet, a band in the filament color and the
 * orange label. It couples to the carriage at its front face.
 */
export const XL = { tool: { front: -8, back: 42, half: 27, top: 84 }, carriage: [-22, -9] as const } as const
function buildXlTool(): { group: Group; band: Mesh } {
  const g = new Group()
  g.name = 'toolhead'
  const band = slab(steel, -27.4, -27, 0, 30, 30, 70, 'band')
  g.add(
    part(new ConeGeometry(1.6, 3, 24).rotateX(-Math.PI / 2), brass, 0, 0, 1.5, 'nozzle'),
    slab(sock, -6, 6, -6, 6, 3, 10, 'sock', 1.5),
    slab(black, -XL.tool.half, XL.tool.half, XL.tool.front, XL.tool.back, 10, 58, 'body', 3),
    slab(black, -22, 22, -4, 38, 58, XL.tool.top, 'extruder', 3),
    slab(deep, -14, 14, -8.4, -8, 20, 48, 'fan'),
    slab(prusaOrange, -12, 12, -4.4, -4, 66, 72, 'label'),
    slab(black, 27, 34, -2, 30, 14, 46, 'blower', 2),
    band,
    part(post(2.2, 6, 16), steel, 0, 18, XL.tool.top + 3, 'inlet'),
  )
  return { group: g, band }
}

/** A U1 toolhead, tip at the origin: black body, nozzle under its sock, the orange lever, the extruder motor at the back, the coupling face at the front. */
function buildU1Toolhead(): { group: Group; mark: Mesh } {
  const g = new Group()
  g.name = 'toolhead'
  const mark = slab(steel, -14, 14, -6.6, -6, 66.5, 69, 'mark')
  g.add(
    part(new ConeGeometry(1.6, 3, 24).rotateX(-Math.PI / 2), brass, 0, 0, 1.5, 'nozzle'),
    slab(sock, -6, 6, -6, 6, 3, 9, 'sock', 1.5),
    slab(black, -20, 20, -6, 40, 10, 72, 'body', 3),
    // The coupling face: the fan opening low down, the label, the yellow line, the steel balls.
    slab(deep, -9, 9, -6.5, -6, 12, 23, 'fan'),
    slab(amber, -3, 3, -6.5, -6, 40, 46, 'label'),
    mark,
    part(new CylinderGeometry(2, 2, 0.6, 20), steel, -12, -6.3, 58, 'ball'),
    part(new CylinderGeometry(2, 2, 0.6, 20), steel, 12, -6.3, 58, 'ball'),
    slab(amber, 20, 23, 2, 14, 40, 56, 'lever', 1),
    part(new CylinderGeometry(16, 16, 12, 36), black, 0, 46, 50, 'motor'),
    part(new CylinderGeometry(11, 11, 1.5, 36), graphite, 0, 52.75, 50, 'motor cap'),
    part(post(3, 6, 16), black, 0, 14, 75, 'inlet'),
  )
  return { group: g, mark }
}

/** UltiMaker S head, mm, the left nozzle's tip at the origin (Cura's head polygon, gantry height and nozzle head distance). */
export const UM = {
  /** The cavity the print cores stand in; the head's walls are around it. */
  cavity: { x0: -8, y0: -11, y1: 23, top: 62 },
  /** Bottom of the head over the left tip (`machine_nozzle_head_distance` 2.7). */
  bottom: 2.7,
  /** Lift switch lever: pivot on the right wall, arm height, pin top, swing either side of square to the wall. */
  lever: { x: 39.6, y: 8, z0: 57, z1: 59.5, pinTop: 66, pinR: 1.5, swing: (40 * Math.PI) / 180 },
} as const

const clear = new MeshStandardMaterial({ color: new Color('#dce6ee'), metalness: 0.05, roughness: 0.2, transparent: true, opacity: 0.6 })

/**
 * An UltiMaker print core, nozzle tip at the origin, after the maker's product photos: brass nozzle and heater
 * block, the black lower housing with the core's name, the finned heat sink in the black frame with the chip's
 * contacts on its back, the clear top plate and the steel feed tube. 14 mm wide, 32 mm deep, 60 mm tall.
 */
function buildPrintCore(): Group {
  const g = new Group()
  g.name = 'print core'
  g.add(
    part(new ConeGeometry(1.6, 3, 24).rotateX(-Math.PI / 2), brass, 0, 0, 1.5, 'nozzle'),
    slab(brass, -6, 6, -5, 9, 3, 11, 'heater', 0.5),
    slab(black, -7, 7, -10, 22, 11, 24, 'housing', 1),
    slab(white, -5, 5, -10.4, -10, 16, 21, 'label'),
    part(post(5.5, 20, 28), silver, 0, 4, 34, 'fins'),
    slab(black, -7, 7, 16, 22, 24, 44, 'spine', 0.8),
    slab(brass, -4, 4, 22, 22.4, 28, 40, 'contacts'),
    slab(clear, -7, 7, -10, 22, 44, 47, 'plate', 0.6),
    part(post(2.4, 13, 20), steel, 0, 4, 53.5, 'pin'),
  )
  ring(g)
  return g
}

/**
 * The UltiMaker S head around cores `spacing` apart, the left tip at the origin, after the maker's photos (the
 * S5 repair manuals, the UltiMaker 3 print head assembly manual) and inside Cura's head polygon (x -41.4 to
 * 63.3, y -45.8 to 36 from the left nozzle). The cores stand in a cavity open below; the walls, the front fan
 * bracket, the side fan brackets and the bearing housing close it. The two Bowden tubes show the filament.
 */
function buildUltimakerHead(spacing: number, L: number): { group: Group; left: Group; right: Group; lever: Group; tubes: [Mesh, Mesh] } {
  const g = new Group()
  const cx = spacing / 2
  const { x0, y0, y1, top } = UM.cavity
  const x1 = spacing + 8
  const w0 = cx - 27
  const w1 = cx + 27
  const b = UM.bottom
  const left = buildPrintCore()
  const right = buildPrintCore()
  right.position.x = spacing
  const tube = (x: number) => part(post(3, 42, 20), white, x, 8, 104, 'tube')
  const tubes: [Mesh, Mesh] = [tube(0), tube(spacing)]
  g.add(
    left,
    right,
    // The bottom plate around the opening the cores reach through, and the walls of the cavity.
    slab(white, w0, w1, -22, y0, b, 6, 'bottom'),
    slab(white, w0, w1, y1, 30, b, 6, 'bottom'),
    slab(white, w0, x0, y0, y1, b, 6, 'bottom'),
    slab(white, x1, w1, y0, y1, b, 6, 'bottom'),
    slab(white, w0, x0, y0, y1, 6, top, 'body', 1),
    slab(white, x1, w1, y0, y1, 6, top, 'body', 1),
    slab(white, w0, w1, -14, y0, 6, top, 'body', 1),
    slab(white, w0, w1, y1, 30, 6, top, 'body', 1),
    // The front fan bracket over the cores, its grille with the slats in front of the fan.
    slab(white, cx - 24, cx + 24, -45.8, -14, 8, 50, 'front bracket', 3),
    slab(deep, cx - 14, cx + 14, -46.2, -45.8, 16, 44, 'grille'),
    // The side fan brackets with their vents, and the ducts under them that blow at the nozzles.
    slab(white, -41.4, w0, -30, 26, 14, 56, 'side bracket', 3),
    slab(white, w1, 63.3, -30, 26, 14, 56, 'side bracket', 3),
    slab(white, -36, w0, -24, 18, 6, 14, 'duct', 2),
    slab(white, w1, 58, -24, 18, 6, 14, 'duct', 2),
    // The bearing housing on top with the Bowden clamps, the cable cover at the back and the head cable.
    slab(white, cx - 24, cx + 24, -12, 28, top, 80, 'housing top', 2),
    slab(white, cx - 12, cx + 12, 30, 36, 24, 74, 'cable cover', 1.5),
    part(post(3.5, 46, 20), white, cx, 33, 97, 'cable'),
    part(post(5, 3, 24), white, 0, 8, 81.5, 'clip'),
    part(post(5, 3, 24), white, spacing, 8, 81.5, 'clip'),
    ...tubes,
  )
  for (let i = 0; i < 5; i++) g.add(slab(white, cx - 11 + i * 5, cx - 9 + i * 5, -46.8, -46.2, 16, 44, 'slat'))
  for (let i = 0; i < 4; i++) {
    const y = -22 + i * 11
    g.add(slab(deep, -41.8, -41.4, y, y + 5, 22, 48, 'vent'), slab(deep, 63.3, 63.7, y, y + 5, 22, 48, 'vent'))
  }
  // The lift switch: its arm swings about a pivot on the right wall; the pin at its end runs in the switch bay.
  const lever = new Group()
  lever.name = 'lever'
  lever.add(slab(graphite, 0, L, -1.25, 1.25, UM.lever.z0, UM.lever.z1, 'lever', 0.5), part(post(UM.lever.pinR, UM.lever.pinTop - UM.lever.z0, 16), graphite, L, 0, (UM.lever.z0 + UM.lever.pinTop) / 2, 'lever pin'))
  lever.position.set(UM.lever.x, UM.lever.y, 0)
  g.add(lever)
  return { group: g, left, right, lever, tubes }
}

/** The lever's length: its pin stays in the bay while the head runs between the two switching positions (18 mm apart on the S5, S7, S6 and S8). */
function leverLength(stroke: number): number {
  return stroke / 2 / Math.sin(UM.lever.swing)
}

export class ToolheadRig {
  readonly root = new Group()
  /** Moves with the pose; the active nozzle's tip is at the pose when the head carries a tool. */
  private readonly head = new Group()
  /** The rack or dock: fixed in x and y, at the gantry's height (the head's z). */
  private readonly fixed = new Group()
  private spec: ToolChangerSpec | null = null
  private colors: readonly string[] = []
  private readonly materials = new Map<string, MeshStandardMaterial>()
  private readonly disposables: { dispose(): void }[] = []
  private sleeves: { mesh: Mesh; tool: () => number }[] = []
  private left: Group | null = null
  private right: Group | null = null
  private carried: Group | null = null
  private rackSlots: { group: Group }[] = []
  private lever: Group | null = null
  private leverL = 14
  private headShadow: Mesh | null = null
  private rackGroup: Group | null = null
  private rowRise = 0
  private lastTool = -1
  private lastKey = ''
  private model: HeadModel = 'generic'

  constructor() {
    this.root.name = 'toolhead'
    this.head.name = 'nozzle'
    this.fixed.name = 'changer'
    this.root.add(this.head, this.fixed)
    this.root.visible = false
    this.build()
  }

  get visible(): boolean {
    return this.root.visible
  }

  set visible(on: boolean) {
    this.root.visible = on
  }

  /** The moving head with its carriage and shadow; the rack or dock stays as `visible` sets it. */
  get headVisible(): boolean {
    return this.head.visible
  }

  set headVisible(on: boolean) {
    this.head.visible = on
  }

  /** The printer family's head, drawn when the printer has one nozzle (see heads.ts). */
  setModel(model: HeadModel): void {
    if (model === this.model) return
    this.model = model
    if (!this.spec || this.spec.kind === 'filament-swap') this.build()
  }

  setSpec(spec: ToolChangerSpec | null): void {
    const key = spec ? `${spec.kind}:${spec.tools}:${spec.extruderOf.join(',')}:${spec.bed.widthMm}x${spec.bed.depthMm}` : ''
    if (key === this.lastKey) return
    this.lastKey = key
    this.spec = spec
    this.build()
  }

  setColors(colors: readonly string[]): void {
    this.colors = colors
    this.paint()
  }

  private material(tool: number): MeshStandardMaterial {
    const hex = displayHex(this.colors[tool] ?? this.colors[this.colors.length - 1] ?? '#9aa4c1')
    let m = this.materials.get(hex)
    if (!m) {
      m = new MeshStandardMaterial({ color: new Color(hex), metalness: 0.1, roughness: 0.45 })
      this.materials.set(hex, m)
    }
    return m
  }

  private paint(): void {
    for (const s of this.sleeves) {
      const t = s.tool()
      s.mesh.material = t >= 0 ? this.material(t) : steel
    }
  }

  private clear(): void {
    this.head.clear()
    this.fixed.clear()
    this.fixed.position.set(0, 0, 0)
    for (const d of this.disposables) d.dispose()
    this.disposables.length = 0
    this.sleeves = []
    this.left = this.right = this.carried = this.rackGroup = this.lever = this.headShadow = null
    this.bay = null
    this.rackSlots = []
  }

  private track(g: Group): void {
    g.traverse((o) => {
      if ((o as Mesh).isMesh) this.disposables.push((o as Mesh).geometry)
    })
  }

  private build(): void {
    this.clear()
    const spec = this.spec
    // A printer that only swaps filament keeps its own single head; the chute is the purge rig's.
    const single = !spec || spec.kind === 'filament-swap' ? buildHead(this.model) : null
    const shadow = buildShadow(single ? single.shadow : 18)
    this.disposables.push(shadow.geometry, shadow.material as Material)
    if (single || !spec) {
      const h = single ?? buildHead(this.model)
      this.head.add(shadow, h.group)
      this.sleeves.push({ mesh: h.sleeve, tool: () => this.lastTool })
    } else if (spec.kind === 'dual-nozzle' || spec.kind === 'hotend-rack') {
      const h = buildBambuHead(spec.nozzles?.spacing ?? 24, spec.kind === 'hotend-rack')
      this.left = h.left
      this.right = h.right
      this.carried = h.right
      this.head.add(shadow, h.group)
      this.sleeves.push({ mesh: h.chip, tool: () => this.lastTool })
      if (h.rightSleeve) this.sleeves.push({ mesh: h.rightSleeve, tool: () => this.rightTool })
      if (spec.kind === 'hotend-rack' && spec.rack) this.buildRack(spec.rack)
    } else if (spec.kind === 'lift-switch') {
      const k = spec.lift
      const spacing = k?.offsets[1]?.[0] ?? 22
      const park = k?.bayAt ?? []
      const stroke = Math.abs((park[0]?.[1] ?? 0) - (park[1]?.[1] ?? 0))
      this.leverL = leverLength(stroke > 1 ? stroke : 18)
      const h = buildUltimakerHead(spacing, this.leverL)
      this.left = h.left
      this.right = h.right
      this.lever = h.lever
      this.headShadow = shadow
      this.head.add(shadow, h.group)
      this.sleeves.push({ mesh: h.tubes[0], tool: () => this.toolOnSide(0) }, { mesh: h.tubes[1], tool: () => this.toolOnSide(1) })
      if (k) this.buildSwitchBay(k)
    } else if (spec.kind === 'xl-dock') {
      // Prusa XL: the toolhead hangs behind the carriage's coupling plate.
      const t = buildXlTool()
      this.carried = t.group
      const carriage = new Group()
      carriage.name = 'carriage'
      carriage.add(slab(black, -30, 30, XL.carriage[0], XL.carriage[1], 18, 88, 'carriage', 3), slab(prusaOrange, -24, -19, XL.carriage[0] - 0.4, XL.carriage[0], 26, 80, 'accent'))
      this.head.add(shadow, t.group, carriage)
      this.sleeves.push({ mesh: t.band, tool: () => this.carriedTool })
      if (spec.xl) this.buildXlDock(spec.xl)
    } else {
      // tool-rack: the toolhead hangs on the back of a white carriage by its coupling face.
      const t = buildU1Toolhead()
      this.carried = t.group
      const carriage = new Group()
      carriage.name = 'carriage'
      carriage.add(slab(white, -21, 21, -34, -7.5, 24, 80, 'carriage', 6), part(new CylinderGeometry(6.5, 6.5, 0.8, 40), amber, 0, -34.4, 66, 'badge'))
      this.head.add(shadow, t.group, carriage)
      this.sleeves.push({ mesh: t.mark, tool: () => this.carriedTool })
      if (spec.docks) this.buildDock(spec.docks)
    }
    this.head.traverse((o) => void ((o as Mesh).isMesh && (((o as Mesh).castShadow = true), ((o as Mesh).receiveShadow = false))))
    shadow.castShadow = false
    this.track(this.head)
    this.track(this.fixed)
    this.slots = []
    this.restState = null
    this.paint()
  }

  /**
   * The H2C rack: a black frame with two rows of three holders, each a block with a white light and a fork
   * that grips a hotend's collar; two posts carry the rows, which move up and down together.
   */
  private buildRack(r: NonNullable<ToolChangerSpec['rack']>): void {
    const rack = new Group()
    rack.name = 'rack'
    this.rowRise = r.rowRise
    const y0 = (r.ys[0] ?? 0) - 30
    const y1 = (r.ys[r.ys.length - 1] ?? 0) + 30
    const [tz0, tz1] = RACK.tineZ
    const [tx0, tx1] = RACK.tineX
    const [hx0, hx1] = RACK.holderX
    const top = r.rowRise + 64
    for (const y of [y0 - 5, y1 + 5]) rack.add(part(post(3, top + 10, 20), steel, hx1 + 4, y, (top - 10) / 2, 'post'))
    rack.add(slab(black, hx1, hx1 + 8, y0 - 8, y1 + 8, top, top + 6, 'top bar', 1.5))
    for (let row = 0; row < 2; row++) {
      const z = row * r.rowRise
      rack.add(slab(black, hx1, hx1 + 6, y0, y1, z + 22, z + 33, 'rail', 1.5))
      for (let k = 0; k < 3; k++) {
        const y = r.ys[k] ?? 0
        rack.add(slab(black, hx0, hx1, y - 9, y + 9, z + 22, z + 33, 'holder', 1.5), slab(lightMat, hx0 - 0.4, hx0, y - 1.5, y + 1.5, z + 29, z + 31, 'light'))
        for (const side of [-1, 1]) rack.add(slab(deep, tx0, tx1, y + side * RACK.tineY - 1.5, y + side * RACK.tineY + 1.5, z + tz0, z + tz1, 'tine'))
        const h = buildVortek(false)
        h.group.position.set(0, y, z)
        const idx = row * 3 + k
        h.group.userData.slot = idx
        rack.add(h.group)
        this.rackSlots.push({ group: h.group })
        this.sleeves.push({ mesh: h.sleeve, tool: () => this.slotTool(idx) })
      }
    }
    rack.position.set(r.x, 0, 0)
    this.rackGroup = rack
    this.fixed.add(rack)
  }

  /** The Prusa XL dock along the back frame: a perforated black panel with a pin block behind each parked toolhead. */
  private buildXlDock(k: NonNullable<ToolChangerSpec['xl']>): void {
    const dock = new Group()
    dock.name = 'dock'
    const pitch = (k.x[1] ?? 82) - (k.x[0] ?? 0)
    const x0 = (k.x[0] ?? 0) - pitch / 2
    const x1 = (k.x[k.x.length - 1] ?? 0) + pitch / 2
    const b0 = k.y + XL.tool.back + 1
    dock.add(slab(black, x0, x1, b0 + 8, b0 + 12, 10, 100, 'panel', 1.5))
    for (let i = 0; i < 9; i++) dock.add(slab(deep, x0 + 6, x1 - 6, b0 + 7.6, b0 + 8, 20 + i * 8, 24 + i * 8, 'vent'))
    k.x.forEach((x, i) => {
      const t = buildXlTool()
      t.group.position.set(x, k.y, 0)
      t.group.userData.slot = i
      dock.add(t.group, slab(graphite, x - 14, x + 14, b0, b0 + 7.6, 34, 82, 'pins', 1), part(post(2.2, 14, 16), steel, x + 20, b0 + 4, 58, 'pin'))
      this.rackSlots.push({ group: t.group })
      this.sleeves.push({ mesh: t.band, tool: () => this.slotTool(i) })
    })
    this.fixed.add(dock)
  }

  /**
   * The UltiMaker switch bay on the right wall: a white block with a slot the lever's pin runs in. It stands where
   * the pin arrives when the head runs into the bay from either switching position.
   */
  private bay: { x: number; y: number } | null = null
  private buildSwitchBay(k: NonNullable<ToolChangerSpec['lift']>): void {
    const [ax, ay] = k.bayAt[0] ?? [0, 0]
    const by = k.bayAt[1]?.[1] ?? ay
    const L = this.leverL
    const x = ax + k.bayIn + UM.lever.x + L * Math.cos(UM.lever.swing)
    const y = (ay + by) / 2 + UM.lever.y
    this.bay = { x, y }
    // The slot is a little wider than the pin, so the pin turns in it as the lever swings.
    const r = UM.lever.pinR * Math.SQRT2 + 0.05
    const bay = new Group()
    bay.name = 'switch bay'
    bay.add(
      slab(white, x - 8, x + 6, y + r, y + r + 3, UM.lever.z1, UM.lever.pinTop, 'prong', 0.6),
      slab(white, x - 8, x + 6, y - r - 3, y - r, UM.lever.z1, UM.lever.pinTop, 'prong', 0.6),
      slab(white, x + 6, x + 16, y - 12, y + 12, UM.lever.z1, 72, 'bay', 1.5),
    )
    this.fixed.add(bay)
  }

  /** The U1 dock: a black beam along the back with a bracket behind each parked toolhead. */
  private buildDock(d: NonNullable<ToolChangerSpec['docks']>): void {
    const dock = new Group()
    dock.name = 'dock'
    const pitch = (d.x[1] ?? 60) - (d.x[0] ?? 0)
    const x0 = (d.x[0] ?? 0) - pitch / 2
    const x1 = (d.x[d.x.length - 1] ?? 0) + pitch / 2
    dock.add(slab(black, x0, x1, d.y + 58, d.y + 66, 60, 76, 'beam', 1.5))
    d.x.forEach((x, i) => {
      const t = buildU1Toolhead()
      t.group.position.set(x, d.y, 0)
      t.group.userData.slot = i
      dock.add(t.group, slab(graphite, x - 16, x + 16, d.y + 55, d.y + 58, 20, 75, 'bracket', 1))
      this.rackSlots.push({ group: t.group })
      this.sleeves.push({ mesh: t.mark, tool: () => this.slotTool(i) })
    })
    this.fixed.add(dock)
  }

  // ---- state read by the sleeves
  private slots: number[] = []
  private rightTool = -1
  private carriedTool = -1
  private toolOnSide(side: number): number {
    const spec = this.spec
    if (!spec) return this.lastTool
    if ((spec.extruderOf[this.lastTool] ?? 0) === side) return this.lastTool
    return spec.extruderOf.findIndex((e) => e === side)
  }
  private slotTool(i: number): number {
    return this.slots[i] ?? -1
  }

  /**
   * Rack and dock contents when no change is playing: what the last change left (`rest`), or before the first
   * change the rack as the print starts (every tool but the one in the head).
   */
  private restSlots(tool: number): number[] {
    const spec = this.spec
    if (!spec) return []
    if (this.restState) return this.restState
    if (spec.kind === 'tool-rack') return (spec.docks?.x ?? []).map((_, i) => (i === tool ? -1 : i))
    if (spec.kind === 'xl-dock') return (spec.xl?.x ?? []).map((_, i) => (i === tool ? -1 : i))
    if (spec.kind === 'hotend-rack') return rackStateBefore(spec, []).slots
    return []
  }

  /**
   * Places the head with its active nozzle tip at (x, y, z) printing `tool`, or, with `pose`, mid change:
   * the pose says where the head is, what it carries, how far the idle nozzle is lifted and what the rack holds.
   */
  place(x: number, y: number, z: number, tool: number, pose: Pose | null, slots: number[] | null): void {
    const spec = this.spec
    this.lastTool = tool
    const px = pose ? pose.x : x
    const py = pose ? pose.y : y
    const pz = (pose ? pose.z : z) + 0.05
    if (!spec || spec.kind === 'filament-swap') {
      // Through a filament change the inlet shows the old filament until the new one loads.
      if (pose) this.lastTool = pose.carried ?? tool
      this.head.position.set(px, py, pz)
      this.paint()
      return
    }
    if (spec.kind === 'tool-rack' || spec.kind === 'xl-dock') {
      this.carriedTool = pose ? (pose.carried ?? -1) : tool
      this.slots = slots ?? (pose ? pose.slots : this.restSlots(tool))
      if (this.carried) {
        this.carried.visible = this.carriedTool >= 0
        // The release stroke slides the carriage off a toolhead that is already seated: the toolhead stays in its slot.
        this.carried.position.x = spec.kind === 'tool-rack' && pose?.phase === 'release' ? -(1 - pose.latch) * (spec.docks?.strokeX ?? 0) : 0
      }
      for (const [i, s] of this.rackSlots.entries()) s.group.visible = (this.slots[i] ?? -1) >= 0
      this.head.position.set(px, py, pz)
      // The dock keeps the head's height (the frame carries both).
      this.fixed.position.z = pz
      this.paint()
      return
    }
    if (spec.kind === 'lift-switch') {
      this.placeUltimaker(spec, x, y, z, tool, pose)
      return
    }
    const s = spec.nozzles?.spacing ?? 24
    const liftMm = spec.nozzles?.liftMm ?? 2.5
    const side = pose ? pose.lift : (spec.extruderOf[tool] ?? 0) > 0 ? 1 : 0
    // The active nozzle sits at the point; the idle one is lifted. Between, both move as the lift rail does.
    const u = Math.min(1, Math.max(0, side))
    this.head.position.set(px + (0.5 - u) * s, py, pz)
    if (this.left) this.left.position.z = u * liftMm
    if (this.right) this.right.position.z = (1 - u) * liftMm
    if (spec.kind === 'hotend-rack') {
      const rackExtruder = Math.max(...spec.extruderOf, 0)
      this.slots = slots ?? (pose ? pose.slots : this.restSlots(tool))
      const held = pose ? pose.carried : spec.extruderOf[tool] === rackExtruder ? tool : this.rightToolAtRest()
      this.rightTool = held ?? -1
      if (this.carried) this.carried.visible = this.rightTool >= 0
      // A spare hotend (SPARE) is drawn too; only an empty position shows nothing.
      for (const [i, sl] of this.rackSlots.entries()) sl.group.visible = (this.slots[i] ?? -1) !== -1
      if (this.rackGroup) {
        const row = pose ? pose.row : this.row
        this.rackGroup.position.z = pz - row * this.rowRise
      }
    } else {
      this.rightTool = this.toolOnSide(1)
    }
    this.paint()
  }

  /**
   * UltiMaker S: the head stands with the printing core's tip at the move (the left tip higher by the lowered right
   * core's depth while the right one prints), or where the change's pose puts the left tip. The right core rides the
   * lift switch: lifted over the left tip, or lowered under it. While the firmware runs the lever along the bay, the
   * lever's pin stays in the bay's slot and the lever's angle sets the right core's height.
   */
  private placeUltimaker(spec: ToolChangerSpec, x: number, y: number, z: number, tool: number, pose: Pose | null): void {
    const k = spec.lift
    const side = (spec.extruderOf[tool] ?? 0) > 0 ? 1 : 0
    const off = k?.offsets[spec.extruderOf[tool] ?? 0] ?? [0, 0]
    const lowered = k?.lowered ?? 1.5
    const stroke = k?.stroke ?? 3
    let u = pose ? pose.lift : side
    const hx = pose ? pose.x : x - off[0]
    const hy = pose ? pose.y : y - off[1]
    const hz = (pose ? pose.z : z + side * lowered) + 0.05
    let angle = -UM.lever.swing + 2 * UM.lever.swing * Math.min(1, Math.max(0, u))
    if (pose?.phase === 'switch' && this.bay) {
      // The pin is held in the slot: the head's y decides the angle, and the angle the core's height.
      const s = Math.min(1, Math.max(-1, (this.bay.y - (hy + UM.lever.y)) / this.leverL))
      angle = Math.asin(s)
      u = (angle + UM.lever.swing) / (2 * UM.lever.swing)
    }
    this.head.position.set(hx, hy, hz)
    if (this.right) this.right.position.z = stroke - lowered - stroke * Math.min(1, Math.max(0, u))
    if (this.lever) this.lever.rotation.z = angle
    if (this.headShadow) this.headShadow.position.z = -0.02 - Math.min(1, Math.max(0, u)) * lowered
    this.fixed.position.z = hz
    this.paint()
  }

  private row = 0
  private restState: number[] | null = null
  /** The rack row and contents the last change left behind (null before the first), for the frames after it. */
  rest(slots: number[] | null, row: number): void {
    this.restState = slots
    this.row = row
  }

  private rightToolAtRest(): number {
    const spec = this.spec
    if (!spec) return -1
    const rackExtruder = Math.max(...spec.extruderOf, 0)
    const onRack = Array.from({ length: spec.tools }, (_, t) => t).filter((t) => spec.extruderOf[t] === rackExtruder)
    return onRack.find((t) => !this.slots.includes(t)) ?? onRack[0] ?? -1
  }

  /** Draws far below the bed so the shaders exist before the first scrub (see Toolpaths.warmNozzle). */
  warm(on: boolean): void {
    this.root.visible = on
    this.head.visible = on
    this.root.traverse((o) => void (o.frustumCulled = !on))
    if (on) this.head.position.set(0, 0, -400)
  }

  dispose(): void {
    this.clear()
    for (const m of this.materials.values()) m.dispose()
    this.materials.clear()
  }
}
