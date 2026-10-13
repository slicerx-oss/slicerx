// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printer backends for the MCP server: simulated printers, or real
// printers through a running sx-link bridge. Both verify an approval token on
// every side effect; the server obtains tokens only through the permission gate.
import { readFileSync } from 'node:fs'
import type { ApprovalHost, ApprovalRequest, ApprovalVerifier, DemoFleet, JobFile, PrinterHost } from '@slicerx/contracts'
import type { AgentWork, ApprovalBroker } from '@slicerx/pilot'
import { forHub, type ApprovalDone, type PersonHandOff } from './gate'
import { createFleetSim } from '@slicerx/fleet-sim'
import { connectLink } from '@slicerx/link-client'
import { STUB_MARKER } from './slicer'
import { readZip } from './zip'

export type PrinterMode = 'demo' | 'link' | 'off'

export interface PrinterBackend {
  readonly kind: 'demo' | 'link'
  readonly host: PrinterHost
  /** The bridge's own approval broker (sx-link), which the bridge verifies tokens against. */
  readonly approvals?: ApprovalHost
  /** Link mode: person-only cards go to the hub with their work, and the hub reports how it ran. */
  readonly handOff?: PersonHandOff
  /** Link mode: the app link, for the design tools to run on the project open in the app. */
  readonly appLink?: import('./app-route').AppLinkCaller
  /** Link mode: ends the connection to sx-link. An open link keeps Node running, so a one-shot run closes it when done. */
  readonly close?: () => void
}

/**
 * The hub's person-only hand-off, when this link client offers it: `approvals.registerWork`
 * sends `approvals.register {request, work}` and `onApprovalDone` hears `approval.done`.
 */
function handOffOf(host: unknown): PersonHandOff | undefined {
  const h = host as { approvals?: { registerWork?: (r: ApprovalRequest, w: AgentWork) => Promise<unknown> }; onApprovalDone?: (cb: (d: ApprovalDone) => void) => () => void }
  const registerWork = h.approvals?.registerWork
  const onDone = h.onApprovalDone
  if (typeof registerWork !== 'function' || typeof onDone !== 'function') return undefined
  return {
    ...((host as { partner?: boolean }).partner ? { partner: true } : {}),
    register: async (request, work) => {
      // The same guard as uploads: stub engine output never goes to a printer.
      if (work.kind === 'print' && stubOutput(work.file)) {
        throw new Error('That G-code came from the stub engine and is not printable. Slice with the sx engine first.')
      }
      await registerWork.call(h.approvals, request, work)
    },
    onDone: (cb) => onDone.call(h, cb),
  }
}

/** Whether a file to print is stub engine output: its G-code starts with the marker, in a .gcode.3mf its plate's G-code does. */
export function stubOutput(file: Pick<JobFile, 'data'>): boolean {
  const bytes = new Uint8Array(file.data)
  const head = (b: Uint8Array): boolean => new TextDecoder().decode(b.subarray(0, 200)).includes(STUB_MARKER)
  // A ZIP starts with the bytes 50 4B 03 04 ("PK").
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) return head(bytes)
  try {
    const gcode = readZip(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).read('Metadata/plate_1.gcode')
    return gcode ? head(gcode) : false
  } catch {
    return false
  }
}

/** Refuses uploads of stub engine output, which holds only comments. */
function guardUploads(host: PrinterHost): PrinterHost {
  const upload = host.upload.bind(host)
  const guarded: PrinterHost = Object.create(host) as PrinterHost
  guarded.upload = async (id: string, file: JobFile, token) => {
    if (stubOutput(file)) throw new Error('That G-code came from the stub engine and is not printable. Slice with the sx engine first.')
    return upload(id, file, token)
  }
  return guarded
}

/** The fleet in packages/connect/fixtures/demo-fleet.json. Nothing here reaches a real printer. */
export function createDemoPrinters(demoFleetFile: string, approvals: ApprovalVerifier, clock?: () => number): PrinterBackend {
  const fleet = JSON.parse(readFileSync(demoFleetFile, 'utf8')) as DemoFleet
  const sim = createFleetSim(fleet, { approvals, ...(clock ? { clock } : {}) })
  return { kind: 'demo', host: guardUploads(sim) }
}

/** Real printers through sx-link on this machine, paired with the hub's agent code. */
export async function createLinkPrinters(url: string, auth: { code: string } | { clientKey: string }, hubKey?: string, ws?: typeof WebSocket): Promise<PrinterBackend> {
  // Always the agent role: the hub then stamps this server's cards as MCP and lets only a person answer starts.
  // With the hub's key from its state directory, the code goes only to a hub that proves it holds that key.
  const host = await connectLink({ url, ...auth, role: 'agent', ...(hubKey ? { hubKey } : {}), ...(ws ? { WebSocket: ws } : {}) })
  const handOff = handOffOf(host)
  const appLink = typeof (host as { appLink?: { call?: unknown } }).appLink?.call === 'function' ? host.appLink : undefined
  return { kind: 'link', host: guardUploads(host), approvals: host.approvals, ...(handOff ? { handOff } : {}), ...(appLink ? { appLink } : {}), close: () => host.close() }
}

/**
 * Sends approval requests for printer and plugin calls to the bridge's broker, which is what
 * sx-link verifies against, and keeps everything else (project changes, saved profiles) on the
 * server's own broker. Printer setup (`printer.config`) is verified by this server, because the bridge does not check it. The user still approves in the same place; only the token's issuer differs.
 */
export function createRoutedBroker(local: ApprovalBroker, bridge: ApprovalHost): ApprovalBroker {
  const onBridge = new Set<string>()
  const forBridge = forHub
  return {
    async register(req) {
      if (forBridge(req)) {
        onBridge.add(req.id)
        await bridge.register(req)
      } else await local.register(req)
    },
    grant: (id) => (onBridge.has(id) ? bridge.grant(id) : local.grant(id)),
    // The bridge's hub needs the bed answer for a card start; the local broker never starts a print, so it has nothing to ask.
    grantWith: (id, o) => (onBridge.has(id) && bridge.grantWith ? bridge.grantWith(id, o) : onBridge.has(id) ? bridge.grant(id) : local.grant(id)),
    async deny(id, reason) {
      if (onBridge.has(id)) await bridge.deny(id, reason)
      else await local.deny(id, reason)
    },
    verify: (token, action, target, paramsHash) => local.verify(token, action, target, paramsHash),
    pending: () => local.pending(),
  }
}
