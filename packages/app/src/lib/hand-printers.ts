// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printers added by hand in setup that no host knows: "Save G-code", or a connection saved while no
// printer bridge was there to keep its access code. They live in the app store and join the host's
// printers, so the printer picker, Printers and the slice profile see them like any other printer.
// They take no jobs: Print exports the G-code for USB or an SD card.
import type { PrinterConnection, PrinterHost, PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import type { HandPrinter } from '../state/prefs'
import { get, set } from '../state/store'

export type { HandPrinter }

/** The plugin id a hand-added printer reports. */
export const EXPORT_PLUGIN = 'export'

/** Where setup kept hand-added printers before they joined the store. Read once, then dropped. */
export const LEGACY_SETUP_KEY = 'slicerx.setup-printers.v1'

/** True for a printer the app can only export for. */
export function isExportOnly(p: Pick<PrinterInfo, 'plugin'>): boolean {
  return p.plugin === EXPORT_PLUGIN
}

function info(h: HandPrinter): PrinterInfo {
  return { id: h.id, name: h.name, vendor: h.vendor, model: h.model, plugin: EXPORT_PLUGIN, nozzleCount: h.nozzleCount, ...(h.filamentSystem ? { filamentSystem: h.filamentSystem } : {}) }
}

function status(id: string): PrinterStatus {
  return { printerId: id, state: 'idle', nozzles: [], slots: [], cameraAvailable: false, updatedAt: new Date(0).toISOString() }
}

const hand = (id: string) => get().handPrinters.find((h) => h.id === id)

function noJobs(id: string): never {
  throw new Error(`${hand(id)?.name ?? id} has no connection. Export the G-code and copy it to the printer.`)
}

const wrapped = new WeakSet<PrinterHost>()

/** The host's printers with the hand-added ones after them. A printer the host itself lists wins. */
export function withHandPrinters(base: PrinterHost): PrinterHost {
  if (wrapped.has(base)) return base
  const over: Partial<PrinterHost> = {
    async list() {
      const list = await base.list()
      const ids = new Set(list.map((p) => p.id))
      return [...list, ...get().handPrinters.filter((h) => !ids.has(h.id)).map(info)]
    },
    status: (id) => (hand(id) ? Promise.resolve(status(id)) : base.status(id)),
    subscribe: (id, onEvent) => (hand(id) ? () => undefined : base.subscribe(id, onEvent)),
    snapshot: (id) => (hand(id) ? Promise.resolve(null) : base.snapshot(id)),
    upload: async (id, file, token) => (hand(id) ? noJobs(id) : base.upload(id, file, token)),
    start: async (file, opts, token) => (hand(file.printerId) ? noJobs(file.printerId) : base.start(file, opts, token)),
  }
  // Everything else (fleets, plugins, camera streams the bridge adds) is the host's own.
  const proxy = new Proxy(base, { get: (t, k) => (k in over ? over[k as keyof PrinterHost] : Reflect.get(t, k)) })
  wrapped.add(proxy)
  return proxy
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'printer'
}

/** The printer list changed: views and commands that follow the host's printers read them again. */
const changed = (patch: (s: ReturnType<typeof get>) => Partial<ReturnType<typeof get>>) => set((s) => ({ ...patch(s), linkEpoch: s.linkEpoch + 1 }))

/** Adds a printer by hand and returns its id. `taken` holds ids the host already uses. */
export function addHandPrinter(p: Omit<HandPrinter, 'id'>, nozzleMm: number, taken: readonly string[] = []): string {
  const used = new Set([...taken, ...get().handPrinters.map((h) => h.id)])
  const base = `local-${slug(p.profileId || p.name)}`
  let id = base
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`
  changed((s) => ({ handPrinters: [...s.handPrinters, { id, ...p }], printerNozzles: { ...s.printerNozzles, [id]: nozzleMm } }))
  return id
}

export function removeHandPrinter(id: string): void {
  if (!hand(id)) return
  changed((s) => ({ handPrinters: s.handPrinters.filter((h) => h.id !== id), ...(s.printerId === id ? { printerId: null } : {}) }))
}

/**
 * A printer bridge just connected: each hand-added printer with a saved connection that needs no access code
 * is added to it, and the app follows the new id. One that needs a code stays for export until it is set up again.
 */
export async function promoteHandPrinters(add: (input: { profileId: string; nozzleMm: number; name: string; connection: PrinterConnection }) => Promise<{ printerId: string }>): Promise<void> {
  for (const h of get().handPrinters) {
    const c = h.connection
    if (!c || c.needsSecret) continue
    const nozzleMm = get().printerNozzles[h.id] ?? 0.4
    const added = await add({ profileId: h.profileId, nozzleMm, name: h.name, connection: { family: c.family, address: c.address, ...(c.serial ? { serial: c.serial } : {}) } }).catch(() => null)
    if (!added) continue
    const { printerId } = added
    changed((s) => {
      const nozzles = { ...s.printerNozzles, [printerId]: nozzleMm }
      delete nozzles[h.id]
      return { handPrinters: s.handPrinters.filter((x) => x.id !== h.id), printerNozzles: nozzles, ...(s.printerId === h.id ? { printerId } : {}) }
    })
  }
}

/** True when setup's old list is still in storage. */
export function hasLegacySetupPrinters(): boolean {
  try {
    return localStorage.getItem(LEGACY_SETUP_KEY) !== null
  } catch {
    return false
  }
}
