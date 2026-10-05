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

interface Entry {
  obj: ProjectObject
  meshId?: string
  /** Rotation in degrees about X, then Y, then Z, applied before the object is placed. */
  rotate?: [number, number, number]
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
  addMesh(meshId: string, name: string, bboxMm: [number, number, number], triangles: number, copies: number): ProjectObject {
    const id = `obj-${this.nextId++}`
    const obj: ProjectObject = { id, name, bboxMm, triangles, mesh: async () => this.host.parts(meshId) }
    this.entries.set(id, { obj, meshId })
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
    return { ...this.baseConfig(), ...this.projectOverrides, ...(plate?.overrides ?? {}) } as PrintConfig
  }

  /** Places every copy in rows from the front left corner, a simple layout the core re-centers. */
  async plate(plateIndex: number): Promise<Plate> {
    const cfg = this.config(plateIndex)
    const area = Array.isArray(cfg['printable_area']) ? (cfg['printable_area'] as unknown[]) : []
    const xs = area.flatMap((p) => (Array.isArray(p) && typeof p[0] === 'number' ? [p[0]] : []))
    const ys = area.flatMap((p) => (Array.isArray(p) && typeof p[1] === 'number' ? [p[1]] : []))
    const width = xs.length ? Math.max(...xs) - Math.min(...xs) : 256
    const depth = ys.length ? Math.max(...ys) - Math.min(...ys) : 256
    const height = num(cfg['printable_height']) ?? 250
    const plate = this.layout.find((p) => p.index === plateIndex)
    if (!plate) throw new Error(`No plate ${plateIndex}`)
    const objects: PlateObject[] = []
    let x = GAP_MM
    let y = GAP_MM
    let rowDepth = 0
    for (const item of plate.items) {
      const e = this.entries.get(item.objectId)
      if (!e?.meshId) continue
      const rot = e.rotate ? rotationMatrix(e.rotate) : undefined
      const placed = rot ? this.host.boundsAfter(e.meshId, rot) : undefined
      const [w, d] = placed?.size ?? e.obj.bboxMm
      const [mx, my, mz] = placed?.min ?? this.host.minCorner(e.meshId)
      for (let c = 0; c < item.copies; c++) {
        if (x + w > width && x > GAP_MM) {
          x = GAP_MM
          y += rowDepth + GAP_MM
          rowDepth = 0
        }
        // Rotation first (the upper 3x3), then the move that sets the rotated part down at (x, y).
        const r = rot ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        objects.push({ id: `${item.objectId}-${c + 1}`, name: e.obj.name, mesh: e.meshId, transform: [...r.slice(0, 12), x - mx, y - my, -mz, 1] })
        x += w + GAP_MM
        rowDepth = Math.max(rowDepth, d)
      }
    }
    return { bed: { widthMm: width, depthMm: depth, heightMm: height }, objects }
  }

  replaceObjects(ids: string[], replacements: ProjectObject[]): void {
    for (const id of ids) this.entries.delete(id)
    for (const r of replacements) this.entries.set(r.id, { obj: r })
    for (const p of this.layout) p.items = p.items.filter((i) => !ids.includes(i.objectId))
    const first = this.layout[0]
    if (first) for (const r of replacements) first.items.push({ objectId: r.id, copies: 1 })
  }

  describe(): Record<string, unknown> {
    return {
      name: this.name,
      settings: this.settings,
      machine: this.machine() ?? null,
      objects: this.objects().map((o) => ({ id: o.id, name: o.name, bbox_mm: o.bboxMm, triangles: o.triangles ?? null, has_mesh: Boolean(this.entries.get(o.id)?.meshId) })),
      plates: this.plates(),
      overrides: this.projectOverrides,
    }
  }
}
