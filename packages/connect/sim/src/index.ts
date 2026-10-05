// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @slicerx/fleet-sim. See README.md for the public API.
import type {
  ApprovalToken,
  ApprovalVerifier,
  DemoFleet,
  Fleet,
  FleetOptions,
  FleetPrinterFixture,
  JobFile,
  PluginManifest,
  PrinterAction,
  PrinterError,
  PrinterErrorCode,
  PrinterEvent,
  PrinterHost,
  PrinterInfo,
  PrinterStatus,
  RemoteFile,
  SideEffectAction,
  SpoolFixture,
  StartOptions,
} from '@slicerx/contracts'
import manifestJson from '../../manifests.json' with { type: 'json' }
import { simFrameJpeg } from './frame.ts'

const manifests = manifestJson as unknown as PluginManifest[]

/** Thrown for every failure a host call can report. Carries the contract's `PrinterError` shape. */
export class FleetSimError extends Error implements PrinterError {
  readonly code: PrinterErrorCode
  readonly printerId?: string
  constructor(code: PrinterErrorCode, message: string, printerId?: string) {
    super(message)
    this.name = 'FleetSimError'
    this.code = code
    if (printerId !== undefined) this.printerId = printerId
  }
}

/** The host call being verified. `params` has the shape documented on `ApprovalAction` in the contracts. */
export interface TokenContext {
  action: SideEffectAction
  /** Printer id, or plugin id for `plugin.call`. */
  target: string
  params: unknown
}

/**
 * Checks and consumes an approval token, throwing `FleetSimError` (`approval_required` or
 * `approval_invalid`) when it does not hold. May be async.
 */
export type TokenVerifier = (token: ApprovalToken | undefined, ctx: TokenContext) => void | Promise<void>

/** Action names `permit.mint` accepts; they map onto `SideEffectAction`. */
export type MintAction = PrinterAction | 'inventory'

const MINT_ACTIONS: Record<MintAction, SideEffectAction> = {
  upload: 'printer.upload',
  start: 'printer.start',
  pause: 'printer.pause',
  resume: 'printer.resume',
  cancel: 'printer.cancel',
  gcode: 'printer.gcode',
  inventory: 'plugin.call',
}

export interface FleetSimOptions {
  /** Milliseconds since the epoch. Defaults to Date.now. */
  clock?: () => number
  /** Simulated seconds per real second passed to `tick`. Default 1. */
  speed?: number
  /** Replaces the demo token check. */
  verify?: TokenVerifier
  /**
   * Checks tokens with a broker such as Pilot's `createApprovalBroker()`. The sim hashes the
   * call's parameters with `hashParams` from `@slicerx/contracts` (loaded on first use) and
   * calls `verify(token, action, target, paramsHash)`.
   */
  approvals?: ApprovalVerifier
}

export interface FleetSim extends PrinterHost {
  /** Advance simulated time. Progress, temperatures and finished jobs update and events fire. */
  tick(ms: number): void
  permit: {
    /**
     * Mint a single use token bound to an action and a target (printer id, or plugin id for
     * `inventory`), and to `params` when given. Demo and test use only.
     */
    mint(action: MintAction, target?: string, params?: unknown): ApprovalToken
  }
}

interface SimPrinter {
  fx: FleetPrinterFixture
  state: PrinterStatus['state']
  nozzles: { current: number; target: number }[]
  bed: { current: number; target: number } | undefined
  chamber: { current: number; target: number } | undefined
  job: { name: string; progress: number; layerCount: number; totalS: number; elapsedS: number } | undefined
  message: string | undefined
  files: Map<string, { name: string; size: number; sha256: string }>
  preparingS: number
  gcodeLog: string[]
}

const AMBIENT = 25
const PREPARE_S = 30
const HEAT_RATE = 2.5
const PRINT_TEMP = { PLA: 215, PETG: 240, ABS: 255, ASA: 255, TPU: 225 } as Record<string, number>

function approach(cur: number, target: number, step: number): number {
  const goal = target > 0 ? target : AMBIENT
  if (Math.abs(goal - cur) <= step) return goal
  return cur + Math.sign(goal - cur) * step
}

export function createFleetSim(fixture: DemoFleet, opts: FleetSimOptions = {}): FleetSim {
  const clock = opts.clock ?? Date.now
  const speed = opts.speed ?? 1
  const printers = new Map<string, SimPrinter>()
  const spools = new Map<number, SpoolFixture>()
  const listeners = new Map<string, Set<(e: PrinterEvent) => void>>()
  const minted = new Map<string, { action: string; target: string | undefined; params: string | undefined; expiresAt: number }>()
  let counter = 0

  for (const fx of fixture.printers) {
    const total = fx.job ? Math.max(1, fx.job.timeLeftS / Math.max(1 - fx.job.progress, 0.001)) : 0
    printers.set(fx.id, {
      fx,
      state: fx.state,
      nozzles: fx.nozzles.map((n) => ({ ...n })),
      bed: fx.bed ? { ...fx.bed } : undefined,
      chamber: fx.chamber ? { ...fx.chamber } : undefined,
      job: fx.job
        ? { name: fx.job.name, progress: fx.job.progress, layerCount: fx.job.layerCount, totalS: total, elapsedS: total * fx.job.progress }
        : undefined,
      message: fx.message,
      files: new Map(),
      preparingS: 0,
      gcodeLog: [],
    })
  }
  for (const s of fixture.spools) spools.set(s.id, { ...s })
  const fleets = new Map<string, Fleet>()
  for (const f of fixture.fleets) fleets.set(f.id, structuredClone(f))
  let fleetCounter = 0

  const iso = (): string => new Date(clock()).toISOString()

  function get(id: string): SimPrinter {
    const p = printers.get(id)
    if (!p) throw new FleetSimError('not_found', `No printer ${id}`, id)
    return p
  }

  function getFleet(id: string): Fleet {
    const f = fleets.get(id)
    if (!f) throw new FleetSimError('not_found', `No fleet ${id}`)
    return f
  }

  function uniqueName(name: string, self?: string): string {
    const clean = name.trim()
    if (!clean) throw new FleetSimError('protocol', 'A fleet needs a name')
    for (const f of fleets.values()) {
      if (f.id !== self && f.name.toLowerCase() === clean.toLowerCase()) throw new FleetSimError('protocol', `A fleet named ${clean} already exists`)
    }
    return clean
  }

  function statusOf(p: SimPrinter): PrinterStatus {
    const offline = p.state === 'offline'
    const s: PrinterStatus = {
      printerId: p.fx.id,
      state: p.state,
      nozzles: p.nozzles.map((n) => ({ current: round1(n.current), target: n.target })),
      slots: p.fx.slots.map((slot) => ({ ...slot })),
      cameraAvailable: p.fx.cameraAvailable && !offline,
      updatedAt: iso(),
    }
    if (p.bed) s.bed = { current: round1(p.bed.current), target: p.bed.target }
    if (p.chamber) s.chamber = { current: round1(p.chamber.current), target: p.chamber.target }
    if (p.job && !offline) {
      s.jobName = p.job.name
      s.progress = round3(p.job.progress)
      s.layer = Math.min(p.job.layerCount, Math.round(p.job.progress * p.job.layerCount))
      s.layerCount = p.job.layerCount
      s.timeLeftS = Math.max(0, Math.round(p.job.totalS - p.job.elapsedS))
    }
    if (p.message) s.message = p.message
    if (p.fx.live && !offline) s.live = structuredClone(p.fx.live)
    return s
  }

  function emit(id: string, e: PrinterEvent): void {
    for (const cb of listeners.get(id) ?? []) cb(e)
  }
  function emitStatus(p: SimPrinter): void {
    emit(p.fx.id, { type: 'status', status: statusOf(p) })
  }

  function mint(action: MintAction, target?: string, params?: unknown): ApprovalToken {
    counter += 1
    const expiresAt = clock() + 5 * 60_000
    const token = `sim-${counter}-${Math.floor(clock()).toString(36)}`
    minted.set(token, { action: MINT_ACTIONS[action], target, params: params === undefined ? undefined : stable(params), expiresAt })
    return { requestId: `req-${counter}`, token, expiresAt: new Date(expiresAt).toISOString() }
  }

  const demoVerify: TokenVerifier = (token, ctx) => {
    if (!token || !token.token) throw new FleetSimError('approval_required', `${ctx.action} needs an approval token`, ctx.target)
    const rec = minted.get(token.token)
    if (!rec) throw new FleetSimError('approval_invalid', 'Unknown or already used token', ctx.target)
    minted.delete(token.token)
    if (rec.expiresAt < clock()) throw new FleetSimError('approval_invalid', 'Token expired', ctx.target)
    if (rec.action !== ctx.action) throw new FleetSimError('approval_invalid', `Token is for ${rec.action}, not ${ctx.action}`, ctx.target)
    if (rec.target !== ctx.target) throw new FleetSimError('approval_invalid', 'Token is bound to another target', ctx.target)
    if (rec.params !== undefined && rec.params !== stable(ctx.params)) throw new FleetSimError('approval_invalid', 'Token is bound to other parameters', ctx.target)
  }

  const brokerVerify = (broker: ApprovalVerifier): TokenVerifier => async (token, ctx) => {
    if (!token || !token.token) throw new FleetSimError('approval_required', `${ctx.action} needs an approval token`, ctx.target)
    const { hashParams } = await import('@slicerx/contracts')
    const check = await broker.verify(token, ctx.action, ctx.target, await hashParams(ctx.params))
    if (!check.ok) throw new FleetSimError('approval_invalid', `Approval rejected: ${check.reason}`, ctx.target)
  }

  const verify: TokenVerifier = opts.verify ?? (opts.approvals ? brokerVerify(opts.approvals) : demoVerify)

  function reachable(p: SimPrinter): void {
    if (p.state === 'offline') throw new FleetSimError('unreachable', `${p.fx.name} is offline`, p.fx.id)
  }

  function idleTemps(p: SimPrinter): void {
    for (const n of p.nozzles) n.target = 0
    if (p.bed) p.bed.target = 0
    if (p.chamber) p.chamber.target = 0
  }

  const host: FleetSim = {
    permit: { mint },

    async plugins() {
      return manifests.map((m) => structuredClone(m))
    },

    async list() {
      return [...printers.values()].map(({ fx }): PrinterInfo => {
        const info: PrinterInfo = {
          id: fx.id,
          name: fx.name,
          vendor: fx.vendor,
          model: fx.model,
          plugin: fx.plugin,
          host: fx.host,
          nozzleCount: fx.nozzleCount,
        }
        if (fx.filamentSystem) info.filamentSystem = fx.filamentSystem
        return info
      })
    },

    async fleets() {
      return [...fleets.values()].map((f) => structuredClone(f))
    },

    async createFleet(name, fleetOpts: FleetOptions = {}) {
      const clean = uniqueName(name)
      const ids = [...new Set(fleetOpts.printerIds ?? [])]
      for (const id of ids) get(id)
      fleetCounter += 1
      const fleet: Fleet = { id: `fleet-${fleetCounter}`, name: clean, printerIds: ids }
      if (fleetOpts.color) fleet.color = fleetOpts.color
      if (fleetOpts.icon) fleet.icon = fleetOpts.icon
      fleets.set(fleet.id, fleet)
      return structuredClone(fleet)
    },

    async renameFleet(fleetId, name) {
      const f = getFleet(fleetId)
      f.name = uniqueName(name, fleetId)
      return structuredClone(f)
    },

    async updateFleet(fleetId, patch) {
      const f = getFleet(fleetId)
      if (patch.color === null) delete f.color
      else if (patch.color !== undefined) f.color = patch.color
      if (patch.icon === null) delete f.icon
      else if (patch.icon !== undefined) f.icon = patch.icon
      return structuredClone(f)
    },

    async deleteFleet(fleetId) {
      getFleet(fleetId)
      fleets.delete(fleetId)
    },

    async addToFleet(fleetId, printerId) {
      const f = getFleet(fleetId)
      get(printerId)
      if (!f.printerIds.includes(printerId)) f.printerIds.push(printerId)
      return structuredClone(f)
    },

    async removeFromFleet(fleetId, printerId) {
      const f = getFleet(fleetId)
      f.printerIds = f.printerIds.filter((id) => id !== printerId)
      return structuredClone(f)
    },

    async status(printerId) {
      return statusOf(get(printerId))
    },

    subscribe(printerId, onEvent) {
      const p = get(printerId)
      let set = listeners.get(printerId)
      if (!set) {
        set = new Set()
        listeners.set(printerId, set)
      }
      set.add(onEvent)
      queueMicrotask(() => {
        if (set.has(onEvent)) onEvent({ type: 'status', status: statusOf(p) })
      })
      return () => {
        set.delete(onEvent)
      }
    },

    async upload(printerId, file: JobFile, token) {
      const p = get(printerId)
      await verify(token, { action: 'printer.upload', target: printerId, params: { printerId, name: file.name, sha256: file.sha256 } })
      reachable(p)
      if (!file.name || file.data.byteLength === 0) throw new FleetSimError('protocol', 'Empty upload', printerId)
      const path = `gcodes/${file.name}`
      p.files.set(path, { name: file.name, size: file.data.byteLength, sha256: file.sha256 })
      return { printerId, path, name: file.name, sha256: file.sha256 } satisfies RemoteFile
    },

    async start(file, startOpts: StartOptions, token) {
      const p = get(file.printerId)
      // Like the hub, the content hash comes from the sim's own record of the upload, not from the caller.
      const known = p.files.get(file.path)?.sha256
      await verify(token, { action: 'printer.start', target: file.printerId, params: known ? { printerId: file.printerId, name: file.name, opts: startOpts, sha256: known } : { printerId: file.printerId, name: file.name, opts: startOpts } })
      reachable(p)
      const rec = p.files.get(file.path)
      if (!rec) throw new FleetSimError('not_found', `${file.path} is not on ${p.fx.name}`, p.fx.id)
      if (p.state !== 'idle' && p.state !== 'finished') throw new FleetSimError('bad_state', `${p.fx.name} is ${p.state}`, p.fx.id)
      if (startOpts.slotMap) {
        for (const slot of Object.values(startOpts.slotMap)) {
          if (!p.fx.slots.some((s) => s.id === slot)) throw new FleetSimError('protocol', `No slot ${slot} on ${p.fx.name}`, p.fx.id)
        }
      }
      const layerCount = 100 + (rec.size % 200)
      const totalS = layerCount * 20
      p.job = { name: rec.name, progress: 0, layerCount, totalS, elapsedS: 0 }
      p.state = 'preparing'
      p.preparingS = 0
      p.message = undefined
      const material = p.fx.slots.find((s) => s.material)?.material ?? 'PLA'
      const t = PRINT_TEMP[material] ?? 215
      for (const n of p.nozzles) n.target = t
      if (p.bed) p.bed.target = 60
      emitStatus(p)
    },

    async pause(printerId, token) {
      const p = get(printerId)
      await verify(token, { action: 'printer.pause', target: printerId, params: { printerId } })
      reachable(p)
      if (p.state !== 'printing') throw new FleetSimError('bad_state', `${p.fx.name} is ${p.state}`, printerId)
      p.state = 'paused'
      emitStatus(p)
    },

    async resume(printerId, token) {
      const p = get(printerId)
      await verify(token, { action: 'printer.resume', target: printerId, params: { printerId } })
      reachable(p)
      if (p.state !== 'paused') throw new FleetSimError('bad_state', `${p.fx.name} is ${p.state}`, printerId)
      p.state = 'printing'
      p.message = undefined
      emitStatus(p)
    },

    async cancel(printerId, token) {
      const p = get(printerId)
      await verify(token, { action: 'printer.cancel', target: printerId, params: { printerId } })
      reachable(p)
      if (p.state !== 'printing' && p.state !== 'paused' && p.state !== 'preparing') {
        throw new FleetSimError('bad_state', `${p.fx.name} is ${p.state}`, printerId)
      }
      const name = p.job?.name ?? 'job'
      p.job = undefined
      p.state = 'idle'
      idleTemps(p)
      emit(printerId, { type: 'job_finished', printerId, jobName: name, ok: false })
      emitStatus(p)
    },

    async snapshot(printerId) {
      const p = get(printerId)
      if (!p.fx.cameraAvailable || p.state === 'offline') return null
      // A real JPEG, as real printers give, so picture readers (print check, phone tiles) work on the sim.
      return new Blob([simFrameJpeg()], { type: 'image/jpeg' })
    },

    async callTool(pluginId, tool, input, token) {
      const manifest = manifests.find((m) => m.id === pluginId)
      if (!manifest) throw new FleetSimError('not_found', `No plugin ${pluginId}`)
      const name = tool.startsWith(`${pluginId}.`) ? tool.slice(pluginId.length + 1) : tool
      const args = (input ?? {}) as Record<string, unknown>
      if (pluginId === 'spoolman') {
        if (name === 'list_spools') {
          const material = typeof args.material === 'string' ? args.material : undefined
          return [...spools.values()].filter((s) => !material || s.material === material).map((s) => ({ ...s }))
        }
        if (name === 'get_spool') {
          const s = spools.get(Number(args.id))
          if (!s) throw new FleetSimError('not_found', `No spool ${String(args.id)}`)
          return { ...s }
        }
        if (name === 'record_usage') {
          await verify(token, { action: 'plugin.call', target: pluginId, params: { pluginId, tool: name, input: args } })
          const s = spools.get(Number(args.id))
          if (!s) throw new FleetSimError('not_found', `No spool ${String(args.id)}`)
          const grams = Number(args.grams)
          if (!(grams >= 0)) throw new FleetSimError('protocol', 'grams must be zero or more')
          s.remainingG = Math.max(0, s.remainingG - grams)
          return { ...s }
        }
        throw new FleetSimError('not_supported', `spoolman has no tool ${name}`)
      }
      if (manifest.kind === 'printer' && name === 'status') {
        return statusOf(get(String(args.printerId)))
      }
      if (manifest.kind === 'printer' && name === 'gcode') {
        const p = get(String(args.printerId))
        await verify(token, { action: 'printer.gcode', target: p.fx.id, params: { printerId: p.fx.id, line: String(args.line) } })
        reachable(p)
        if (!manifest.capabilities.includes('gcode_console')) throw new FleetSimError('not_supported', `${pluginId} has no G-code console`, p.fx.id)
        p.gcodeLog.push(String(args.line))
        return { ok: true }
      }
      throw new FleetSimError('not_supported', `${pluginId}.${name} is not available in the demo fleet`)
    },

    tick(ms) {
      const dt = (ms / 1000) * speed
      for (const p of printers.values()) {
        if (p.state === 'offline') continue
        for (const n of p.nozzles) n.current = approach(n.current, n.target, HEAT_RATE * dt * (n.target > 0 ? 4 : 0.2))
        if (p.bed) p.bed.current = approach(p.bed.current, p.bed.target, HEAT_RATE * dt * (p.bed.target > 0 ? 1 : 0.1))
        if (p.chamber) p.chamber.current = approach(p.chamber.current, p.chamber.target, 0.05 * dt)
        if (p.state === 'preparing') {
          p.preparingS += dt
          if (p.preparingS >= PREPARE_S) p.state = 'printing'
        } else if (p.state === 'printing' && p.job) {
          p.job.elapsedS = Math.min(p.job.totalS, p.job.elapsedS + dt)
          p.job.progress = p.job.elapsedS / p.job.totalS
          if (p.job.progress >= 1) {
            p.state = 'finished'
            idleTemps(p)
            emit(p.fx.id, { type: 'job_finished', printerId: p.fx.id, jobName: p.job.name, ok: true })
          }
        }
        emitStatus(p)
      }
    },
  }
  return host
}

/** Key-sorted JSON, so two objects with the same members compare equal. */
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(',')}}`
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
