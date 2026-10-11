// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The project an MCP client works on: models, plates and settings, held in
// memory by the server. mimir's skills (orient, arrange, cut, slice,
// estimate) read and change it through the PilotProject interface.
import type { HeightRange, MeshPart, PilotMachine, Plate, PlateObject, PrintConfig, SettingValue, VolumeRole } from '@slicerx/contracts'
import { rotationMatrix, type PilotProject, type ProjectObject, type ProjectPlate } from '@slicerx/pilot'
import type { DataStore } from './data'
import type { ProfileCatalog } from './profiles'
import { isGcodeKey, SHIPPED_GCODE_SOURCES } from './config'
import { ToolInputError } from './models'
import { defaultConfig, sameValue, toSchemaValue } from './settings'
import type { NodeSlicerHost } from './slicerhost'
import { defaultFilament, filamentColor, filamentType, listFilaments, MAX_FILAMENTS, type FilamentSetup, type ProjectFilament } from './filaments'

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
}

export interface ProjectSettings {
  name: string
  /** Profile ids from slicerx_list_profiles, applied in order. */
  profiles: string[]
  printer?: string
  filament?: string
  nozzle?: number
}

const GAP_MM = 5
/** Room a row leaves at each side of the bed, for a skirt or brim around the parts at its ends. */
const EDGE_MM = 10

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
    e.rotate = rotate
    if (e.meshId) e.obj = { ...e.obj, bboxMm: this.placedBounds(e as Entry & { meshId: string }).size }
  }

  objects(): ProjectObject[] {
    return [...this.entries.values()].map((e) => e.obj)
  }

  plates(): ProjectPlate[] {
    return this.layout.map((p) => ({ ...p, items: p.items.map((i) => ({ ...i })) }))
  }

  setPlates(plates: ProjectPlate[]): void {
    this.layout = plates.map((p) => ({ ...p, items: p.items.map((i) => ({ ...i })) }))
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

  /** Bed size and its corner from the plate's config. */
  private bed(plateIndex: number): { x0: number; y0: number; width: number; depth: number; height: number } {
    const cfg = this.config(plateIndex)
    const area = Array.isArray(cfg['printable_area']) ? (cfg['printable_area'] as unknown[]) : []
    const xs = area.flatMap((p) => (Array.isArray(p) && typeof p[0] === 'number' ? [p[0]] : []))
    const ys = area.flatMap((p) => (Array.isArray(p) && typeof p[1] === 'number' ? [p[1]] : []))
    const x0 = xs.length ? Math.min(...xs) : 0
    const y0 = ys.length ? Math.min(...ys) : 0
    return { x0, y0, width: xs.length ? Math.max(...xs) - x0 : 256, depth: ys.length ? Math.max(...ys) - y0 : 256, height: num(cfg['printable_height']) ?? 250 }
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
   * Every copy on a plate with its transform. Copies a client placed (slicerx_project_move) go where it put them; the
   * rest go in rows, and the rows move to the middle of the printable area (from its own corner, so a bed that does not
   * start at 0 works too). Nothing downstream re-centers it: the sx CLI slices the plate where it is, and a layout left
   * in the front left corner put a skirt or brim off the bed. Every object sits on the bed (its lowest point at Z 0).
   */
  private layoutPlate(plateIndex: number): { objects: PlateObject[]; placements: Placement[] } {
    const { x0, y0, width, depth } = this.bed(plateIndex)
    const plate = this.layout.find((p) => p.index === plateIndex)
    if (!plate) throw new Error(`No plate ${plateIndex}`)
    const objects: PlateObject[] = []
    const placements: Placement[] = []
    const rowed: number[] = []
    // The rows' own extent, to center them once every copy is placed.
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
    // A row ends before it would reach into the edge room at either side; a part wider than that still gets a row.
    const rowWidth = width - 2 * EDGE_MM
    let x = 0
    let y = 0
    let rowDepth = 0
    for (const item of plate.items) {
      const e = this.entries.get(item.objectId)
      if (!e?.meshId) continue
      const placed = this.placedBounds(e as Entry & { meshId: string })
      const [w, d] = placed.size
      const [mx, my, mz] = placed.min
      const m = this.orientation(e)
      for (let c = 0; c < item.copies; c++) {
        let at: [number, number]
        if (e.position) {
          // Further copies of a placed object line up to its right.
          at = [e.position[0] - w / 2 + c * (w + GAP_MM), e.position[1] - d / 2]
        } else {
          if (x > 0 && x + w > rowWidth) {
            x = 0
            y += rowDepth + GAP_MM
            rowDepth = 0
          }
          at = [x, y]
          box.x0 = Math.min(box.x0, x)
          box.y0 = Math.min(box.y0, y)
          box.x1 = Math.max(box.x1, x + w)
          box.y1 = Math.max(box.y1, y + d)
          x += w + GAP_MM
          rowDepth = Math.max(rowDepth, d)
          rowed.push(objects.length)
        }
        const id = `${item.objectId}-${c + 1}`
        // Rotation and scale first (the upper 3x3), then the move that sets the part down at its place.
        const o: PlateObject = { id, name: e.obj.name, mesh: e.meshId, transform: [...m.slice(0, 12), at[0] - mx, at[1] - my, -mz, 1] }
        if (e.settings && Object.keys(e.settings).length) o.settings = { ...e.settings }
        if (e.volumes?.length) o.volumes = e.volumes.map((v) => ({ name: v.name, role: v.role, mesh: v.meshId, ...(v.settings ? { settings: { ...v.settings } } : {}) }))
        objects.push(o)
        placements.push({ id, objectId: item.objectId, copy: c + 1, centerMm: [at[0] + w / 2, at[1] + d / 2], sizeMm: placed.size, manual: Boolean(e.position) })
      }
    }
    if (rowed.length) {
      const dx = x0 + width / 2 - (box.x0 + box.x1) / 2
      const dy = y0 + depth / 2 - (box.y0 + box.y1) / 2
      for (const i of rowed) {
        const o = objects[i]
        const p = placements[i]
        if (!o || !p) continue
        o.transform[12] = (o.transform[12] ?? 0) + dx
        o.transform[13] = (o.transform[13] ?? 0) + dy
        p.centerMm = [p.centerMm[0] + dx, p.centerMm[1] + dy]
      }
    }
    for (const p of placements) p.centerMm = [round2(p.centerMm[0]), round2(p.centerMm[1])]
    return { objects, placements }
  }

  async plate(plateIndex: number): Promise<Plate> {
    const { width, depth, height } = this.bed(plateIndex)
    return { bed: { widthMm: width, depthMm: depth, heightMm: height }, objects: this.layoutPlate(plateIndex).objects }
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
    const e = this.entry(objectId)
    if (position) e.position = position
    else delete e.position
    return e.obj.id
  }

  /** Scale per axis, 1 as modeled; [1, 1, 1] clears it. */
  setScale(objectId: string, scale: [number, number, number]): string {
    const e = this.entry(objectId)
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
    const e = this.entry(objectId)
    const target = this.layout.find((p) => p.index === index)
    if (!target) throw new ToolInputError(`No plate ${index}. slicerx_project_plate_add makes one.`)
    let copies = 0
    for (const p of this.layout) {
      for (const i of p.items) if (i.objectId === e.obj.id) copies += i.copies
      p.items = p.items.filter((i) => i.objectId !== e.obj.id)
    }
    addItem(target, e.obj.id, Math.max(1, copies))
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
          settings: e?.settings ?? {},
          volumes: (e?.volumes ?? []).map((v) => ({ id: v.id, name: v.name, role: v.role, shape: v.shape, ...(v.settings ? { settings: v.settings } : {}) })),
        }
      }),
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

function addItem(plate: ProjectPlate, objectId: string, copies: number): void {
  const at = plate.items.find((i) => i.objectId === objectId)
  if (at) at.copies += copies
  else plate.items.push({ objectId, copies })
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
