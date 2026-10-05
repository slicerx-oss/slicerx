// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Synced records: the shapes the app sees (camelCase) and the rows the
// database returns (snake_case, supabase/migrations/0004_cloud.sql).
import { z } from 'zod'

export type SyncEntity = 'profile' | 'printer' | 'fleet'
export const SYNC_ENTITIES: readonly SyncEntity[] = ['profile', 'printer', 'fleet']

export type ProfileKind = 'printer' | 'filament' | 'process'

interface SyncedBase {
  id: string
  deleted: boolean
  /** 0 until the record has reached the service. */
  revision: number
  updatedAt: string
  /** The device that wrote the current server version. */
  updatedBy: string | null
}

export interface SyncedProfile extends SyncedBase {
  kind: ProfileKind
  name: string
  /** The profile this one is based on, such as a vendor profile id. */
  inherits: string | null
  /** Orca keys to values. */
  settings: Record<string, unknown>
}

/** A printer as synced: no credentials and no network address; those stay on the machine that reaches it. */
export interface SyncedPrinter extends SyncedBase {
  name: string
  driver: string | null
  model: string | null
  printerProfileId: string | null
  /** The bridge that reaches this printer, and its id there. Set by the bridge. */
  deviceId: string | null
  localId: string | null
  settings: Record<string, unknown>
}

export interface SyncedFleet extends SyncedBase {
  name: string
  printerIds: string[]
}

export interface EntityMap {
  profile: SyncedProfile
  printer: SyncedPrinter
  fleet: SyncedFleet
}

/** Fields a client may write; `id` is optional on create. */
export type Draft<E extends SyncEntity> = E extends 'profile'
  ? Pick<SyncedProfile, 'kind' | 'name'> & Partial<Pick<SyncedProfile, 'id' | 'inherits' | 'settings'>>
  : E extends 'printer'
    ? Pick<SyncedPrinter, 'name'> &
        Partial<Pick<SyncedPrinter, 'id' | 'driver' | 'model' | 'printerProfileId' | 'settings'>>
    : Pick<SyncedFleet, 'name'> & Partial<Pick<SyncedFleet, 'id' | 'printerIds'>>

/** Keys the service refuses in printer settings, checked before a change is queued. */
export const PRINTER_SECRET_KEYS = [
  'access_code',
  'api_key',
  'password',
  'secret',
  'token',
  'host',
  'ip',
  'address',
  'serial',
] as const

const id = z.string().uuid()
const revision = z.union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)])
const settings = z.record(z.string(), z.unknown())
const base = {
  id,
  deleted: z.boolean(),
  revision,
  updated_at: z.string(),
  updated_by: id.nullable(),
}

export const profileRow = z.object({
  ...base,
  kind: z.enum(['printer', 'filament', 'process']),
  name: z.string(),
  inherits: z.string().nullable(),
  settings,
})
export const printerRow = z.object({
  ...base,
  name: z.string(),
  driver: z.string().nullable(),
  model: z.string().nullable(),
  printer_profile_id: id.nullable(),
  device_id: id.nullable(),
  local_id: z.string().nullable(),
  settings,
})
export const fleetRow = z.object({ ...base, name: z.string(), printer_ids: z.array(id) })

export const ROW_SCHEMAS = { profile: profileRow, printer: printerRow, fleet: fleetRow } as const

type Row<E extends SyncEntity> = z.infer<(typeof ROW_SCHEMAS)[E]>

const common = (r: Row<SyncEntity>) => ({
  id: r.id,
  deleted: r.deleted,
  revision: r.revision,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
})

/** Parses a row from the service into the app shape, or null when it does not match. */
export function fromRow<E extends SyncEntity>(entity: E, raw: unknown): EntityMap[E] | null {
  const parsed = ROW_SCHEMAS[entity].safeParse(raw)
  if (!parsed.success) return null
  const r = parsed.data
  switch (entity) {
    case 'profile': {
      const p = r as Row<'profile'>
      const v: SyncedProfile = { ...common(p), kind: p.kind, name: p.name, inherits: p.inherits, settings: p.settings }
      return v as EntityMap[E]
    }
    case 'printer': {
      const p = r as Row<'printer'>
      const v: SyncedPrinter = {
        ...common(p),
        name: p.name,
        driver: p.driver,
        model: p.model,
        printerProfileId: p.printer_profile_id,
        deviceId: p.device_id,
        localId: p.local_id,
        settings: p.settings,
      }
      return v as EntityMap[E]
    }
    default: {
      const f = r as Row<'fleet'>
      const v: SyncedFleet = { ...common(f), name: f.name, printerIds: f.printer_ids }
      return v as EntityMap[E]
    }
  }
}

/** The writable fields of a record, as the push function reads them. */
export function editableRow(entity: SyncEntity, v: EntityMap[SyncEntity]): Record<string, unknown> {
  switch (entity) {
    case 'profile': {
      const p = v as SyncedProfile
      return { id: p.id, kind: p.kind, name: p.name, inherits: p.inherits, settings: p.settings, deleted: p.deleted }
    }
    case 'printer': {
      const p = v as SyncedPrinter
      return {
        id: p.id,
        name: p.name,
        driver: p.driver,
        model: p.model,
        printer_profile_id: p.printerProfileId,
        settings: p.settings,
        deleted: p.deleted,
      }
    }
    default: {
      const f = v as SyncedFleet
      return { id: f.id, name: f.name, printer_ids: f.printerIds, deleted: f.deleted }
    }
  }
}

/** Names of the writable fields in the app shape, per entity. */
export const EDITABLE: Record<SyncEntity, readonly string[]> = {
  profile: ['kind', 'name', 'inherits', 'settings', 'deleted'],
  printer: ['name', 'driver', 'model', 'printerProfileId', 'settings', 'deleted'],
  fleet: ['name', 'printerIds', 'deleted'],
}
