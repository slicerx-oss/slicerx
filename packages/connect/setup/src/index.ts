// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// First-run printer setup on top of sx-link: the `discover` and `addPrinter` halves of
// PrinterSetupHost (packages/contracts/src/lookfeel.ts), plus a connection test. Credentials go to
// the keychain through the link and never appear in a return value.
import type { DiscoveredPrinter, PrinterConfig, PrinterSetupHost } from '@slicerx/contracts'
import type { LinkHost, PrinterTestResult } from '@slicerx/link-client'
import { CONNECTION_METHODS, PRINTER_MODELS, brandById, connectionMethod, type ConnectionId, type PrinterModel } from '@slicerx/printer-catalog'

/** What the setup functions need from the bridge. `LinkHost` satisfies it. */
export type SetupLink = Pick<LinkHost, 'discover' | 'addPrinter' | 'removePrinter' | 'setSecret' | 'deleteSecret' | 'testPrinter' | 'authorizePrinter'> & Partial<Pick<LinkHost, 'probe'>>

/** A printer a scan or a probe found: what it announced, without signing in. */
export interface FoundSetupPrinter {
  id: string
  name: string
  family: string
  /** `host`, or `host:port` when the port is not the connection's usual one. */
  address?: string
  model?: string
  serial?: string
  firmware?: string
  /** Bambu Lab: whether LAN Only Mode is on. */
  lanOnly?: boolean
}

/** `PrinterSetupHost.addPrinter`'s connection, plus what a connection may need. */
export interface SetupConnection {
  /** A connection id from the catalog (`bambu-lan`, `moonraker`, ...). `bambu` is accepted for `bambu-lan`. */
  family: string
  /** `host` or `host:port`. */
  address: string
  serial?: string
  /** The access code, API key or password. Stored in the keychain, never returned. */
  credential?: string
  /** PrusaLink digest login. */
  username?: string
}

export interface SetupAddInput {
  /** A catalog model id (`bambu-a1`), which is also the printer profile id in @slicerx/settings. Unknown text adds a printer with no model. */
  profileId: string
  nozzleMm: number
  connection?: SetupConnection
  /** Label for the printer. Defaults to the model name. */
  name?: string
}

export interface DiscoverOptions {
  timeoutMs?: number
  /** Aborting rejects with an AbortError and drops the result. The scan itself ends within its timeout. */
  signal?: AbortSignal
}

export type SetupErrorCode = 'bad_request' | 'unreachable' | 'not_supported'

export class SetupError extends Error {
  readonly code: SetupErrorCode
  constructor(code: SetupErrorCode, message: string) {
    super(message)
    this.name = 'SetupError'
    this.code = code
  }
}

/** `searchProfiles` belongs to the settings package, so it is left out here. */
export interface PrinterSetup extends Omit<PrinterSetupHost, 'searchProfiles'> {
  discover(opts?: DiscoverOptions): Promise<FoundSetupPrinter[]>
  /** Asks one IP address whether a printer is there (for "Enter IP instead"). Empty when nothing answered or the bridge cannot ask. */
  probe(host: string, opts?: DiscoverOptions): Promise<FoundSetupPrinter[]>
  /** `credentialKept: 'session'`: the keychain refused the code, so it is kept until the bridge quits. */
  addPrinter(input: SetupAddInput): Promise<{ printerId: string; credentialKept?: 'session' }>
  /** Tries a connection before saving it. Nothing is registered or changed on the printer. */
  testConnection(input: { family: string; address: string; serial?: string; credential?: string; username?: string }): Promise<PrinterTestResult>
  /** Printers added without a connection ("save G-code"). The host persists them. */
  localPrinters(): readonly LocalPrinter[]
}

export interface LocalPrinter {
  printerId: string
  name: string
  modelId?: string
  nozzleMm: number
}

/** Catalog connection ids that name a network connection. */
const ALIASES: Record<string, ConnectionId> = { bambu: 'bambu-lan', bambulab: 'bambu-lan', klipper: 'moonraker' }

export function resolveFamily(family: string): ConnectionId | undefined {
  const f = family.trim().toLowerCase()
  const id = ALIASES[f] ?? f
  return CONNECTION_METHODS.some((m) => m.id === id) ? (id as ConnectionId) : undefined
}

/** `192.168.1.5` or `192.168.1.5:7125`; also `http://host:port`. */
export function parseAddress(address: string): { host: string; port?: number } {
  const raw = address.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')
  const m = /^(\[[0-9a-f:%.a-z]+\]|[^:]+)(?::(\d{1,5}))?$/i.exec(raw)
  const host = m?.[1]?.replace(/^\[|\]$/g, '')
  if (!m || !host) throw new SetupError('bad_request', 'The address is empty or malformed.')
  const port = m[2] === undefined ? undefined : Number(m[2])
  if (port !== undefined && (port < 1 || port > 65535)) throw new SetupError('bad_request', 'The port must be 1 to 65535.')
  return port === undefined ? { host } : { host, port }
}

export function resolveModel(profileId: string): PrinterModel | undefined {
  const id = profileId.trim()
  return PRINTER_MODELS.find((m) => m.id === id)
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'printer'
}

const secretName = (printerId: string) => `printer-${printerId}`

function buildConfig(id: string, name: string, family: ConnectionId, c: SetupConnection, ref?: string): PrinterConfig {
  const method = connectionMethod(family)
  if (!method.plugin) throw new SetupError('not_supported', 'That connection type has nothing to connect to.')
  const { host, port } = parseAddress(c.address)
  return {
    id,
    name,
    plugin: method.plugin,
    host,
    ...(port === undefined ? {} : { port }),
    ...(ref ? { credentialRef: ref } : {}),
    ...(c.serial ? { serial: c.serial } : {}),
    ...(c.username ? { username: c.username } : {}),
  }
}

/** A discovered printer as setup shows it. The port is left out when it is the connection's usual one. */
export function foundPrinter(p: DiscoveredPrinter): FoundSetupPrinter {
  const usual = CONNECTION_METHODS.find((m) => m.plugin === p.plugin)?.defaultPort
  const address = p.port === undefined || p.port === usual ? p.host : `${p.host}:${p.port}`
  return {
    id: p.serial ?? p.uid ?? `${p.plugin}@${address}`,
    name: p.name ?? p.model ?? p.host,
    family: p.plugin,
    address,
    ...(p.model ? { model: p.model } : {}),
    ...(p.serial ? { serial: p.serial } : {}),
    ...(p.firmware ? { firmware: p.firmware } : {}),
    ...(p.lanOnly !== undefined ? { lanOnly: p.lanOnly } : {}),
  }
}

export function createPrinterSetup(link: SetupLink): PrinterSetup {
  const local: LocalPrinter[] = []
  const taken = new Set<string>()
  const freshId = (base: string) => {
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    taken.add(id)
    return id
  }

  return {
    async discover(opts = {}) {
      const { signal } = opts
      if (signal?.aborted) throw new DOMException('Scan canceled', 'AbortError')
      const scan = link.discover(opts.timeoutMs)
      const aborted = new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Scan canceled', 'AbortError')), { once: true }))
      const found: DiscoveredPrinter[] = await (signal ? Promise.race([scan, aborted]) : scan)
      return found.map(foundPrinter)
    },

    async probe(host, opts = {}) {
      if (!link.probe) return []
      return (await link.probe(host.trim(), opts.timeoutMs)).map(foundPrinter)
    },

    async testConnection(input) {
      const family = resolveFamily(input.family)
      if (!family) throw new SetupError('bad_request', `Unknown connection type ${input.family}.`)
      const ref = `printer-test-${crypto.randomUUID()}`
      const config = buildConfig('test', 'Test', family, input, input.credential ? ref : undefined)
      if (input.credential) await link.setSecret(ref, input.credential)
      try {
        return await link.testPrinter(config)
      } finally {
        if (input.credential) await link.deleteSecret(ref).catch(() => undefined)
      }
    },

    async addPrinter(input) {
      if (!(input.nozzleMm >= 0.1 && input.nozzleMm <= 2)) throw new SetupError('bad_request', 'The nozzle must be 0.1 to 2.0 mm.')
      const model = resolveModel(input.profileId)
      const name = input.name?.trim() || model?.name || input.profileId
      const family = input.connection ? resolveFamily(input.connection.family) : 'export'
      if (!family) throw new SetupError('bad_request', `Unknown connection type ${input.connection?.family ?? ''}.`)
      const printerId = freshId(slug(model?.id ?? name))
      if (family === 'export' || !input.connection) {
        local.push({ printerId, name, ...(model ? { modelId: model.id } : {}), nozzleMm: input.nozzleMm })
        return { printerId }
      }
      const c = input.connection
      const ref = c.credential ? secretName(printerId) : undefined
      const config = buildConfig(printerId, name, family, c, ref)
      const kept = ref && c.credential ? await link.setSecret(ref, c.credential) : undefined
      try {
        const brand = model ? brandById(model.brand)?.name : undefined
        await link.addPrinter(config, {
          vendor: brand ?? connectionMethod(family).name,
          model: model?.name ?? input.profileId,
          nozzleCount: model?.nozzleCount ?? 1,
          ...(model?.filamentSystem === 'ams' || model?.filamentSystem === 'mmu' || model?.filamentSystem === 'toolchanger' ? { filamentSystem: model.filamentSystem } : {}),
        })
      } catch (e) {
        taken.delete(printerId)
        if (ref) await link.deleteSecret(ref).catch(() => undefined)
        throw e
      }
      // The keychain refused the code: the printer is saved, and the code lasts until the bridge quits.
      return kept && kept.kept === 'session' ? { printerId, credentialKept: 'session' } : { printerId }
    },

    localPrinters: () => local,
  }
}
