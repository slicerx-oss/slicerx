// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Spool inventory from a Spoolman server, through the Spoolman service plugin of the connected host. Reading
// needs no approval; subtracting used filament asks first (one spool, one amount). Without the plugin
// nothing shows. Bambu Studio's Filament Manager does this for an AMS only; here any slot can link to a spool.
import type { Host } from '@slicerx/contracts'
import { useEffect } from 'react'
import { get, set, useApp } from '../state/store'

export interface Spool {
  id: number
  material: string
  vendor: string
  name: string
  color: string
  remainingG: number
  initialG: number
}

/** Takes what the plugin returned and keeps only well-formed spools. */
export function parseSpools(raw: unknown): Spool[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { spools?: unknown }).spools) ? (raw as { spools: unknown[] }).spools : []
  const out: Spool[] = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (typeof o['id'] !== 'number' || typeof o['remainingG'] !== 'number') continue
    out.push({
      id: o['id'],
      material: typeof o['material'] === 'string' ? o['material'] : '',
      vendor: typeof o['vendor'] === 'string' ? o['vendor'] : '',
      name: typeof o['name'] === 'string' ? o['name'] : '',
      color: typeof o['color'] === 'string' ? o['color'] : '#888888',
      remainingG: Math.max(0, o['remainingG']),
      initialG: typeof o['initialG'] === 'number' ? o['initialG'] : 0,
    })
  }
  return out
}

export const spoolLabel = (s: Spool): string => [s.vendor, s.name].filter(Boolean).join(' ') || `Spool ${s.id}`

/** Reads the spools once per connection; a missing or unreachable server leaves an empty list. */
export async function loadSpools(host: Host): Promise<void> {
  if (!host.printers) return void set({ spools: [] })
  try {
    set({ spools: parseSpools(await host.printers.callTool('spoolman', 'list_spools', {})) })
  } catch {
    set({ spools: [] })
  }
}

/** Loads the inventory the first time a part of the app needs it. */
export function useSpools(host: Host): Spool[] {
  const spools = useApp((s) => s.spools)
  useEffect(() => {
    if (get().spools === null) void loadSpools(host)
  }, [host])
  return spools ?? []
}

/** The spool a slot is linked to: the person's choice first, else the one the printer reports. */
export function spoolFor(slotIndex: number, spools: readonly Spool[], links: Readonly<Record<number, number>>, printerSpoolId?: number): Spool | undefined {
  const id = links[slotIndex] ?? printerSpoolId
  return id === undefined ? undefined : spools.find((s) => s.id === id)
}

export interface Shortfall {
  slot: number
  needG: number
  haveG: number
  spool: Spool
}

/** Slots whose linked spool holds less than the plate needs. `filamentG` is by slot, first slot first. */
export function shortfalls(filamentG: readonly number[], spoolOf: (slot: number) => Spool | undefined): Shortfall[] {
  const out: Shortfall[] = []
  filamentG.forEach((g, i) => {
    const spool = spoolOf(i + 1)
    if (spool && g > 0 && spool.remainingG < g) out.push({ slot: i + 1, needG: g, haveG: spool.remainingG, spool })
  })
  return out
}

/** The vendors that have a spool, sorted, for the vendor filter. Spools without a vendor are not listed. */
export function spoolVendors(spools: readonly Spool[]): string[] {
  return [...new Set(spools.map((s) => s.vendor).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en-US'))
}

/** Spools of one vendor (all when empty) whose label or material contains every word typed. */
export function filterSpools(spools: readonly Spool[], vendor: string, query = ''): Spool[] {
  const words = query.toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean)
  return spools.filter((s) => {
    if (vendor && s.vendor !== vendor) return false
    const hay = `${spoolLabel(s)} ${s.material}`.toLocaleLowerCase('en-US')
    return words.every((w) => hay.includes(w))
  })
}
