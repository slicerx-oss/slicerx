// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The project an MCP client works on: models, plates and settings, held in
// memory by the server. mimir's skills (orient, arrange, cut, slice,
// estimate) read and change it through the PilotProject interface.
import type { HeightRange, MeshPart, PilotMachine, Plate, PlateObject, PrintConfig, SettingValue, VolumeRole } from '@slicerx/contracts'
import { rotationMatrix, type ArrangedObject, type MovedCopies, type ObjectPlan, type PilotProject, type PlatesLeftOff, type ProjectObject, type ProjectPlate, type ProjectVolume as PilotVolume, type VolumeShape, type VolumeSpec } from '@slicerx/pilot'
import type { EngineCall } from '@slicerx/cad-history'
import type { DataStore } from './data'
import type { ProfileCatalog } from './profiles'
import { isGcodeKey, SHIPPED_GCODE_SOURCES } from './config'
import { ToolInputError } from './models'
import { defaultConfig, sameValue, toSchemaValue } from './settings'
import { positionsFromParts, type NodeSlicerHost } from './slicerhost'
import { plateCheckOutput, type PlateCheckOutput } from './collide'
import { areaOrigin } from '@slicerx/threemf/area'
import { defaultFilament, filamentColor, filamentType, listFilaments, MAX_FILAMENTS, type FilamentSetup, type ProjectFilament } from './filaments'
import { marginText, objectPrintMargins } from '@slicerx/settings/print-margins'
import { byObjectPlan, byObjectReadback, objectGetsSupport, overRod, placedShape, type ByObjectReadback } from '@slicerx/settings/by-object'
import { bedArea, boxRows, describeBed, EDGE_MM, GAP_MM, pastRim, roundRows, type BedArea, type Foot } from './bed'
import { boxPositions, cylinderPositions, spherePositions, splitBodies } from './mesh'
import { boxFillCount, boxInLanes, boxPlate, fillCount, nestInLanes, nestPlate, plateTools, turnedLinear, turnedObject, type FootprintCache, type NestObject } from './plate-nest'

/** A volume of an object, in the object's own (as modeled) coordinates: a cut, a support region or a settings modifier. */
export interface ProjectVolume {
  id: string
  name: string
  role: VolumeRole
  meshId: string
  /** What it is, for the read-back: `box 10 x 10 x 5 mm at [x, y, z]` and the like. */
  shape: string
  /** For a modifier: the settings inside it. */
  settings?: Record<string, SettingValue>
}

/** Settings for a band of heights, mm above the bed, for every object or the ones named. */
export interface ProjectHeightRange {
  zFromMm: number
  zToMm: number
  settings: Record<string, SettingValue>
  /** Project object ids; absent for every object. */
  objects?: string[]
}

interface Entry {
  obj: ProjectObject
  meshId?: string
  /** Rotation in degrees about X, then Y, then Z, applied before the object is placed. */
  rotate?: [number, number, number]
  /** Parts the object was loaded with: the bodies of a file kept as one object (1 for a plain model). */
  parts?: number
  /** Scale per axis in the object's own coordinates, applied before the rotation. 1 is as modeled. */
  scale?: [number, number, number]
  /** Center of the footprint on the bed, mm in bed coordinates, when a client placed it; otherwise it goes in the rows. */
  position?: [number, number]
  /** The object's own settings, over the project's and the plate's. */
  settings?: Record<string, SettingValue>
  volumes?: ProjectVolume[]
  /** Locked, as Lock does in the app: it is not moved, turned, scaled, cut or taken to another plate until unlocked. */
  locked?: true
  /** Left out of the print, as in the app: it keeps its place on the plate, and the slice leaves it out. */
  printable?: false
}

/** Where an arranged copy goes: its move in X and Y, bed coordinates, and its turn about Z in degrees after its rotation. */
type Spot = [number, number, number]

/** Where a copy sits now: its move in X and Y and its turn, and whether its footprint is on the bed. */
interface Sitting {
  at: Spot
  onBed: boolean
}

/** The gap a copy that duplicate places around others keeps, mm: the same as slicerx_arrange's default. */
const DUPLICATE_GAP_MM = 6

/** Where one copy sits on its plate. */
export interface Placement {
  /** The plate object id the slice uses: `<object id>-<copy>`. */
  id: string
  objectId: string
  copy: number
  /** Center of its footprint, mm in bed coordinates. */
  centerMm: [number, number]
  /** Size as placed (rotation and scale applied), mm. */
  sizeMm: [number, number, number]
  /** Placed by a client (slicerx_project_move) rather than in the rows. */
  manual: boolean
  /** Degrees the last arrange turned this copy about Z, after its object's rotation; 0 when it is not turned. */
  turnDeg: number
  /** Set when the copy reaches past the rim of a round bed; the slice refuses it until it is moved. */
  offBed?: true
  /** Set when its object is left out of the print: it keeps its place, and the slice leaves it out. */
  printable?: false
}

export interface ProjectSettings {
  name: string
  /** Profile ids from slicerx_list_profiles, applied in order. */
  profiles: string[]
  printer?: string
  filament?: string
  nozzle?: number
}

function num(v: SettingValue | undefined): number | undefined {
  const x = Array.isArray(v) ? v[0] : v
  return typeof x === 'number' ? x : undefined
}

export class McpProject implements PilotProject {
  name: string
  readonly settings: ProjectSettings
  private readonly entries = new Map<string, Entry>()
  private layout: ProjectPlate[] = []
  private projectOverrides: Record<string, SettingValue> = {}
  /** Filaments a client set, by number; the rest follow the filament profile. */
  private filamentSetup: Record<number, FilamentSetup> = {}
  private ranges: ProjectHeightRange[] = []
  private nextId = 1
  private nextVolume = 1
  /** Where the last arrange put each plate's copies, while the plate holds the same copies as then. */
  private readonly nested = new Map<number, { key: string; at: Map<string, Spot> }>()
  private readonly feet: FootprintCache = new Map()

  /** `geom` is the geometry engine (sx-geom) arrange nests true outlines with; without it arrange packs boxes (boxPlate). */
  constructor(
    settings: ProjectSettings,
    private readonly store: DataStore,
    private readonly profiles: ProfileCatalog,
    private readonly host: NodeSlicerHost,
    private readonly geom?: EngineCall | undefined,
  ) {
    this.name = settings.name
    this.settings = settings
  }

  machine(): PilotMachine | undefined {
    const printer = this.settings.printer ? this.store.findKnowledge(['printer'], this.settings.printer) : undefined
    const material = this.settings.filament ? this.store.findKnowledge(['filament'], this.settings.filament) : undefined
    if (!printer && !material) return undefined
    return { printer: printer?.name ?? '', material: material?.id ?? '', nozzle: this.settings.nozzle ?? num(this.baseConfig()['nozzle_diameter']) ?? 0.4 }
  }

  /** Adds a loaded mesh as an object. New objects go on plate 1. */
  addMesh(meshId: string, name: string, bboxMm: [number, number, number], triangles: number, copies: number, parts = 1): ProjectObject {
    const id = `obj-${this.nextId++}`
    const obj: ProjectObject = { id, name, bboxMm, triangles, mesh: async () => this.host.parts(meshId) }
    this.entries.set(id, { obj, meshId, parts })
    let first = this.layout.find((p) => p.index === 1)
    if (!first) {
      first = { index: 1, items: [] }
      this.layout.push(first)
    }
    first.items.push({ objectId: id, copies })
    return obj
  }

  /** A generated or found object with its geometry, on a new plate of its own. */
  async addObject(obj: ProjectObject, parts: MeshPart[]): Promise<void> {
    const handle = await this.host.loadParts(obj.name, parts)
    const added: ProjectObject = { ...obj, bboxMm: handle.bboxMm, triangles: handle.triangles, mesh: async () => this.host.parts(handle.id) }
    this.entries.set(obj.id, { obj: added, meshId: handle.id })
    const index = Math.max(0, ...this.layout.map((p) => p.index)) + 1
    this.layout.push({ index, items: [{ objectId: obj.id, copies: 1 }] })
  }

  /** Rotates an object wherever it is placed; its footprint on the plate follows. */
  setRotation(objectId: string, rotate: [number, number, number]): void {
    const e = this.entries.get(objectId)
    if (!e) throw new Error(`No object ${objectId}`)
    unlocked(e)
    e.rotate = rotate
    if (e.meshId) e.obj = { ...e.obj, bboxMm: this.placedBounds(e as Entry & { meshId: string }).size }
  }

  objects(): ProjectObject[] {
    return [...this.entries.values()].map((e) => e.obj)
  }

  plates(): ProjectPlate[] {
    return this.layout.map((p) => ({ ...p, items: p.items.map((i) => ({ ...i })) }))
  }

  /**
   * A new layout (arrange). A locked object stays on the plates it was on, with its copies: a layout that leaves it out
   * keeps it where it was, and one that moves it or changes its copies is refused.
   */
  setPlates(plates: ProjectPlate[]): void {
    const locked = [...this.entries.values()].filter((e) => e.locked)
    const where = (layout: readonly ProjectPlate[], id: string): string =>
      JSON.stringify(layout.flatMap((p) => p.items.filter((i) => i.objectId === id).map((i) => [p.index, i.copies])))
    for (const e of locked) {
      const asked = where(plates, e.obj.id)
      if (asked !== '[]' && asked !== where(this.layout, e.obj.id)) unlocked(e)
    }
    const ids = new Set(locked.map((e) => e.obj.id))
    const kept = this.layout.flatMap((p) => p.items.filter((i) => ids.has(i.objectId)).map((i) => ({ index: p.index, item: { ...i } })))
    this.layout = plates.map((p) => ({ ...p, items: p.items.filter((i) => !ids.has(i.objectId)).map((i) => ({ ...i })) }))
    for (const k of kept) {
      let plate = this.layout.find((p) => p.index === k.index)
      if (!plate) {
        plate = { index: k.index, items: [] }
        this.layout.push(plate)
        this.layout.sort((a, b) => a.index - b.index)
      }
      plate.items.push(k.item)
    }
  }

  overrides(): Record<string, SettingValue> {
    return { ...this.projectOverrides }
  }

  setOverrides(changes: Record<string, SettingValue>, clear: readonly string[] = []): void {
    for (const key of clear) delete this.projectOverrides[key]
    for (const [k, v] of Object.entries(changes)) this.projectOverrides[k] = toSchemaValue(this.store.setting(k), v)
  }

  /** The filament type the project's filament profile sets, for filaments no client set. */
  private profileType(): string {
    const t = this.baseConfig()['filament_type']
    const first = Array.isArray(t) ? t[0] : t
    return typeof first === 'string' && first ? first : 'PLA'
  }

  /** Every filament of the project, numbered as the plate uses them. */
  filaments(): ProjectFilament[] {
    return listFilaments(this.filamentSetup, this.profileType())
  }

  /** Adds a filament after the last one, with the profile's type and the default color unless given. */
  addFilament(patch: { type?: string | undefined; color?: string | undefined }): ProjectFilament {
    const slot = this.filaments().length + 1
    if (slot > MAX_FILAMENTS) throw new Error(`The project already has ${MAX_FILAMENTS} filaments, the most it holds.`)
    return this.setFilament(slot, patch, defaultFilament(slot, this.profileType()))
  }

  /** Changes filament `slot`'s type or color; what is not given stays. */
  setFilament(slot: number, patch: { type?: string | undefined; color?: string | undefined }, from?: FilamentSetup): ProjectFilament {
    const cur = from ?? this.filaments().find((f) => f.slot === slot)
    if (!cur) throw new Error(`No filament ${slot}: the project has ${this.filaments().length}. Add one with slicerx_project_add_filament.`)
    const next = { type: patch.type !== undefined ? filamentType(patch.type) : cur.type, color: patch.color !== undefined ? filamentColor(patch.color) : cur.color }
    this.filamentSetup = { ...this.filamentSetup, [slot]: next }
    return { slot, ...next, source: 'set' }
  }

  /** filament_type and filament_colour for the slice, once a client set a filament; until then the profile's alone. */
  private filamentConfig(): Record<string, SettingValue> {
    if (Object.keys(this.filamentSetup).length === 0) return {}
    const list = this.filaments()
    return { filament_type: list.map((f) => f.type), filament_colour: list.map((f) => f.color) }
  }

  private baseConfig(): Record<string, SettingValue> {
    const cfg: Record<string, SettingValue> = { ...defaultConfig(this.store) }
    const ids = [...this.settings.profiles]
    if (this.settings.printer) ids.unshift(`printer:${this.settings.printer}`)
    if (this.settings.filament) ids.push(`filament:${this.settings.filament}`)
    for (const id of ids) Object.assign(cfg, this.profiles.get(id)?.config ?? {})
    if (this.settings.nozzle !== undefined) cfg['nozzle_diameter'] = toSchemaValue(this.store.setting('nozzle_diameter'), this.settings.nozzle)
    return cfg
  }

  /**
   * Whether every G-code setting of a slice config is the text SlicerX ships for this project's profiles: the
   * defaults and the SlicerX and maker profiles, with no override, plate setting or other profile changing one.
   */
  gcodeIsShipped(config: Record<string, SettingValue>): boolean {
    const shipped: Record<string, SettingValue> = { ...defaultConfig(this.store) }
    const ids = [...this.settings.profiles]
    if (this.settings.printer) ids.unshift(`printer:${this.settings.printer}`)
    if (this.settings.filament) ids.push(`filament:${this.settings.filament}`)
    for (const id of ids) {
      const p = this.profiles.get(id)
      if (!p) continue
      for (const [k, v] of Object.entries(p.config)) {
        if (!isGcodeKey(k)) continue
        // A profile SlicerX does not ship sets G-code it cannot vouch for, unless that G-code is the printer's own as
        // SlicerX ships it (a knowledge printer's, shippedPrinterGcode).
        if (!SHIPPED_GCODE_SOURCES.has(p.source) && !p.shippedGcode) return false
        shipped[k] = v
      }
    }
    return Object.entries(config).every(([k, v]) => !isGcodeKey(k) || sameValue(v, shipped[k]))
  }

  config(plateIndex: number): PrintConfig {
    const plate = this.layout.find((p) => p.index === plateIndex)
    return { ...this.baseConfig(), ...this.filamentConfig(), ...this.projectOverrides, ...(plate?.overrides ?? {}) } as PrintConfig
  }

  /**
   * Printing by object, the clearance plan of these placed objects as the app reads it (@slicerx/settings/by-object):
   * the pairs closer than the clearance, the tall ones the gantry or lid would hit, and each one's zone. Null by layer.
   */
  clearanceOf(objects: readonly PlateObject[], cfg: Record<string, SettingValue>): ByObjectReadback | null {
    if (marginText(cfg['print_sequence']) !== 'by object' || objects.length < 2) return null
    const shapes = objects.map((o) => {
      const parts = this.host.parts(o.mesh)
      const m = o.transform ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
      // Its support's pad counts only when it gets support, as the app counts it (painted blockers count as enforcers).
      const own = o.settings ? { ...cfg, ...o.settings } : cfg
      const enforcers = (o.volumes ?? []).some((v) => v.role === 'support_enforcer') || parts.some((p) => Object.keys(p.paint?.support ?? {}).length > 0)
      return { ...placedShape(o.id, o.name ?? o.id, parts.map((p) => p.positions), m), supported: objectGetsSupport(own, enforcers, parts, m), ...(o.settings ? { settings: o.settings } : {}) }
    })
    return byObjectReadback(byObjectPlan(shapes, cfg))
  }

  /** A plate's by-object clearance plan, its printed copies where they sit; null by layer. */
  byObject(plateIndex: number): ByObjectReadback | null {
    const { objects, placements } = this.layoutPlate(plateIndex)
    const cfg = this.config(plateIndex) as Record<string, SettingValue>
    return this.clearanceOf(objects.filter((_o, k) => placements[k]?.printable !== false), cfg)
  }

  /**
   * heimdall's plate check of a by-object plate as it sits (`sx check`, before a slice): what a slice would be refused
   * for, how sure each finding is, the fixes and what only the slice checks (plateCheckOutput). Null by layer, with
   * fewer than two printed objects, or without the sx engine.
   */
  async plateCheck(plateIndex: number): Promise<PlateCheckOutput | null> {
    if (!this.host.checkPlate) return null
    const cfg = this.config(plateIndex)
    if (marginText((cfg as Record<string, SettingValue>)['print_sequence']) !== 'by object') return null
    const plate = await this.plate(plateIndex)
    if (plate.objects.length < 2) return null
    const ranges = this.heightRangesFor(plate)
    let check
    try {
      check = await this.host.checkPlate({ plate, config: cfg, options: { emitGcode: false, emitPreview: false, ...(ranges.length ? { heightRanges: ranges } : {}) } })
    } catch (e) {
      // The stub engine has no check: the footprint rule's plan is all there is.
      if (e instanceof ToolInputError && e.code === 'engine_unavailable' && /needs the sx engine/.test(e.message)) return null
      throw e
    }
    return plateCheckOutput(check, plate.objects.map((o) => ({ id: o.id, name: o.name ?? o.id })), areaOrigin((cfg as Record<string, SettingValue>)['printable_area']))
  }

  /** The plate's bed: the box of its printable area and, for a delta, the circle. */
  private bed(plateIndex: number): BedArea {
    return bedArea(this.config(plateIndex))
  }

  private rowMargins(plateIndex: number, entries: readonly Entry[]): { edge: number; gap: number } {
    let edge = EDGE_MM
    let gap = GAP_MM
    for (const e of entries) {
      if (!e.meshId) continue
      const [w, h, height] = this.placedBounds(e as Entry & { meshId: string }).size
      const margins = objectPrintMargins({ ...this.config(plateIndex), ...e.settings })
      edge = Math.max(edge, margins.reach({ w, h, height }) + 1)
      gap = Math.max(gap, 2 * margins.grow({ w, h, height }) + 1)
    }
    return { edge, gap }
  }

  /**
   * How many copies of an object fit on a plate: as many as arrange places (arrangePlates), on the object's true outline
   * with the geometry engine, else on its box, clear of the excluded areas and the prime tower's room and, printing by
   * object, the clearance radius apart. Without a mesh, as many as fit in the rows.
   */
  async arrangeCapacity(objectId: string, bed: { x: number; y: number; round?: boolean }, spacing: number, plateIndex: number): Promise<number> {
    const e = this.entries.get(objectId)
    if (!e?.meshId) return this.rowCapacity(objectId, bed, spacing, plateIndex)
    const cfg = this.config(plateIndex)
    const plate = { bed: this.bed(plateIndex), config: cfg, tools: this.toolsOf(cfg, [e]), gapMm: spacing, fixed: [], turn: true }
    const o = this.nestObject(e as Entry & { meshId: string }, cfg, 1)
    if (this.geom) {
      try {
        return await fillCount(this.geom, plate, o, 500, this.feet)
      } catch {
        // The engine failed: count on the boxes, as arrange then places them.
      }
    }
    return boxFillCount(plate, o, 500)
  }

  /**
   * Lays the plates out on true outlines with the geometry engine, as the app's arrange does: each object's outline
   * grown by its brim (sized from its first layer), raft and skirt, clear of the printer's excluded areas, the prime
   * tower's room and the copies a client placed. The layout holds until the plate's copies, rotation, scale or bed
   * change; then the plate goes back to the rows. Without the engine, or when it fails, the same layout runs on the
   * objects' boxes (boxPlate), as the app's arrange does then; the rows never stand in for an arranged plate.
   */
  async arrangePlates(plateIndexes: readonly number[], spacing: number): Promise<PlatesLeftOff | undefined> {
    let leftOff = 0
    for (const index of plateIndexes) {
      this.nested.delete(index)
      const r = await this.nestPlan(index, spacing, new Map(), true)
      for (const n of r?.left.values() ?? []) leftOff += n
    }
    return leftOff > 0 ? { leftOff } : undefined
  }

  /**
   * Arranges one object's copies around the other objects (slicerx_arrange): `copies` on each plate of the plan, the
   * other objects there staying where they are, as fixed obstacles. An object of theirs that hangs past the bed's edge
   * is placed too, unless it is locked or no empty bed holds it. Copies with no room go to new plates after the last,
   * with the plate's printer and settings, as the app's Arrange moves them. The object leaves the plates the plan does
   * not name, and a plate that leaves empty goes; every other object keeps its plate and its place.
   */
  async arrangeObject(objectId: string, plan: readonly ObjectPlan[], spacing: number): Promise<ArrangedObject> {
    const e = unlocked(this.entry(objectId))
    const id = e.obj.id
    const before = new Map(this.layout.map((p) => [p.index, this.sitting(p.index)]))
    const held = new Set(this.layout.filter((p) => p.items.some((i) => i.objectId === id)).map((p) => p.index))
    for (const p of this.layout) p.items = p.items.filter((i) => i.objectId !== id)
    const targets = new Set(plan.map((t) => t.index))
    // The other objects on a plate the object left keep their places, and a plate it leaves empty goes. The plan's
    // plates are the first ones, so their numbers stay.
    for (const index of held) if (!targets.has(index)) this.keepPlaces(index, before.get(index))
    for (const index of [...held].sort((a, b) => b - a)) {
      const plate = this.layout.find((p) => p.index === index)
      if (plate && !targets.has(index) && plate.items.length === 0) this.dropPlate(index)
    }
    for (const t of [...plan].sort((a, b) => a.index - b.index)) {
      let plate = this.layout.find((p) => p.index === t.index)
      if (!plate) {
        plate = { index: t.index, items: [] }
        this.layout.push(plate)
        this.layout.sort((a, b) => a.index - b.index)
      }
      if (t.printerId) plate.printerId = t.printerId
      plate.items.unshift({ objectId: id, copies: t.copies })
    }
    const moved: MovedCopies[] = []
    let leftOff = 0
    for (const t of [...plan].sort((a, b) => a.index - b.index)) {
      const plate = this.layout.find((p) => p.index === t.index)
      if (!plate) continue
      const sits = before.get(t.index) ?? new Map<string, Sitting>()
      const pins = new Map<string, Spot>()
      for (const item of plate.items) {
        if (item.objectId === id) continue
        const other = this.entries.get(item.objectId)
        if (!other?.meshId || other.position) continue
        const copies = Array.from({ length: item.copies }, (_, c) => [`${item.objectId}-${c + 1}`, sits.get(`${item.objectId}-${c + 1}`)] as const)
        // A copy past the edge moves, unless it is locked or too large for any bed: then it stays where it was.
        const stays = other.locked || (copies.some(([, x]) => x && !x.onBed) && !(await this.fitsEmpty(other as Entry & { meshId: string }, t.index, spacing, true)))
        for (const [copyId, x] of copies) if (x && (x.onBed || stays)) pins.set(copyId, x.at)
      }
      const r = await this.nestPlan(t.index, spacing, pins, true)
      if (!r || r.left.size === 0) continue
      this.commitNest(t.index, r.at, r.left)
      const o = await this.toNewPlates(t.index, r.left, spacing)
      moved.push(...o.moved)
      leftOff += o.stuck
    }
    // Each copy of the object where it now is, with its turn.
    const turns = this.layout.flatMap((p) => (p.items.some((i) => i.objectId === id) ? this.safePlacements(p.index).filter((q) => q.objectId === id).map((q) => ({ id: q.id, plate: p.index, turnDeg: q.turnDeg })) : []))
    return { leftOff, moved, turns }
  }

  /**
   * Duplicates an object (slicerx_project_duplicate): each copy a new object, on the plates the object is on, in the
   * rows while they fit the bed, else around what is there. A copy with no room goes to the last plate when it comes
   * after, has the same printer and settings and has room, else to a new plate; it never goes past the bed's edge. An
   * object no empty plate holds is refused before any copy is made.
   */
  async duplicate(objectId: string, count: number, spacing = DUPLICATE_GAP_MM): Promise<{ ids: string[]; moved: { objectId: string; from: number; to: number }[] }> {
    const e = this.entry(objectId)
    const homes = this.layout.filter((p) => p.items.some((i) => i.objectId === e.obj.id)).map((p) => p.index)
    for (const h of homes) {
      if (await this.fitsEmpty(e, h, spacing)) continue
      const bed = this.bed(h)
      throw new ToolInputError(`${e.obj.name} has no room even on an empty plate (${round2(e.obj.bboxMm[0])} x ${round2(e.obj.bboxMm[1])} mm with its brim and skirt, on a ${round2(bed.widthMm)} x ${round2(bed.depthMm)} mm bed), so no copy was added. Scale it down or cut it first.`, 'invalid_input', { reason: 'no_room', object: e.obj.id })
    }
    const ids: string[] = []
    const moved: { objectId: string; from: number; to: number }[] = []
    for (let k = 0; k < count; k++) {
      const id = `obj-${this.nextId++}`
      const copy: Entry = { obj: { ...e.obj, id }, meshId: e.meshId }
      if (e.parts !== undefined) copy.parts = e.parts
      if (e.rotate) copy.rotate = [...e.rotate]
      if (e.scale) copy.scale = [...e.scale]
      if (e.settings) copy.settings = { ...e.settings }
      if (e.volumes) copy.volumes = e.volumes.map((v) => ({ ...v, id: `vol-${this.nextVolume++}`, ...(v.settings ? { settings: { ...v.settings } } : {}) }))
      this.entries.set(id, copy)
      for (const h of homes) {
        if (await this.placeOn(h, id, spacing)) continue
        moved.push({ objectId: id, from: h, to: await this.overflowOne(h, id, spacing) })
      }
      ids.push(id)
    }
    this.ranges = this.ranges.map((r) => (r.objects?.includes(e.obj.id) ? { ...r, objects: [...r.objects, ...ids] } : r))
    return { ids, moved }
  }

  /** Where each copy of a plate sits now, by plate object id: its move in X and Y, and whether its footprint is on the bed. */
  private sitting(plateIndex: number): Map<string, Sitting> {
    const out = new Map<string, Sitting>()
    let laid: { objects: PlateObject[]; placements: Placement[] }
    try {
      laid = this.layoutPlate(plateIndex)
    } catch {
      return out
    }
    const bed = this.bed(plateIndex)
    const tol = 0.02
    laid.objects.forEach((o, k) => {
      const p = laid.placements[k]
      if (!p) return
      const [w, d] = p.sizeMm
      const [cx, cy] = p.centerMm
      const onBed = !p.offBed && cx - w / 2 >= bed.x0 - tol && cy - d / 2 >= bed.y0 - tol && cx + w / 2 <= bed.x0 + bed.widthMm + tol && cy + d / 2 <= bed.y0 + bed.depthMm + tol
      out.set(o.id, { at: [o.transform[12] ?? 0, o.transform[13] ?? 0, p.turnDeg], onBed })
    })
    return out
  }

  /** Keeps the copies in the rows of a plate where they sat (`was`), when every one of them has a place there. */
  private keepPlaces(plateIndex: number, was: ReadonlyMap<string, Sitting> | undefined): void {
    const plate = this.layout.find((p) => p.index === plateIndex)
    if (!plate || !was) return
    const at = new Map<string, Spot>()
    for (const item of plate.items) {
      const e = this.entries.get(item.objectId)
      if (!e?.meshId || e.position) continue
      for (let c = 1; c <= item.copies; c++) {
        const s = was.get(`${item.objectId}-${c}`)
        if (!s) return
        at.set(`${item.objectId}-${c}`, s.at)
      }
    }
    if (at.size > 0) this.nested.set(plateIndex, { key: this.nestKey(plateIndex), at })
  }

  /** Takes an empty plate out; the plates after it move up one, with their layouts. */
  private dropPlate(index: number): void {
    this.layout = this.layout.filter((p) => p.index !== index).map((p) => (p.index > index ? { ...p, index: p.index - 1 } : p))
    const shifted = [...this.nested].filter(([i]) => i !== index).map(([i, n]) => [i > index ? i - 1 : i, n] as const)
    this.nested.clear()
    for (const [i, n] of shifted) this.nested.set(i, n)
  }

  /**
   * Whether one copy of the object has room on the plate when it is empty: its outline, brim and skirt inside the bed,
   * turned when `turn` is set (arrange turns copies; placing one, as duplicate does, does not).
   */
  private async fitsEmpty(e: Entry & { meshId: string }, plateIndex: number, spacing: number, turn = false): Promise<boolean> {
    const cfg = this.config(plateIndex)
    const plate = { bed: this.bed(plateIndex), config: cfg, tools: this.toolsOf(cfg, [e]), gapMm: spacing, fixed: [], turn }
    const o = this.nestObject(e, cfg, 1)
    if (this.geom) {
      try {
        return (await fillCount(this.geom, plate, o, 1, this.feet)) >= 1
      } catch {
        // The engine failed: the box, as arrange then places it.
      }
    }
    return boxFillCount(plate, o, 1) >= 1
  }

  /**
   * Puts one copy of a new object on a plate, clear of the bed's edge: in the rows when the plate is in rows and they
   * still fit the bed, else around the copies already there, which stay where they are. False, with the plate as it
   * was, when there is no room.
   */
  private async placeOn(plateIndex: number, objectId: string, spacing: number): Promise<boolean> {
    const plate = this.layout.find((p) => p.index === plateIndex)
    if (!plate) return false
    const nest = this.nested.get(plateIndex)
    const arranged = nest !== undefined && nest.key === this.nestKey(plateIndex)
    const now = this.sitting(plateIndex)
    plate.items.push({ objectId, copies: 1 })
    if (!arranged && [...this.sitting(plateIndex).values()].every((x) => x.onBed)) return true
    const pins = new Map([...now].map(([id, x]) => [id, x.at] as [string, Spot]))
    const r = await this.nestPlan(plateIndex, spacing, pins)
    if (r && r.left.size === 0) return true
    plate.items = plate.items.filter((i) => i.objectId !== objectId)
    return false
  }

  /**
   * Where a copy with no room on plate `from` goes: the last plate when it comes after `from`, has the same printer and
   * settings and has room, else a new plate after the last with `from`'s printer and settings. Returns its number.
   */
  private async overflowOne(from: number, objectId: string, spacing: number): Promise<number> {
    const src = this.layout.find((p) => p.index === from)
    const last = this.layout[this.layout.length - 1]
    if (last && src && last.index > from && last.printerId === src.printerId && JSON.stringify(last.overrides ?? {}) === JSON.stringify(src.overrides ?? {})) {
      if (await this.placeOn(last.index, objectId, spacing)) return last.index
    }
    const index = this.newPlateLike(from)
    // An empty plate holds it (duplicate checked); the rows set it in the middle.
    if (!(await this.placeOn(index, objectId, spacing))) this.layout.find((p) => p.index === index)?.items.push({ objectId, copies: 1 })
    return index
  }

  /** A new plate after the last, with plate `from`'s printer and settings. Returns its number. */
  private newPlateLike(from: number): number {
    const src = this.layout.find((p) => p.index === from)
    const index = this.addPlate()
    const plate = this.layout.find((p) => p.index === index)
    if (plate && src?.printerId) plate.printerId = src.printerId
    if (plate && src?.overrides) plate.overrides = { ...src.overrides }
    return index
  }

  /**
   * Copies with no room on plate `from` (count by object) go to new plates after the last, as many on each as fit,
   * as the app's Arrange moves them. Copies no empty plate holds stay on the last new plate, and count as stuck.
   */
  private async toNewPlates(from: number, left: ReadonlyMap<string, number>, spacing: number): Promise<{ moved: MovedCopies[]; stuck: number }> {
    const moved: MovedCopies[] = []
    let rest = new Map(left)
    while (rest.size > 0) {
      const index = this.newPlateLike(from)
      const plate = this.layout.find((p) => p.index === index)!
      for (const [objectId, copies] of rest) plate.items.push({ objectId, copies })
      const r = await this.nestPlan(index, spacing, new Map(), true)
      const now = r?.left ?? new Map<string, number>()
      const placed = [...rest].map(([objectId, n]) => [objectId, n - (now.get(objectId) ?? 0)] as const).filter(([, n]) => n > 0)
      if (placed.length === 0) {
        // Nothing fits even an empty bed: they stay here, in the rows, and the result says so.
        for (const [objectId, copies] of rest) moved.push({ objectId, copies, from, to: index })
        return { moved, stuck: [...rest.values()].reduce((a, b) => a + b, 0) }
      }
      if (r && now.size > 0) this.commitNest(index, r.at, now)
      for (const [objectId, copies] of placed) moved.push({ objectId, copies, from, to: index })
      rest = new Map(now)
    }
    return { moved, stuck: 0 }
  }

  /**
   * Keeps a nest that left copies over: they come off the plate (their object keeps the copies placed, renumbered in
   * order), and the plate holds the layout of the rest.
   */
  private commitNest(plateIndex: number, at: ReadonlyMap<string, Spot>, left: ReadonlyMap<string, number>): void {
    const plate = this.layout.find((p) => p.index === plateIndex)
    if (!plate) return
    const kept = new Map<string, Spot>()
    for (const item of plate.items) {
      let n = 0
      for (let c = 1; c <= item.copies; c++) {
        const to = at.get(`${item.objectId}-${c}`)
        if (!to) continue
        n++
        kept.set(`${item.objectId}-${n}`, to)
      }
      item.copies -= left.get(item.objectId) ?? 0
    }
    plate.items = plate.items.filter((i) => i.copies > 0)
    this.nested.set(plateIndex, { key: this.nestKey(plateIndex), at: kept })
  }

  /**
   * Nests one plate: every copy in the rows that `pins` does not hold moves, around the copies a client placed and the
   * ones `pins` holds where they are (their move in X and Y). When every copy finds room the plate keeps the layout
   * (by object, with lanes for copies taller than the gantry rod when that clears more); otherwise the plate is left
   * as it was. With `turn` each moving copy may turn about Z where that packs better, as the app's Arrange turns them;
   * held copies keep the turn they have. Returns every copy's move and turn by plate object id and how many copies of
   * each moving object found no room; undefined when nothing moves.
   */
  private async nestPlan(index: number, spacing: number, pins: ReadonlyMap<string, Spot>, turn = false): Promise<{ at: Map<string, Spot>; left: Map<string, number> } | undefined> {
    const geom = this.geom
    const plate = this.layout.find((p) => p.index === index)
    if (!plate) return undefined
    const cfg = this.config(index)
    const moving: NestObject[] = []
    const fixed: NestObject[] = []
    const entries: Entry[] = []
    // The copy numbers of each moving object, in order, and the copies pins hold.
    const free = new Map<string, number[]>()
    const pinned = new Map<string, Spot>()
    for (const item of plate.items) {
      const e = this.entries.get(item.objectId)
      if (!e?.meshId) continue
      entries.push(e)
      const o = this.nestObject(e as Entry & { meshId: string }, cfg, item.copies)
      if (e.position) {
        const [w, d] = o.size
        for (let c = 0; c < item.copies; c++) fixed.push({ ...o, id: `${item.objectId}-${c + 1}`, copies: 1, at: [e.position[0] - w / 2 + c * (w + GAP_MM) - o.min[0], e.position[1] - d / 2 - o.min[1]] })
        continue
      }
      const mine: number[] = []
      for (let c = 1; c <= item.copies; c++) {
        const id = `${item.objectId}-${c}`
        const at = pins.get(id)
        if (!at) {
          mine.push(c)
          continue
        }
        pinned.set(id, [at[0], at[1], at[2]])
        fixed.push({ ...turnedObject(o, at[2]), id, copies: 1, at: [at[0], at[1]] })
      }
      if (mine.length) {
        moving.push({ ...o, copies: mine.length })
        free.set(item.objectId, mine)
      }
    }
    const wanted = moving.reduce((n, o) => n + o.copies, 0)
    if (wanted === 0) return undefined
    const request = { bed: this.bed(index), config: cfg, tools: this.toolsOf(cfg, entries), gapMm: spacing, moving, fixed, center: fixed.length === 0, turn }
    // Copies by number: each object's placements in the order of their copy, on the copy numbers that move.
    const layout = (r: { placements: { id: string; copy: number; angleDeg: number; offset: [number, number] }[] }) => {
      const at = new Map(pinned)
      for (const o of moving) {
        const slots = free.get(o.id) ?? []
        r.placements
          .filter((p) => p.id === o.id)
          .sort((a, b) => a.copy - b.copy)
          .forEach((p, k) => {
            const c = slots[k]
            if (c !== undefined) at.set(`${o.id}-${c}`, [p.offset[0], p.offset[1], turnOf(p.angleDeg)])
          })
      }
      return at
    }
    // The nest on true outlines, or the boxes when there is no engine or it fails.
    let boxes = !geom
    let at: Map<string, Spot> | undefined
    if (geom) {
      try {
        at = layout(await nestPlate(geom, request, this.feet))
      } catch {
        boxes = true
      }
    }
    at ??= layout(boxPlate(request))
    const left = new Map<string, number>()
    for (const o of moving) {
      const slots = free.get(o.id) ?? []
      const n = slots.filter((c) => !at.has(`${o.id}-${c}`)).length
      if (n > 0) left.set(o.id, n)
    }
    if (left.size > 0) return { at, left }
    this.nested.set(index, { key: this.nestKey(index), at })
    // By object, copies taller than the gantry rod need lanes of their own when the nest left one under the gantry.
    const tall = [...moving, ...fixed].filter((o) => overRod(o.size[2], cfg)).reduce((n, o) => n + o.copies, 0)
    const problems = (b: ByObjectReadback | null) => (b ? b.pairs.length + b.tall.length : 0)
    const before = this.byObject(index)
    if (tall < 2 || !before || before.tall.length === 0) return { at, left }
    try {
      const laned = boxes || !geom ? boxInLanes(request) : await nestInLanes(geom, request, this.feet)
      const lanes = laned ? layout(laned) : undefined
      if (!lanes || lanes.size < at.size) return { at, left }
      this.nested.set(index, { key: this.nestKey(index), at: lanes })
      if (problems(this.byObject(index)) >= problems(before)) this.nested.set(index, { key: this.nestKey(index), at })
      else return { at: lanes, left }
    } catch {
      // The plain layout stays.
    }
    return { at, left }
  }

  /** An object as the nest takes it: its mesh as placed, without the move, and its settings over the plate's. */
  private nestObject(e: Entry & { meshId: string }, cfg: Record<string, SettingValue>, copies: number): NestObject {
    const placed = this.placedBounds(e)
    const meshId = e.meshId
    const enforcers = (e.volumes ?? []).some((v) => v.role === 'support_enforcer') || this.host.parts(meshId).some((p) => Object.keys(p.paint?.support ?? {}).length > 0)
    return { id: e.obj.id, meshId, parts: () => this.host.parts(meshId), linear: this.orientation(e), size: placed.size, min: placed.min, config: { ...cfg, ...e.settings }, enforcers, copies }
  }

  /** How many filaments the printed objects use, with their modifiers (see plateTools). */
  private toolsOf(cfg: Record<string, SettingValue>, entries: readonly Entry[]): number {
    const configs = entries.filter((e) => e.printable !== false).flatMap((e) => {
      const own = { ...cfg, ...e.settings }
      return [own, ...(e.volumes ?? []).filter((v) => v.role === 'modifier' && v.settings).map((v) => ({ ...own, ...v.settings }))]
    })
    return plateTools(configs.length ? configs : [cfg])
  }

  /** What an arranged layout holds for: the plate's copies, their rotation, scale and place, and the bed. */
  private nestKey(plateIndex: number): string {
    const plate = this.layout.find((p) => p.index === plateIndex)
    const cfg = this.config(plateIndex)
    const items = (plate?.items ?? []).map((i) => {
      const e = this.entries.get(i.objectId)
      return [i.objectId, i.copies, e?.meshId, e?.rotate, e?.scale, e?.position]
    })
    return JSON.stringify([cfg['printable_area'], cfg['bed_exclude_area'], cfg['head_wrap_detect_zone'], items])
  }

  private rowCapacity(objectId: string, bed: { x: number; y: number; round?: boolean }, spacing: number, plateIndex: number): number {
    const e = this.entries.get(objectId)
    if (!e?.meshId) return 0
    const [w, d] = this.placedBounds(e as Entry & { meshId: string }).size
    const actual = this.bed(plateIndex)
    bed = { x: Math.min(bed.x, actual.widthMm), y: Math.min(bed.y, actual.depthMm), round: bed.round || Boolean(actual.circle) }
    const margins = this.rowMargins(plateIndex, [e])
    const gap = Math.max(spacing, margins.gap)
    const { edge } = margins
    let n = Math.min(500, Math.max(0, Math.floor((bed.x - 2 * edge + gap) / (w + gap))) * Math.max(0, Math.floor((bed.y - 2 * edge + gap) / (d + gap))))
    if (bed.round) {
      const c = { cx: bed.x / 2, cy: bed.y / 2, r: Math.min(bed.x, bed.y) / 2 }
      while (n > 0 && roundRows(Array.from({ length: n }, () => ({ w, d })), c, edge, margins.gap).some(([x, y]) => pastRim({ ...c, r: c.r - edge }, { x0: x, y0: y, x1: x + w, y1: y + d }))) n--
    }
    return n
  }

  /** The object's rotation and scale as one 4x4 (column-major, scale first), with no move. */
  private orientation(e: Entry): number[] {
    const m = e.rotate ? [...rotationMatrix(e.rotate)] : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    const s = e.scale ?? [1, 1, 1]
    for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) m[col * 4 + row] = (m[col * 4 + row] ?? 0) * (s[col] ?? 1)
    return m
  }

  /** Size and lowest corner of an object as placed: rotation and scale applied. */
  private placedBounds(e: Entry & { meshId: string }): { size: [number, number, number]; min: [number, number, number] } {
    return this.host.boundsAfter(e.meshId, this.orientation(e))
  }

  /**
   * Every copy on a plate with its transform. Copies a client placed (slicerx_project_move) go exactly where it put
   * them; the rest go in rows, and the rows move to the middle of the printable area (from its own corner, so a bed that
   * does not start at 0 works too). On a round bed (a delta) each row is centered and no wider than the circle is at
   * that row, the edge room kept, so no part in the rows reaches past the rim; a placed copy past the rim stays where it
   * is and its placement says offBed. Nothing downstream re-centers the plate: the sx CLI slices it where it is, and a
   * layout left in the front left corner put a skirt or brim off the bed. Every object sits on the bed (its lowest
   * point at Z 0).
   */
  private layoutPlate(plateIndex: number): { objects: PlateObject[]; placements: Placement[] } {
    const bed = this.bed(plateIndex)
    const plate = this.layout.find((p) => p.index === plateIndex)
    if (!plate) throw new Error(`No plate ${plateIndex}`)
    const objects: PlateObject[] = []
    const placements: Placement[] = []
    // Copies in the rows: their index in objects and their footprint. They are set down at 0, 0 and moved once the
    // rows are laid.
    const rowed: number[] = []
    const feet: Foot[] = []
    for (const item of plate.items) {
      const e = this.entries.get(item.objectId)
      if (!e?.meshId) continue
      const placed = this.placedBounds(e as Entry & { meshId: string })
      const [w, d] = placed.size
      const [mx, my, mz] = placed.min
      const m = this.orientation(e)
      for (let c = 0; c < item.copies; c++) {
        // Further copies of a placed object line up to its right.
        const at: [number, number] = e.position ? [e.position[0] - w / 2 + c * (w + GAP_MM), e.position[1] - d / 2] : [0, 0]
        if (!e.position) {
          rowed.push(objects.length)
          feet.push({ w, d })
        }
        const id = `${item.objectId}-${c + 1}`
        // Rotation and scale first (the upper 3x3), then the move that sets the part down at its place.
        const o: PlateObject = { id, name: e.obj.name, mesh: e.meshId, transform: [...m.slice(0, 12), at[0] - mx, at[1] - my, -mz, 1] }
        if (e.settings && Object.keys(e.settings).length) o.settings = { ...e.settings }
        if (e.volumes?.length) o.volumes = e.volumes.map((v) => ({ name: v.name, role: v.role, mesh: v.meshId, ...(v.settings ? { settings: { ...v.settings } } : {}) }))
        objects.push(o)
        placements.push({ id, objectId: item.objectId, copy: c + 1, centerMm: [at[0] + w / 2, at[1] + d / 2], sizeMm: placed.size, manual: Boolean(e.position), turnDeg: 0, ...(e.printable === false ? { printable: false as const } : {}) })
      }
    }
    const entries = plate.items.flatMap((item) => {
      const entry = this.entries.get(item.objectId)
      return entry ? [entry] : []
    })
    // The last arrange's layout while the plate holds the same copies, else the rows.
    const nest = this.nested.get(plateIndex)
    const nested = nest && nest.key === this.nestKey(plateIndex) && rowed.every((i) => nest.at.has(objects[i]?.id ?? '')) ? nest.at : undefined
    const { edge, gap } = this.rowMargins(plateIndex, entries)
    const spots = nested ? [] : bed.circle ? roundRows(feet, bed.circle, edge, gap) : boxRows(feet, bed, edge, gap)
    rowed.forEach((i, k) => {
      const o = objects[i]
      const p = placements[i]
      if (!o || !p) return
      // The nest gives the whole move in X and Y and the turn; the rows give the front left corner.
      const to = nested?.get(o.id)
      if (to && to[2]) {
        // Turned about Z after the rotation and scale: its box, and so its center and size, follow the turn.
        const linear = turnedLinear(o.transform.slice(0, 12).concat([0, 0, 0, 1]), to[2])
        const turned = this.host.boundsAfter(o.mesh, linear)
        o.transform = [...linear.slice(0, 12), to[0], to[1], o.transform[14] ?? 0, 1]
        p.centerMm = [to[0] + turned.min[0] + turned.size[0] / 2, to[1] + turned.min[1] + turned.size[1] / 2]
        p.sizeMm = turned.size
        p.turnDeg = to[2]
        return
      }
      const at: [number, number] | undefined = to ? [to[0] - (o.transform[12] ?? 0), to[1] - (o.transform[13] ?? 0)] : spots[k]
      if (!at) return
      o.transform[12] = (o.transform[12] ?? 0) + at[0]
      o.transform[13] = (o.transform[13] ?? 0) + at[1]
      p.centerMm = [p.centerMm[0] + at[0], p.centerMm[1] + at[1]]
    })
    for (const p of placements) {
      const [w, d] = p.sizeMm
      if (bed.circle && pastRim(bed.circle, { x0: p.centerMm[0] - w / 2, y0: p.centerMm[1] - d / 2, x1: p.centerMm[0] + w / 2, y1: p.centerMm[1] + d / 2 })) p.offBed = true
      p.centerMm = [round2(p.centerMm[0]), round2(p.centerMm[1])]
    }
    return { objects, placements }
  }

  /** The plate as the slice gets it: every copy where it sits, without the objects left out of the print. */
  async plate(plateIndex: number): Promise<Plate> {
    const bed = this.bed(plateIndex)
    const { objects, placements } = this.layoutPlate(plateIndex)
    const printed = objects.filter((_o, k) => placements[k]?.printable !== false)
    if (printed.length === 0 && objects.length > 0) throw new ToolInputError(`Every object on plate ${plateIndex} is left out of the print. slicerx_project_printable puts one back.`)
    return { bed: { widthMm: bed.widthMm, depthMm: bed.depthMm, heightMm: bed.heightMm, ...(bed.circle ? { round: true } : {}) }, objects: printed }
  }

  /** Where every copy of a plate sits, as the slice will place it. */
  placements(plateIndex: number): Placement[] {
    return this.layoutPlate(plateIndex).placements
  }

  /**
   * Replaces objects with others (cut parts, a repaired or hollowed mesh). Each replacement's geometry is
   * loaded, so it slices; a replacement that keeps an object's id keeps its rotation, scale, place, settings and volumes.
   */
  async replaceObjects(ids: string[], replacements: ProjectObject[]): Promise<void> {
    // A mesh swapped in place (a repair, a hollow) keeps a locked object where it is; a cut into parts does not.
    for (const id of ids) {
      const e = this.entries.get(id)
      const inPlace = replacements.length === 1 && replacements[0]?.id === id
      if (e && !inPlace) unlocked(e)
    }
    const loaded = await Promise.all(
      replacements.map(async (r): Promise<Entry> => {
        const parts = r.mesh ? await r.mesh() : []
        if (parts.length === 0) return { obj: r }
        const handle = await this.host.loadParts(r.name, parts)
        return { obj: { ...r, triangles: handle.triangles, mesh: async () => this.host.parts(handle.id) }, meshId: handle.id }
      }),
    )
    const before = new Map(ids.map((id) => [id, this.entries.get(id)]))
    for (const id of ids) this.entries.delete(id)
    for (const e of loaded) {
      const old = before.get(e.obj.id)
      const kept: Entry = { ...e }
      if (old?.rotate) kept.rotate = old.rotate
      if (old?.scale) kept.scale = old.scale
      if (old?.position) kept.position = old.position
      if (old?.settings) kept.settings = old.settings
      if (old?.volumes) kept.volumes = old.volumes
      this.entries.set(e.obj.id, kept)
    }
    for (const p of this.layout) p.items = p.items.filter((i) => !ids.includes(i.objectId))
    const first = this.layout[0]
    if (first) for (const r of replacements) first.items.push({ objectId: r.id, copies: 1 })
    this.ranges = this.ranges.map((r) => (r.objects ? { ...r, objects: r.objects.filter((o) => !ids.includes(o) || replacements.some((x) => x.id === o)) } : r))
  }

  private entry(objectId: string): Entry & { meshId: string } {
    const e = this.entries.get(objectId) ?? [...this.entries.values()].find((x) => x.obj.name === objectId)
    if (!e) throw new ToolInputError(`No object ${objectId}. slicerx_project_show lists them.`)
    if (!e.meshId) throw new ToolInputError(`${e.obj.name} has no mesh to place.`)
    return e as Entry & { meshId: string }
  }

  private refreshBox(e: Entry & { meshId: string }): void {
    const s = this.placedBounds(e).size
    e.obj = { ...e.obj, bboxMm: [round2(s[0]), round2(s[1]), round2(s[2])] }
  }

  /** Puts an object's footprint center at (x, y) on the bed, or back in the rows with null. */
  move(objectId: string, position: [number, number] | null): string {
    const e = unlocked(this.entry(objectId))
    if (position) e.position = position
    else delete e.position
    return e.obj.id
  }

  /** Scale per axis, 1 as modeled; [1, 1, 1] clears it. */
  setScale(objectId: string, scale: [number, number, number]): string {
    const e = unlocked(this.entry(objectId))
    if (scale.every((v) => v === 1)) delete e.scale
    else e.scale = scale
    this.refreshBox(e)
    return e.obj.id
  }

  /** Sets and clears an object's own settings. */
  setOwnSettings(objectId: string, set: Record<string, SettingValue>, clear: string[]): Record<string, SettingValue> {
    const e = this.entry(objectId)
    const next = { ...(e.settings ?? {}) }
    for (const k of clear) delete next[k]
    for (const [k, v] of Object.entries(set)) next[k] = toSchemaValue(this.store.setting(k), v)
    if (Object.keys(next).length) e.settings = next
    else delete e.settings
    return next
  }

  /** Adds a volume whose mesh the host already holds. */
  addHeldVolume(objectId: string, v: Omit<ProjectVolume, 'id'>): ProjectVolume {
    const e = this.entry(objectId)
    const settings = v.settings ? Object.fromEntries(Object.entries(v.settings).map(([k, x]) => [k, toSchemaValue(this.store.setting(k), x)])) : undefined
    const volume: ProjectVolume = { ...v, id: `vol-${this.nextVolume++}`, ...(settings ? { settings } : {}) }
    e.volumes = [...(e.volumes ?? []), volume]
    return volume
  }

  /**
   * Adds a volume by shape and size, centered in the object's own coordinates: what region_modifiers places with
   * apply (a ring round a hole, a named region), as the app does.
   */
  async addVolume(objectId: string, v: VolumeSpec): Promise<{ id: string }> {
    this.entry(objectId)
    const positions = shapePositions(v.shape, v.centerMm)
    const handle = await this.host.loadParts(v.name, [{ name: v.name, slot: 1, positions, indices: Uint32Array.from({ length: positions.length / 3 }, (_, k) => k) }])
    const shape = `${shapeWords(v.shape)} at [${v.centerMm.map(round2).join(', ')}]`
    return { id: this.addHeldVolume(objectId, { name: v.name, role: v.role, meshId: handle.id, shape, ...(v.settings ? { settings: v.settings } : {}) }).id }
  }

  /** An object's volumes, for a pilot function's read-back. */
  volumes(objectId: string): PilotVolume[] {
    return (this.entry(objectId).volumes ?? []).map((v) => ({ id: v.id, name: v.name, role: v.role, ...(v.settings ? { settings: { ...v.settings } } : {}) }))
  }

  /** Merges settings into an object's own, as slicerx_project_object_settings does without clearing any. */
  setObjectSettings(objectId: string, changes: Record<string, SettingValue>): void {
    this.setOwnSettings(objectId, changes, [])
  }

  objectSettings(objectId: string): Record<string, SettingValue> {
    return { ...(this.entry(objectId).settings ?? {}) }
  }

  removeVolume(objectId: string, volumeId: string): void {
    const e = this.entry(objectId)
    if (!e.volumes?.some((v) => v.id === volumeId)) throw new ToolInputError(`${e.obj.name} has no volume ${volumeId}`)
    e.volumes = e.volumes.filter((v) => v.id !== volumeId)
    if (e.volumes.length === 0) delete e.volumes
  }

  /** The object's own size and lowest corner as modeled, for placing volumes in its coordinates. */
  modelBounds(objectId: string): { min: [number, number, number]; max: [number, number, number] } {
    const e = this.entry(objectId)
    const b = this.host.boundsAfter(e.meshId, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    return { min: b.min.map(round2) as [number, number, number], max: b.min.map((m, i) => round2(m + (b.size[i] ?? 0))) as [number, number, number] }
  }

  heightRanges(): ProjectHeightRange[] {
    return this.ranges.map((r) => ({ ...r, settings: { ...r.settings }, ...(r.objects ? { objects: [...r.objects] } : {}) }))
  }

  setHeightRanges(ranges: ProjectHeightRange[]): void {
    for (const r of ranges) for (const o of r.objects ?? []) this.entry(o)
    this.ranges = ranges.map((r) => ({
      zFromMm: r.zFromMm,
      zToMm: r.zToMm,
      settings: Object.fromEntries(Object.entries(r.settings).map(([k, v]) => [k, toSchemaValue(this.store.setting(k), v)])),
      ...(r.objects ? { objects: r.objects.map((o) => this.entry(o).obj.id) } : {}),
    }))
  }

  /** The height ranges for a plate the slice was built from, naming its plate objects (every copy). */
  heightRangesFor(plate: Plate): HeightRange[] {
    if (this.ranges.length === 0) return []
    const objectOf = (plateObjectId: string): string => plateObjectId.replace(/-\d+$/, '')
    return this.ranges.flatMap((r) => {
      if (!r.objects) return [{ zFromMm: r.zFromMm, zToMm: r.zToMm, settings: r.settings }]
      const ids = plate.objects.filter((o) => r.objects?.includes(objectOf(o.id))).map((o) => o.id)
      return ids.length ? [{ zFromMm: r.zFromMm, zToMm: r.zToMm, settings: r.settings, objects: ids }] : []
    })
  }

  /** Adds an empty plate and returns its number. */
  addPlate(): number {
    const index = Math.max(0, ...this.layout.map((p) => p.index)) + 1
    this.layout.push({ index, items: [] })
    return index
  }

  /** Removes a plate; its objects go to `moveTo`, or the plate must be empty. Plates after it move up one. */
  removePlate(index: number, moveTo?: number): void {
    const plate = this.layout.find((p) => p.index === index)
    if (!plate) throw new ToolInputError(`No plate ${index}`)
    if (plate.items.length && moveTo === undefined) throw new ToolInputError(`Plate ${index} holds ${plate.items.length} object(s). Name a plate to move them to (move_to), or move them first.`)
    if (moveTo !== undefined) {
      const target = this.layout.find((p) => p.index === moveTo)
      if (!target || moveTo === index) throw new ToolInputError(`No other plate ${moveTo} to move the objects to`)
      for (const item of plate.items) addItem(target, item.objectId, item.copies)
    }
    this.layout = this.layout.filter((p) => p !== plate).map((p) => (p.index > index ? { ...p, index: p.index - 1 } : p))
  }

  /** Moves every copy of an object to one plate. */
  moveToPlate(objectId: string, index: number): void {
    const e = unlocked(this.entry(objectId))
    const target = this.layout.find((p) => p.index === index)
    if (!target) throw new ToolInputError(`No plate ${index}. slicerx_project_plate_add makes one.`)
    let copies = 0
    for (const p of this.layout) {
      for (const i of p.items) if (i.objectId === e.obj.id) copies += i.copies
      p.items = p.items.filter((i) => i.objectId !== e.obj.id)
    }
    addItem(target, e.obj.id, Math.max(1, copies))
  }

  /** Gives an object a new name; its id stays. */
  rename(objectId: string, name: string): string {
    const e = this.entries.get(objectId) ?? [...this.entries.values()].find((x) => x.obj.name === objectId)
    if (!e) throw new ToolInputError(`No object ${objectId}. slicerx_project_show lists them.`)
    const clean = name.trim()
    if (!clean) throw new ToolInputError('The new name is empty.')
    if (/^obj-\d+$/.test(clean)) throw new ToolInputError(`${clean} reads as an object id; pick another name.`)
    e.obj = { ...e.obj, name: clean }
    return e.obj.id
  }

  /** Locks or unlocks an object, as Lock on the ring does. */
  setLocked(objectId: string, locked: boolean): string {
    const e = this.entry(objectId)
    if (locked) e.locked = true
    else delete e.locked
    return e.obj.id
  }

  /** Puts an object in the print or leaves it out, as Leave out of the print does in the app. It keeps its place. */
  setPrintable(objectId: string, printable: boolean): string {
    const e = this.entry(objectId)
    if (printable) delete e.printable
    else e.printable = false
    return e.obj.id
  }

  /** Centers an object's footprint on its plate's bed, as Center on the bed does; it stays there. */
  center(objectId: string): { id: string; position: [number, number] } {
    const e = unlocked(this.entry(objectId))
    const plate = this.layout.find((p) => p.items.some((i) => i.objectId === e.obj.id))?.index ?? 1
    const bed = this.bed(plate)
    const position: [number, number] = bed.circle ? [round2(bed.circle.cx), round2(bed.circle.cy)] : [round2(bed.x0 + bed.widthMm / 2), round2(bed.y0 + bed.depthMm / 2)]
    e.position = position
    return { id: e.obj.id, position }
  }

  /** The separate bodies of an object's mesh, as modeled. */
  private bodies(e: Entry & { meshId: string }): Float32Array[] {
    return splitBodies(positionsFromParts(this.host.parts(e.meshId)))
  }

  /**
   * Split to parts: each separate body becomes a part of the same object, as Split to parts does in the app. The
   * object keeps its id, place, rotation, scale, settings and volumes. Returns the part count.
   */
  async splitParts(objectId: string): Promise<{ id: string; parts: number }> {
    const e = this.entry(objectId)
    const bodies = this.bodies(e)
    if (bodies.length <= (e.parts ?? 1)) throw new ToolInputError(`${e.obj.name} is one piece; there is nothing to split.`)
    const handle = await this.host.loadParts(e.obj.name, bodies.map((positions, k) => ({ name: `${e.obj.name} part ${k + 1}`, slot: 1, positions, indices: Uint32Array.from({ length: positions.length / 3 }, (_, v) => v) })))
    e.meshId = handle.id
    e.parts = bodies.length
    e.obj = { ...e.obj, triangles: handle.triangles, mesh: async () => this.host.parts(handle.id) }
    return { id: e.obj.id, parts: bodies.length }
  }

  /**
   * Split to objects: each separate body becomes an object of its own, named after the source with a number, as Split
   * to objects does in the app. Each keeps the source's rotation, scale, settings, volumes, lock and print state, on
   * the same plates with the same copies; a source a client placed leaves each piece where it was. Height ranges for
   * the source cover the pieces. The source goes. Returns the new ids.
   */
  async splitObjects(objectId: string): Promise<string[]> {
    const e = this.entry(objectId)
    const bodies = this.bodies(e)
    if (bodies.length < 2) throw new ToolInputError(`${e.obj.name} is one piece; there is nothing to split.`)
    const src = this.placedBounds(e)
    const mid = (b: { size: [number, number, number]; min: [number, number, number] }, k: 0 | 1): number => b.min[k] + b.size[k] / 2
    const made: Entry[] = []
    for (const [k, positions] of bodies.entries()) {
      const id = `obj-${this.nextId++}`
      const name = `${e.obj.name} ${k + 1}`
      const handle = await this.host.loadParts(name, [{ name, slot: 1, positions, indices: Uint32Array.from({ length: positions.length / 3 }, (_, v) => v) }])
      const piece: Entry = { obj: { id, name, bboxMm: handle.bboxMm, triangles: handle.triangles, mesh: async () => this.host.parts(handle.id) }, meshId: handle.id }
      if (e.rotate) piece.rotate = [...e.rotate]
      if (e.scale) piece.scale = [...e.scale]
      if (e.settings) piece.settings = { ...e.settings }
      if (e.volumes) piece.volumes = e.volumes.map((v) => ({ ...v, id: `vol-${this.nextVolume++}`, ...(v.settings ? { settings: { ...v.settings } } : {}) }))
      if (e.locked) piece.locked = true
      if (e.printable === false) piece.printable = false
      const at = this.placedBounds(piece as Entry & { meshId: string })
      if (e.position) piece.position = [round2(e.position[0] + mid(at, 0) - mid(src, 0)), round2(e.position[1] + mid(at, 1) - mid(src, 1))]
      piece.obj = { ...piece.obj, bboxMm: at.size.map(round2) as [number, number, number] }
      made.push(piece)
    }
    const ids = made.map((m) => m.obj.id)
    // The pieces take the source's place in the list, so the objects keep their order.
    const order = [...this.entries.entries()]
    this.entries.clear()
    for (const [id, x] of order) {
      if (id !== e.obj.id) this.entries.set(id, x)
      else for (const m of made) this.entries.set(m.obj.id, m)
    }
    for (const p of this.layout) p.items = p.items.flatMap((i) => (i.objectId === e.obj.id ? ids.map((id) => ({ objectId: id, copies: i.copies })) : [i]))
    this.ranges = this.ranges.map((r) => (r.objects?.includes(e.obj.id) ? { ...r, objects: r.objects.flatMap((o) => (o === e.obj.id ? ids : [o])) } : r))
    return ids
  }

  /** An object's id, rotation and scale, for turning a face of its mesh as modeled. */
  pose(objectId: string): { id: string; rotate: [number, number, number]; scale: [number, number, number] } {
    const e = this.entry(objectId)
    return { id: e.obj.id, rotate: e.rotate ?? [0, 0, 0], scale: e.scale ?? [1, 1, 1] }
  }

  /** Takes an object out of the project. */
  removeObject(objectId: string): void {
    const e = this.entry(objectId)
    this.entries.delete(e.obj.id)
    for (const p of this.layout) p.items = p.items.filter((i) => i.objectId !== e.obj.id)
    this.ranges = this.ranges.flatMap((r) => {
      if (!r.objects) return [r]
      const left = r.objects.filter((o) => o !== e.obj.id)
      return left.length ? [{ ...r, objects: left }] : []
    })
  }

  describe(): Record<string, unknown> {
    const plateOf = (id: string): number[] => this.layout.filter((p) => p.items.some((i) => i.objectId === id)).map((p) => p.index)
    return {
      name: this.name,
      settings: this.settings,
      machine: this.machine() ?? null,
      objects: this.objects().map((o) => {
        const e = this.entries.get(o.id)
        return {
          id: o.id,
          name: o.name,
          bbox_mm: o.bboxMm,
          triangles: o.triangles ?? null,
          has_mesh: Boolean(e?.meshId),
          parts: e?.parts ?? 1,
          ...(e?.meshId ? { model_bounds: this.modelBounds(o.id) } : {}),
          plates: plateOf(o.id),
          rotate: e?.rotate ?? [0, 0, 0],
          scale: e?.scale ?? [1, 1, 1],
          position: e?.position ?? null,
          locked: Boolean(e?.locked),
          printable: e?.printable !== false,
          settings: e?.settings ?? {},
          volumes: (e?.volumes ?? []).map((v) => ({ id: v.id, name: v.name, role: v.role, shape: v.shape, ...(v.settings ? { settings: v.settings } : {}) })),
        }
      }),
      bed: describeBed(this.bed(this.layout[0]?.index ?? 1)),
      plates: this.plates().map((p) => ({ ...p, placements: this.safePlacements(p.index), ...this.safeByObject(p.index) })),
      filaments: this.filaments(),
      overrides: this.projectOverrides,
      height_ranges: this.heightRanges(),
    }
  }

  private safeByObject(index: number): { byObject?: ByObjectReadback } {
    try {
      const plan = this.byObject(index)
      return plan ? { byObject: plan } : {}
    } catch {
      return {}
    }
  }

  private safePlacements(index: number): Placement[] {
    try {
      return this.placements(index)
    } catch {
      return []
    }
  }
}

/** The entry, when it is not locked; a locked one is refused with how to unlock it. */
function unlocked<E extends Entry>(e: E): E {
  if (e.locked) throw new ToolInputError(`${e.obj.name} is locked. Unlock it first with slicerx_project_lock (locked: false).`)
  return e
}

function addItem(plate: ProjectPlate, objectId: string, copies: number): void {
  const at = plate.items.find((i) => i.objectId === objectId)
  if (at) at.copies += copies
  else plate.items.push({ objectId, copies })
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/** A turn in degrees as the read-back gives it: from 0 up to 360, to a hundredth. */
function turnOf(deg: number): number {
  const d = round2(((deg % 360) + 360) % 360)
  return d >= 360 ? 0 : d
}

function shapePositions(shape: VolumeShape, center: [number, number, number]): Float32Array {
  if (shape.kind === 'box') return boxPositions(shape.sizeMm, center)
  if (shape.kind === 'cylinder') return cylinderPositions(shape.diameterMm, shape.heightMm, center)
  return spherePositions(shape.diameterMm, center)
}

/** The shape as slicerx_project_add_volume words it in the read-back. */
function shapeWords(shape: VolumeShape): string {
  if (shape.kind === 'box') return `box ${shape.sizeMm.map(round2).join(' x ')} mm`
  if (shape.kind === 'cylinder') return `cylinder ${round2(shape.diameterMm)} mm across, ${round2(shape.heightMm)} mm tall,`
  return `sphere ${round2(shape.diameterMm)} mm across`
}
