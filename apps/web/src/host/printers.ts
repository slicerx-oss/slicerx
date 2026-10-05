// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The browser demo fleet: fleet-sim behind the approval broker. Every side
// effect is checked against the broker first, with the hash of the exact
// parameters the call carries, so a token approved for one printer, file or
// action does nothing for another. Only then does the sim run it.
import {
  hashParams,
  type ApprovalToken,
  type ApprovalVerifier,
  type DemoFleet,
  type JobFile,
  type PrinterHost,
  type RemoteFile,
  type SideEffectAction,
  type StartOptions,
} from '@slicerx/contracts'
import { createFleetSim } from '@slicerx/fleet-sim'
import demo from '../../../../packages/connect/fixtures/demo-fleet.json'

async function check(verifier: ApprovalVerifier, token: ApprovalToken, action: SideEffectAction, target: string, params: unknown): Promise<void> {
  const r = await verifier.verify(token, action, target, await hashParams(params))
  if (!r.ok) throw new Error(`Approval refused (${r.reason}). Nothing was sent to the printer.`)
}

export function createDemoPrinters(verifier: ApprovalVerifier): PrinterHost {
  const sim = createFleetSim(demo as unknown as DemoFleet)
  // Simulated time runs at wall-clock speed while the page is open.
  window.setInterval(() => sim.tick(1000), 1000)
  // Reads and local fleet grouping pass straight through; only side effects are wrapped.
  const { tick: _tick, permit: _permit, ...reads } = sim
  return {
    ...reads,
    async upload(printerId: string, file: JobFile, token: ApprovalToken): Promise<RemoteFile> {
      await check(verifier, token, 'printer.upload', printerId, { printerId, name: file.name, sha256: file.sha256 })
      return sim.upload(printerId, file, sim.permit.mint('upload', printerId))
    },
    async start(file: RemoteFile, opts: StartOptions, token: ApprovalToken): Promise<void> {
      await check(verifier, token, 'printer.start', file.printerId, { printerId: file.printerId, name: file.name, opts, ...(file.sha256 ? { sha256: file.sha256 } : {}) })
      return sim.start(file, opts, sim.permit.mint('start', file.printerId))
    },
    async pause(printerId, token) {
      await check(verifier, token, 'printer.pause', printerId, { printerId })
      return sim.pause(printerId, sim.permit.mint('pause', printerId))
    },
    async resume(printerId, token) {
      await check(verifier, token, 'printer.resume', printerId, { printerId })
      return sim.resume(printerId, sim.permit.mint('resume', printerId))
    },
    async cancel(printerId, token) {
      await check(verifier, token, 'printer.cancel', printerId, { printerId })
      return sim.cancel(printerId, sim.permit.mint('cancel', printerId))
    },
    async callTool(pluginId, tool, input, token) {
      if (token) await check(verifier, token, 'plugin.call', pluginId, { pluginId, tool, input })
      return sim.callTool(pluginId, tool, input, token ? sim.permit.mint('inventory') : undefined)
    },
  }
}
