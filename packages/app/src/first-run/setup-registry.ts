// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The printer setup host registry, kept apart from setup-host.ts so the shell (link/bridge.ts)
// does not carry the setup screens' form and the printer catalog before anyone opens them.
import type { Host, PrinterConnection, PrinterHardware, PrinterSetupHost, PrinterState } from '@slicerx/contracts'

export type TestStepId = 'reach' | 'sign_in' | 'read_state' | 'read_temperatures'
export const TEST_STEPS: readonly { id: TestStepId; label: string }[] = [
  { id: 'reach', label: 'Reach the printer' },
  { id: 'sign_in', label: 'Sign in' },
  { id: 'read_state', label: 'Read state' },
  { id: 'read_temperatures', label: 'Read temperatures' },
]

export interface TestStep {
  id: TestStepId
  /** null while not reached, true passed, false failed. */
  ok: boolean | null
  running?: boolean
  /** Elapsed time for the step, in ms. */
  ms?: number
}

/** The contract's causes. */
/** `local`: the test stopped on this computer (the keychain, the bridge) before it reached the printer. */
export type SetupCause = 'unreachable' | 'auth' | 'timeout' | 'protocol' | 'not_supported' | 'bad_request' | 'local'

export type AuthNeed = 'not_trusted' | 'key_wrong' | 'login_required' | 'pair_again' | 'declined' | 'lan_mode_off'
const AUTH_NEEDS = ['not_trusted', 'key_wrong', 'login_required', 'pair_again', 'declined', 'lan_mode_off'] as const

export interface TestOutcome {
  ok: boolean
  steps: TestStep[]
  cause?: SetupCause
  /** The bridge's stable failure kind (`tls`, `auth`, `timeout` or `other`); the panel's words key off it and the cause. */
  kind?: string
  /** The raw error, for Copy details and a report only, never the panel. */
  details?: string
  /** Bambu Lab: whether its CA issued the printer's certificate for that serial. */
  certificate?: { verified: boolean; detail: string }
  /** Why a sign-in was refused, when the printer said (Moonraker, Snapmaker 2.0, UltiMaker, Anycubic). */
  authNeed?: AuthNeed
  /** A finer cause when the host can tell (a bridge reports these as unreachable or auth). */
  detail?: 'lan-mode-off' | 'wrong-port' | 'certificate'
  message?: string
  state?: PrinterState
  nozzleC?: number
  bedC?: number
  firmware?: string
  /** The model the printer reports, when it says. */
  reportedModel?: string
  /** The installed nozzle, when the printer reports it (Bambu Lab does). */
  nozzleMm?: number
  /** Filament unit and slot count read from the printer. */
  filamentSystem?: 'ams' | 'mmu' | 'toolchanger'
  slotCount?: number
  /** SHA-256 fingerprint of a self-signed certificate, for the trust prompt. */
  fingerprint?: string
  /** Everything the printer reported about itself: nozzles per extruder, filament units and their slots. */
  hardware?: PrinterHardware
}

export interface FoundPrinter {
  id: string
  name: string
  family: string
  address?: string
  /** "Bambu Lab X1 Carbon": vendor and model as the printer announces them. */
  model?: string
  /** What the scan could read without signing in. Absent when the printer did not say. */
  nozzleMm?: number
  nozzleCount?: number
  filamentSystem?: 'ams' | 'mmu' | 'toolchanger'
  slotCount?: number
  state?: PrinterState
  /** Bambu Lab: the serial number the printer announced, so nobody types it. */
  serial?: string
  firmware?: string
  /** Bambu Lab: true while LAN Only Mode is on, false while the printer uses Bambu Cloud. */
  lanOnly?: boolean
}

/**
 * PrinterSetupHost from contracts, plus what the screens need: progress while testing, a label for
 * the scan range, and whether credentials reach a keychain. The credential travels inside the
 * connection and is dropped after the call.
 */
export interface AppSetupHost extends PrinterSetupHost {
  /** True when credentials go to the system keychain; false means one is used for the test only. */
  keychain: boolean
  /** Where the scan looks, in words, for the approval card and the button. */
  scanRange: string
  discover(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<FoundPrinter[]>
  /** Asks one IP address whether a printer is there, for "Enter IP instead". Absent when the host cannot ask. */
  probe?(host: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<FoundPrinter[]>
  testConnection(connection: PrinterConnection, onStep?: (steps: TestStep[]) => void, opts?: { signal?: AbortSignal; trustFingerprint?: string }): Promise<TestOutcome>
  /** `credentialKept: 'session'`: the system keychain refused the code, so it lasts until the app closes. */
  addPrinter(input: { profileId: string; nozzleMm: number; connection?: PrinterConnection; name?: string }): Promise<{ printerId: string; credentialKept?: 'session' }>
}

export type SetupFactory = (host: Host) => AppSetupHost
let factory: SetupFactory | null = null

/** Called once by an app entry that has a bridge to real printers. */
export function registerPrinterSetup(f: SetupFactory | null): void {
  factory = f
}

export function registeredPrinterSetup(): SetupFactory | null {
  return factory
}

/** Maps a bridge test result (link-client PrinterTestResult) onto the setup card's outcome. */
export function fromLinkResult(r: { ok: boolean; state?: PrinterState; cause?: string; kind?: string; message?: string; details?: string; certificate?: { verified: boolean; detail: string }; authNeed?: string; steps: { id: TestStepId; ok: boolean | null }[]; nozzleC?: number; bedC?: number; hardware?: PrinterHardware }): TestOutcome {
  const cause = r.cause && ['unreachable', 'auth', 'timeout', 'protocol', 'not_supported', 'bad_request'].includes(r.cause) ? (r.cause as SetupCause) : undefined
  const hw = r.ok ? r.hardware : undefined
  const nozzle = hw?.extruders?.find((e) => e.nozzleDiameterMm)?.nozzleDiameterMm
  const units = (hw?.filamentUnits ?? []).filter((u) => u.kind !== 'external')
  const system: 'ams' | 'mmu' | undefined = units.length === 0 ? undefined : units.some((u) => u.kind === 'mmu') ? 'mmu' : 'ams'
  return {
    ok: r.ok,
    steps: TEST_STEPS.map(({ id }) => ({ id, ok: r.steps.find((s) => s.id === id)?.ok ?? null })),
    ...(cause ? { cause } : {}),
    ...(!r.ok && r.kind ? { kind: r.kind } : {}),
    ...(!r.ok && r.details ? { details: r.details } : {}),
    ...(r.certificate ? { certificate: r.certificate } : {}),
    ...(!r.ok && r.authNeed && (AUTH_NEEDS as readonly string[]).includes(r.authNeed) ? { authNeed: r.authNeed as AuthNeed } : {}),
    ...(r.message ? { message: r.message } : {}),
    ...(r.state ? { state: r.state } : {}),
    ...(r.ok && r.nozzleC !== undefined ? { nozzleC: r.nozzleC } : {}),
    ...(r.ok && r.bedC !== undefined ? { bedC: r.bedC } : {}),
    ...(hw ? { hardware: hw } : {}),
    ...(hw?.model ? { reportedModel: hw.model } : {}),
    ...(hw?.firmware ? { firmware: hw.firmware } : {}),
    ...(nozzle ? { nozzleMm: nozzle } : {}),
    ...(system ? { filamentSystem: system, slotCount: units.reduce((n, u) => n + u.slots.length, 0) } : {}),
  }
}
