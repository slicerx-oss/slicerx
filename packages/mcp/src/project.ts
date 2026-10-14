// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The project an MCP client works on: models, plates and settings, held in
// memory by the server. mimir's skills (orient, arrange, cut, slice,
// estimate) read and change it through the PilotProject interface.
import type { HeightRange, MeshPart, PilotMachine, Plate, PlateObject, PrintConfig, SettingValue, VolumeRole } from '@slicerx/contracts'
import { rotationMatrix, type PilotProject, type ProjectObject, type ProjectPlate, type ProjectVolume as PilotVolume, type VolumeShape, type VolumeSpec } from '@slicerx/pilot'
import type { DataStore } from './data'
import type { ProfileCatalog } from './profiles'
import { isGcodeKey, SHIPPED_GCODE_SOURCES } from './config'
import { ToolInputError } from './models'
import { defaultConfig, sameValue, toSchemaValue } from './settings'
import { positionsFromParts, type NodeSlicerHost } from './slicerhost'
import { defaultFilament, filamentColor, filamentType, listFilaments, MAX_FILAMENTS, type FilamentSetup, type ProjectFilament } from './filaments'
import { bedArea, boxRows, describeBed, GAP_MM, pastRim, roundRows, type BedArea, type Foot } from './bed'
import { boxPositions, cylinderPositions, spherePositions, splitBodies } from './mesh'

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

  constructor(
    settings: ProjectSettings,
    private readonly store: DataStore,
    private readonly profiles: ProfileCatalog,
    private readonly host: NodeSlicerHost,
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

  setOverrides(changes: Record<string, SettingValue>): void {
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
        // A profile SlicerX does not ship sets G-code it cannot vouch for.
        if (!SHIPPED_GCODE_SOURCES.has(p.source)) return false
        shipped[k] = v
      }
    }
    return Object.entries(config).every(([k, v]) => !isGcodeKey(k) || sameValue(v, shipped[k]))
  }

  config(plateIndex: number): PrintConfig {
    const plate = this.layout.find((p) => p.index === plateIndex)
    return { ...this.baseConfig(), ...this.filamentConfig(), ...this.projectOverrides, ...(plate?.overrides ?? {}) } as PrintConfig
  }

  /** The plate's bed: the box of its printable area and, for a delta, the circle. */
  private bed(plateIndex: number): BedArea {
    return bedArea(this.config(plateIndex))
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
        placements.push({ id, objectId: item.objectId, copy: c + 1, centerMm: [at[0] + w / 2, at[1] + d / 2], sizeMm: placed.size, manual: Boolean(e.position), ...(e.printable === false ? { printable: false as const } : {}) })
      }
    }
    const spots = bed.circle ? roundRows(feet, bed.circle) : boxRows(feet, bed)
    rowed.forEach((i, k) => {
      const o = objects[i]
      const p = placements[i]
      const at = spots[k]
      if (!o || !p || !at) return
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

  /**
   * Copies an object as new objects of their own, as Duplicate does in the app: the same mesh, rotation, scale,
   * settings and volumes, on the same plates, in the automatic rows. Height ranges for the object cover the copies.
   */
  duplicate(objectId: string, count: number): string[] {
    const e = this.entry(objectId)
    const ids: string[] = []
    for (let k = 0; k < count; k++) {
      const id = `obj-${this.nextId++}`
      const copy: Entry = { obj: { ...e.obj, id }, meshId: e.meshId }
      if (e.parts !== undefined) copy.parts = e.parts
      if (e.rotate) copy.rotate = [...e.rotate]
      if (e.scale) copy.scale = [...e.scale]
      if (e.settings) copy.settings = { ...e.settings }
      if (e.volumes) copy.volumes = e.volumes.map((v) => ({ ...v, id: `vol-${this.nextVolume++}`, ...(v.settings ? { settings: { ...v.settings } } : {}) }))
      this.entries.set(id, copy)
      for (const p of this.layout) if (p.items.some((i) => i.objectId === e.obj.id)) p.items.push({ objectId: id, copies: 1 })
      ids.push(id)
    }
    this.ranges = this.ranges.map((r) => (r.objects?.includes(e.obj.id) ? { ...r, objects: [...r.objects, ...ids] } : r))
    return ids
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
      plates: this.plates().map((p) => ({ ...p, placements: this.safePlacements(p.index) })),
      filaments: this.filaments(),
      overrides: this.projectOverrides,
      height_ranges: this.heightRanges(),
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
