// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a Vault upload sends: the current project as an .sx3mf or a picked file,
// a cover drawn from its triangles, and how it was printed when the plate was
// sliced. The upload flow (features/store) reads these through the app entry.
import type { SettingValue, UploadPrintProfile } from '@slicerx/contracts'
import { loadSettings } from '../adapters/load'
import { allPlates, projectBase } from '../plate/plates'
import { get, type PlateEntry } from '../state/store'
import { renderCover, stlMesh, type CoverImage, type CoverMesh } from './cover'
import { deriveColors, type DerivedColors } from './listing-colors'

export type { CoverImage, CoverMesh } from './cover'

export interface ProjectUpload {
  name: string
  bytes: Uint8Array
  cover: CoverImage
  /** The creators of Vault designs on the plates; a project holding someone else's design is not theirs to upload. */
  vaultCreators: string[]
  printProfile?: UploadPrintProfile
}

function meshesOf(objects: readonly PlateEntry[]): CoverMesh[] {
  return objects.flatMap((o) => o.parts.map((p) => ({ positions: p.positions, indices: p.indices, color: o.colors[p.slot - 1] ?? o.colors[0] ?? '#bd93f9', transform: o.transform })))
}

/** The current project as an .sx3mf with its cover. Null when the plates are empty. */
export async function currentProjectUpload(): Promise<ProjectUpload | null> {
  const plates = allPlates(get())
  const objects = plates.flatMap((p) => p.objects)
  if (objects.length === 0) return null
  const { sx3mfBytes } = await import('./actions')
  const bytes = await sx3mfBytes(plates)
  const s = get()
  let printProfile: UploadPrintProfile | undefined
  if (s.slice.status === 'done' && !s.slice.stale && s.printerModel) {
    const api = await loadSettings()
    const cfg = api.resolveConfig(s.easy, s.overrides) as Record<string, SettingValue | undefined>
    const first = (v: SettingValue | undefined) => (Array.isArray(v) ? v[0] : v)
    const lh = Number(first(cfg['layer_height']))
    const filament = String(first(cfg['filament_type']) ?? '') || 'PLA'
    const grams = s.slice.result.stats.filamentG.reduce((n, g) => n + g, 0)
    printProfile = {
      printerModel: `${s.printerModel.vendor} ${s.printerModel.model}`.trim(),
      process: Number.isFinite(lh) && lh > 0 ? `${lh.toFixed(2)} mm layers` : 'Standard',
      filament,
      ...(Number.isFinite(lh) && lh > 0 ? { layerHeightMm: Math.round(lh * 100) / 100 } : {}),
      ...(s.profile?.nozzle ? { nozzleMm: s.profile.nozzle } : {}),
      timeS: Math.round(s.slice.result.stats.timeS),
      ...(grams > 0 ? { grams: Math.round(grams * 10) / 10 } : {}),
    }
  }
  return {
    name: `${projectBase(objects).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'model'}.sx3mf`,
    bytes,
    cover: renderCover(meshesOf(objects)),
    vaultCreators: [...new Set(objects.flatMap((o) => (o.source?.modelId && o.source.creatorId ? [o.source.creatorId] : [])))],
    ...(printProfile ? { printProfile } : {}),
  }
}

/** A cover for a picked file: its triangles for an STL, its plates for a 3MF or .sx3mf. Null when it cannot be read. */
export async function coverForFile(name: string, bytes: Uint8Array): Promise<CoverImage | null> {
  const ext = name.toLowerCase().split('.').pop()
  try {
    if (ext === 'stl') {
      const m = stlMesh(bytes)
      return m ? renderCover([{ ...m, color: '#bd93f9' }]) : null
    }
    if (ext === '3mf' || ext === 'sx3mf') {
      const { readProject } = await import('./import3mf')
      const project = await readProject(bytes, get().bed)
      const objects = project.plates.flatMap((p) => p.objects)
      const meshes = objects.flatMap((o) => o.parts.map((p) => ({ positions: p.positions, indices: p.indices, color: project.colors[p.slot - 1] ?? project.colors[0] ?? '#bd93f9', transform: o.transform })))
      return meshes.length ? renderCover(meshes) : null
    }
  } catch {
    return null
  }
  return null
}

/** The creators of Vault designs a picked 3MF or .sx3mf names (sx:Creator with sx:Listing). */
export async function vaultCreatorsInFile(name: string, bytes: Uint8Array): Promise<string[]> {
  const ext = name.toLowerCase().split('.').pop()
  if (ext !== '3mf' && ext !== 'sx3mf') return []
  try {
    const { readProject } = await import('./import3mf')
    const project = await readProject(bytes, get().bed)
    return [...new Set(project.plates.flatMap((p) => p.objects).flatMap((o) => (o.source?.modelId && o.source.creatorId ? [o.source.creatorId] : [])))]
  } catch {
    return []
  }
}

/** A model's colors and its meshes by filament slot, so the cover can be drawn again in the creator's colors. */
export interface UploadModel {
  colors: DerivedColors | null
  meshes: (CoverMesh & { slot: number })[]
}

/** The open project's colors: the slot colors the Filament block shows, each part's slot after the plate's swaps. */
export async function projectModel(): Promise<UploadModel> {
  const { resolveSlots, effectiveSlot, mapSlot } = await import('../filament/slots')
  const s = get()
  const palette = resolveSlots(s).map((r) => r.color)
  const plates = allPlates(s)
  const sources = plates.flatMap((p) =>
    p.objects.map((o) => ({
      name: o.name,
      parts: o.parts.map((part) => ({ name: part.name, slot: mapSlot(p, effectiveSlot(o, part)) })),
      ...(o.paint ? { paint: o.paint } : {}),
      ...(o.printable === false ? { printable: false } : {}),
      ...(o.instanceOf ? { instanceOf: o.instanceOf } : {}),
    })),
  )
  const meshes = plates.flatMap((p) =>
    p.objects.flatMap((o) =>
      o.parts.map((part) => {
        const slot = mapSlot(p, effectiveSlot(o, part))
        return { positions: part.positions, indices: part.indices, color: palette[slot - 1] ?? '#bd93f9', slot, transform: o.transform }
      }),
    ),
  )
  return { colors: deriveColors(sources, palette), meshes }
}

/** A picked 3MF or .sx3mf's colors from its objects and project settings. Null for an STL or a file that cannot be read. */
export async function fileModel(name: string, bytes: Uint8Array): Promise<UploadModel | null> {
  const ext = name.toLowerCase().split('.').pop()
  if (ext !== '3mf' && ext !== 'sx3mf') return null
  try {
    const { readProject } = await import('./import3mf')
    const project = await readProject(bytes, get().bed)
    const objects = project.plates.flatMap((p) => p.objects)
    const meshes = objects.flatMap((o) => o.parts.map((p) => ({ positions: p.positions, indices: p.indices, color: project.colors[p.slot - 1] ?? project.colors[0] ?? '#bd93f9', slot: p.slot, transform: o.transform })))
    return { colors: deriveColors(objects, project.colors), meshes }
  } catch {
    return null
  }
}

/** The cover drawn again with the creator's colors: `slotHex` maps a file slot to the color it should show. */
export function coverInColors(model: UploadModel, slotHex: Readonly<Record<number, string>>): CoverImage | null {
  if (model.meshes.length === 0) return null
  return renderCover(model.meshes.map((m) => ({ ...m, color: slotHex[m.slot] ?? m.color })))
}
