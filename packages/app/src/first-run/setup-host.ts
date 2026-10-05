// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// PrinterSetupHost for the setup screens and the assistant's printer_setup skill. The default implementation sits on the
// host's printers API (the demo fleet in the browser). A build with sx-link or the desktop bridge
// registers its own (see @slicerx/connect createPrinterSetup) with registerPrinterSetup.
// A printer with no connection, or one no bridge can take yet, joins the app's printers by hand (lib/hand-printers).
// Secrets arrive inside the connection, reach a keychain or nowhere, and are never returned or kept.
import type { Host, PrinterInfo } from '@slicerx/contracts'
import { connectionMethod, modelById, searchModels, brandById, type ConnectionId } from '@slicerx/printer-catalog'
import { parseAddress } from './printer-form'
import { addHandPrinter, isExportOnly, LEGACY_SETUP_KEY, type HandPrinter } from '../lib/hand-printers'
import { get, set } from '../state/store'
import { bridgeConnector, connectBridge } from '../link/bridge'

export { TEST_STEPS, registerPrinterSetup, fromLinkResult } from './setup-registry'
export type { TestStepId, TestStep, SetupCause, TestOutcome, FoundPrinter, AppSetupHost } from './setup-registry'
import { registeredPrinterSetup, TEST_STEPS, type AppSetupHost, type FoundPrinter, type SetupCause, type TestOutcome, type TestStep } from './setup-registry'

import type { TestCause } from './help-topics'
import { appName } from '../edition'

/** The display cause for a failed test: the finer one when known. */
export function displayCause(o: TestOutcome): TestCause {
  return o.detail ?? o.cause ?? 'unreachable'
}

/**
 * The setup calls, through the bridge when one is registered at the time of the call. The desktop starts its bridge by
 * itself and setup can open before it is up, so a call waits for it rather than scan or save without it.
 */
export function setupHostFor(host: Host): AppSetupHost {
  const now = () => {
    const f = registeredPrinterSetup()
    return f ? f(host) : createHostSetup(host)
  }
  const ready = async () => {
    if (!registeredPrinterSetup() && bridgeConnector()?.automatic && get().bridgeStatus.state !== 'error') await connectBridge(host)
    return now()
  }
  return {
    get keychain() {
      return now().keychain
    },
    get scanRange() {
      return now().scanRange
    },
    searchProfiles: (query) => now().searchProfiles(query),
    discover: async (o) => (await ready()).discover(o),
    probe: async (address, o) => {
      const h = await ready()
      return h.probe ? h.probe(address, o) : []
    },
    testConnection: async (c, onStep, o) => (await ready()).testConnection(c, onStep, o),
    async addPrinter(input) {
      // Save G-code needs no host: the printer joins the app's printers for export.
      if (!input.connection || input.connection.family === 'export') {
        const taken = ((await host.printers?.list().catch(() => [])) ?? []).map((p) => p.id)
        return { printerId: addHandPrinter(handRecord(input), input.nozzleMm, taken) }
      }
      const added = await (await ready()).addPrinter(input)
      // The host's list changed: the picker and Printers read it again.
      set((s) => ({ linkEpoch: s.linkEpoch + 1 }))
      return added
    },
  }
}

/** A hand-added printer as the store keeps it: the model and brand from the catalog, and the address without its code. */
export function handRecord(input: { profileId: string; name?: string; connection?: { family: string; address: string; serial?: string } }): Omit<HandPrinter, 'id'> {
  const model = modelById(input.profileId)
  const fs = model?.filamentSystem
  const c = input.connection
  let needsSecret = true
  try {
    if (c) needsSecret = connectionMethod(c.family as ConnectionId).fields.some((f) => f.secret && f.required && f.key !== 'pairing')
  } catch {
    // An unknown connection type is kept, but never handed to a bridge on its own.
  }
  return {
    name: input.name?.trim() || model?.name || 'My printer',
    profileId: input.profileId,
    vendor: (model && brandById(model.brand)?.name) ?? 'Custom',
    model: model?.name ?? (input.name?.trim() || input.profileId),
    nozzleCount: model?.nozzleCount ?? 1,
    ...(fs === 'ams' || fs === 'mmu' || fs === 'toolchanger' ? { filamentSystem: fs } : {}),
    ...(c && c.family !== 'export' ? { connection: { family: c.family, address: c.address, needsSecret, ...(c.serial ? { serial: c.serial } : {}) } } : {}),
  }
}

/** Moves setup's old localStorage list into the store once, then drops it. */
export function migrateSetupPrinters(): void {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(LEGACY_SETUP_KEY)
  } catch {
    return
  }
  if (raw === null) return
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch {
    list = []
  }
  const known = new Set(get().handPrinters.map((h) => h.id))
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || typeof r !== 'object') continue
    const { printerId, name, profileId, nozzleMm, family, address } = r as Record<string, unknown>
    if (typeof printerId !== 'string' || typeof profileId !== 'string' || known.has(printerId)) continue
    const rec = handRecord({ profileId, ...(typeof name === 'string' ? { name } : {}), ...(typeof family === 'string' && typeof address === 'string' ? { connection: { family, address } } : {}) })
    const nozzle = typeof nozzleMm === 'number' && nozzleMm >= 0.1 && nozzleMm <= 2 ? nozzleMm : 0.4
    // The old id is kept, so a printer chosen before still is.
    set((s) => ({ handPrinters: [...s.handPrinters, { id: printerId, ...rec }], printerNozzles: { [printerId]: nozzle, ...s.printerNozzles }, linkEpoch: s.linkEpoch + 1 }))
    known.add(printerId)
  }
  try {
    localStorage.removeItem(LEGACY_SETUP_KEY)
  } catch {
    // Read-only storage: the ids are already in the store, so a second pass adds nothing.
  }
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('Canceled', 'AbortError'))
    }, { once: true })
  })

/** Setup over `host.printers`: discovery lists the printers the host knows, the test reads their live status. */
export function createHostSetup(host: Host, opts: { stepMs?: number } = {}): AppSetupHost {
  const stepMs = opts.stepMs ?? 350
  const printers = host.printers
  const bridge = host.capabilities.printers === 'link' || host.capabilities.printers === 'native'
  const find = async (address: string): Promise<PrinterInfo | undefined> => {
    const a = parseAddress(address)
    if (!a || !printers) return undefined
    return (await printers.list()).find((p) => p.host?.toLowerCase() === a.host.toLowerCase())
  }

  return {
    keychain: host.capabilities.secureStorage,
    scanRange: bridge ? 'this computer\'s local network' : 'the demo network 192.0.2.0/24',

    async discover(o = {}) {
      await wait(stepMs * 2, o.signal)
      const list = (await printers?.list()) ?? []
      // The scan reads what the printer announces: model, nozzle and filament unit. Nothing signs in.
      const status = await Promise.allSettled(list.map((p) => printers!.status(p.id)))
      return list.map((p, i) => {
        const st = status[i]
        const live = st && st.status === 'fulfilled' ? st.value : null
        return {
          id: p.id,
          name: p.name,
          family: p.plugin,
          ...(p.host ? { address: p.host } : {}),
          model: `${p.vendor} ${p.model}`,
          nozzleCount: p.nozzleCount,
          ...(p.filamentSystem ? { filamentSystem: p.filamentSystem } : {}),
          ...(live?.nozzleDiameterMm ? { nozzleMm: live.nozzleDiameterMm } : {}),
          ...(live && live.slots.length ? { slotCount: live.slots.length } : {}),
          ...(live && !isExportOnly(p) ? { state: live.state } : {}),
        }
      })
    },

    async probe(address, o = {}) {
      // The demo network answers for the printers the host knows at that address.
      const all = await this.discover(o)
      return all.filter((p) => p.address && parseAddress(p.address)?.host === parseAddress(address)?.host)
    },

    async searchProfiles(query) {
      return searchModels(query).map((m) => ({ id: m.id, vendor: brandById(m.brand)?.name ?? m.brand, model: m.name, nozzles: [...m.nozzles] }))
    },

    async testConnection(input, onStep = () => undefined, o = {}) {
      const secret = input.credential
      const steps: TestStep[] = [
        { id: 'reach', ok: null },
        { id: 'sign_in', ok: null },
        { id: 'read_state', ok: null },
        { id: 'read_temperatures', ok: null },
      ]
      const emit = () => onStep(steps.map((s) => ({ ...s })))
      const method = connectionMethod(input.family as ConnectionId)
      const run = async <T>(i: number, fn: () => Promise<T>): Promise<T> => {
        const started = performance.now()
        const step = steps[i]!
        step.running = true
        emit()
        await wait(stepMs, o.signal)
        try {
          return await fn()
        } finally {
          step.running = false
          step.ms = Math.round(performance.now() - started)
        }
      }
      const fail = (i: number, cause: SetupCause, message: string, detail?: TestOutcome['detail']): TestOutcome => {
        steps[i]!.ok = false
        emit()
        return { ok: false, steps: steps.map((s) => ({ ...s })), cause, message, ...(detail ? { detail } : {}) }
      }

      if (!printers) return fail(0, 'not_supported', `This build has no printer connections. Use the desktop app or ${appName()} Link to reach printers on your network.`)
      const a = parseAddress(input.address)
      if (!a) return fail(0, 'bad_request', 'The address is empty or malformed.')
      const printer = await run(0, () => find(input.address))
      if (!printer) {
        // The desktop app starts its own bridge; when that is down it is not the browser app, so it must not say so.
        const note = bridge
          ? ''
          : bridgeConnector()?.automatic
            ? ' The printer bridge in this app is not connected, so only the demo printers answer. Connect it in Settings, Printer bridge.'
            : ` The browser app reaches printers on your network through ${appName()} Link or the desktop app; here it can reach the demo printers.`
        return fail(0, 'unreachable', `Nothing answered at ${a.host}.${note}`)
      }
      if (a.port !== undefined && method.defaultPort !== undefined && a.port !== method.defaultPort) return fail(0, 'unreachable', `${a.host} answered, but not on port ${a.port}.`, 'wrong-port')
      if (printer.plugin !== method.plugin) return fail(0, 'protocol', `${a.host} answered as ${printer.plugin}, not ${method.name}.`)
      steps[0]!.ok = true

      const needsSecret = method.fields.some((f) => f.secret && f.required && f.key !== 'pairing')
      const signedIn = await run(1, async () => !needsSecret || Boolean(secret))
      if (!signedIn) return fail(1, 'auth', 'The printer asked for a code or key and none was given.')
      if (input.family === 'bambu-lan' && secret && secret.length !== 8) return fail(1, 'auth', 'The printer refused the access code.')
      steps[1]!.ok = true

      const status = await run(2, () => printers.status(printer.id))
      if (status.state === 'offline') return fail(2, 'timeout', 'The printer stopped answering while reading its state.')
      steps[2]!.ok = true

      await run(3, async () => undefined)
      const nozzle = status.nozzles[0]
      steps[3]!.ok = true
      emit()
      return {
        ok: true,
        steps: steps.map((s) => ({ ...s })),
        state: status.state,
        ...(nozzle ? { nozzleC: Math.round(nozzle.current) } : {}),
        ...(status.bed ? { bedC: Math.round(status.bed.current) } : {}),
        reportedModel: printer.model,
        ...(status.nozzleDiameterMm ? { nozzleMm: status.nozzleDiameterMm } : {}),
        ...(printer.filamentSystem ? { filamentSystem: printer.filamentSystem } : {}),
        ...(status.slots.length ? { slotCount: status.slots.length } : {}),
      }
    },

    async addPrinter(input) {
      // A printer the host already has (the demo fleet, or one the bridge found) is used as it is.
      const known = input.connection ? await find(input.connection.address) : undefined
      if (known) return { printerId: known.id }
      // Nothing here can keep an access code, so the printer is saved for export with its address for a bridge later.
      const taken = ((await printers?.list().catch(() => [])) ?? []).map((p) => p.id)
      return { printerId: addHandPrinter(handRecord(input), input.nozzleMm, taken) }
    },
  }
}
