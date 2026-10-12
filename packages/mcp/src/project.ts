// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The project an MCP client works on: models, plates and settings, held in
// memory by the server. mimir's skills (orient, arrange, cut, slice,
// estimate) read and change it through the PilotProject interface.
import type { MeshPart, PilotMachine, Plate, PlateObject, PrintConfig, SettingValue } from '@slicerx/contracts'
import { rotationMatrix, type PilotProject, type ProjectObject, type ProjectPlate } from '@slicerx/pilot'
import type { DataStore } from './data'
import type { ProfileCatalog } from './profiles'
import { isGcodeKey, SHIPPED_GCODE_SOURCES } from './config'
import { defaultConfig, sameValue, toSchemaValue } from './settings'
import type { NodeSlicerHost } from './slicerhost'
import { defaultFilament, filamentColor, filamentType, listFilaments, MAX_FILAMENTS, type FilamentSetup, type ProjectFilament } from './filaments'

interface Entry {
  obj: ProjectObject
  meshId?: string
  /** Rotation in degrees about X, then Y, then Z, applied before the object is placed. */
  rotate?: [number, number, number]
  /** Parts the object was loaded with: the bodies of a file kept as one object (1 for a plain model). */
  parts?: number
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
  private nextId = 1

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
    if (e.meshId) e.obj = { ...e.obj, bboxMm: this.host.boundsAfter(e.meshId, rotationMatrix(rotate)).size }
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

  /**
   * Places every copy in rows, then moves the whole layout to the middle of the printable area (from its own corner, so
   * a bed that does not start at 0 works too). Nothing downstream re-centers it: the sx CLI slices the plate where it is,
   * and a layout left in the front left corner put a skirt or brim off the bed.
   */
  async plate(plateIndex: number): Promise<Plate> {
    const cfg = this.config(plateIndex)
    const area = Array.isArray(cfg['printable_area']) ? (cfg['printable_area'] as unknown[]) : []
    const xs = area.flatMap((p) => (Array.isArray(p) && typeof p[0] === 'number' ? [p[0]] : []))
    const ys = area.flatMap((p) => (Array.isArray(p) && typeof p[1] === 'number' ? [p[1]] : []))
    const x0 = xs.length ? Math.min(...xs) : 0
    const y0 = ys.length ? Math.min(...ys) : 0
    const width = xs.length ? Math.max(...xs) - x0 : 256
    const depth = ys.length ? Math.max(...ys) - y0 : 256
    const height = num(cfg['printable_height']) ?? 250
    const plate = this.layout.find((p) => p.index === plateIndex)
    if (!plate) throw new Error(`No plate ${plateIndex}`)
    const objects: PlateObject[] = []
    // The layout's own extent, to center it once every copy is placed.
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
    // A row ends before it would reach into the edge room at either side; a part wider than that still gets a row.
    const rowWidth = width - 2 * EDGE_MM
    let x = 0
    let y = 0
    let rowDepth = 0
    for (const item of plate.items) {
      const e = this.entries.get(item.objectId)
      if (!e?.meshId) continue
      const rot = e.rotate ? rotationMatrix(e.rotate) : undefined
      const placed = rot ? this.host.boundsAfter(e.meshId, rot) : undefined
      const [w, d] = placed?.size ?? e.obj.bboxMm
      const [mx, my, mz] = placed?.min ?? this.host.minCorner(e.meshId)
      for (let c = 0; c < item.copies; c++) {
        if (x > 0 && x + w > rowWidth) {
          x = 0
          y += rowDepth + GAP_MM
          rowDepth = 0
        }
        // Rotation first (the upper 3x3), then the move that sets the rotated part down at (x, y).
        const r = rot ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        objects.push({ id: `${item.objectId}-${c + 1}`, name: e.obj.name, mesh: e.meshId, transform: [...r.slice(0, 12), x - mx, y - my, -mz, 1] })
        box.x0 = Math.min(box.x0, x)
        box.y0 = Math.min(box.y0, y)
        box.x1 = Math.max(box.x1, x + w)
        box.y1 = Math.max(box.y1, y + d)
        x += w + GAP_MM
        rowDepth = Math.max(rowDepth, d)
      }
    }
    if (objects.length) {
      const dx = x0 + width / 2 - (box.x0 + box.x1) / 2
      const dy = y0 + depth / 2 - (box.y0 + box.y1) / 2
      for (const o of objects) {
        o.transform[12] = (o.transform[12] ?? 0) + dx
        o.transform[13] = (o.transform[13] ?? 0) + dy
      }
    }
    return { bed: { widthMm: width, depthMm: depth, heightMm: height }, objects }
  }

  /**
   * Replaces objects with others (cut parts, a repaired or hollowed mesh). Each replacement's geometry is
   * loaded, so it slices; a replacement that keeps an object's id keeps its rotation.
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
    const rotations = new Map(ids.map((id) => [id, this.entries.get(id)?.rotate]))
    for (const id of ids) this.entries.delete(id)
    for (const e of loaded) {
      const rotate = rotations.get(e.obj.id)
      this.entries.set(e.obj.id, rotate ? { ...e, rotate } : e)
    }
    for (const p of this.layout) p.items = p.items.filter((i) => !ids.includes(i.objectId))
    const first = this.layout[0]
    if (first) for (const r of replacements) first.items.push({ objectId: r.id, copies: 1 })
  }

  describe(): Record<string, unknown> {
    return {
      name: this.name,
      settings: this.settings,
      machine: this.machine() ?? null,
      objects: this.objects().map((o) => ({ id: o.id, name: o.name, bbox_mm: o.bboxMm, triangles: o.triangles ?? null, has_mesh: Boolean(this.entries.get(o.id)?.meshId), parts: this.entries.get(o.id)?.parts ?? 1 })),
      plates: this.plates(),
      filaments: this.filaments(),
      overrides: this.projectOverrides,
    }
  }
}
