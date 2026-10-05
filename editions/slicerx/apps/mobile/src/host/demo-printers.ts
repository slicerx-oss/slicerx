// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The demo fleet (fleet-sim) behind the approval broker, for a phone that is not paired
// with a computer yet. Every side effect is checked against the broker with the hash of
// the exact parameters the call carries, so a token approved for one printer, file or
// action does nothing for another.
import { hashParams, type ApprovalToken, type ApprovalVerifier, type DemoFleet, type JobFile, type PrinterHost, type RemoteFile, type SideEffectAction, type StartOptions } from '@slicerx/contracts'
import { createFleetSim } from '@slicerx/fleet-sim'
import { simFrameJpeg } from '../../../../../../packages/connect/sim/src/frame'
import demo from '../../../../../../packages/connect/fixtures/demo-fleet.json'

async function check(verifier: ApprovalVerifier, token: ApprovalToken, action: SideEffectAction, target: string, params: unknown): Promise<void> {
  const r = await verifier.verify(token, action, target, await hashParams(params))
  if (!r.ok) throw new Error(`Approval refused (${r.reason}). Nothing was sent to the printer.`)
}

export function createDemoPrinters(verifier: ApprovalVerifier): PrinterHost & { stop(): void; snapshotImage(printerId: string): Promise<{ contentType: string; data: Uint8Array } | null> } {
  const sim = createFleetSim(demo as unknown as DemoFleet)
  // Simulated time runs at wall-clock speed while the app runs.
  const timer = setInterval(() => sim.tick(1000), 1000)
  const { tick: _tick, permit: _permit, ...reads } = sim
  return {
    ...reads,
    stop: () => clearInterval(timer),
    // React Native cannot build a Blob from bytes, which is what the sim's snapshot does, so the phone draws the sim's own frame from its bytes.
    async snapshotImage(printerId: string) {
      const st = await sim.status(printerId)
      return st.cameraAvailable && st.state !== 'offline' ? { contentType: 'image/jpeg', data: simFrameJpeg() } : null
    },
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
