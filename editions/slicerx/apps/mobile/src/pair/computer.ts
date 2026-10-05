// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slicing on the paired computer instead of the cloud. The model goes to the computer over the
// encrypted connection, the computer slices it with the phone's material and Easy settings, and
// the G-code stays there. Sending then asks the computer to upload and start it, under the phone
// token the person approved.
import { SLICE_STAGES, type ApprovalToken, type EasySettings, type JobFile, type PrinterInfo, type SliceStage } from '@slicerx/contracts'
import { PairError, type HostConnection } from '@slicerx/pair'
import type { Material, PhoneModel, SlicePhase } from '../cloud/slice-job'
import type { PocketHost } from '../host'
import { pairService } from './service'

export interface ComputerSliceOutcome {
  sliceId: string
  file: Pick<JobFile, 'name' | 'sha256'>
  layerCount: number
  timeS: number
  grams: number
}

/** The connection to the computer whose printers are live, or an error when the demo fleet is. */
async function activeConnection(pocket: PocketHost): Promise<{ pairingId: string; conn: HostConnection }> {
  const source = pocket.printers.source()
  if (source.kind !== 'paired') throw new PairError('unavailable', 'Pair a computer to slice on it')
  const svc = await pairService(pocket)
  const state = svc.hosts().find((h) => h.host.hostId === source.hostId)
  if (!state) throw new PairError('not_found', 'That computer is no longer paired')
  return { pairingId: state.host.pairingId, conn: await svc.connection(state.host.pairingId) }
}

// Hermes has no DOMException, so the abort error is a plain Error with the standard name.
const aborted = (signal?: AbortSignal) => {
  if (!signal?.aborted) return
  const e = new Error('Canceled')
  e.name = 'AbortError'
  throw e
}

const asStage = (stage: string): SliceStage => ((SLICE_STAGES as readonly string[]).includes(stage) ? (stage as SliceStage) : 'layers')

export async function sliceOnComputer(
  pocket: PocketHost,
  input: { model: PhoneModel; printer: PrinterInfo; easy: EasySettings; material: Material },
  onPhase: (p: SlicePhase) => void,
  signal?: AbortSignal,
): Promise<ComputerSliceOutcome> {
  const { conn } = await activeConnection(pocket)
  if (!conn.info.slicing.includes('host')) throw new PairError('not_supported', `${conn.info.identity.name} cannot slice`)
  const kind = /\.3mf$/i.test(input.model.name) ? '3mf' : /\.stl$/i.test(input.model.name) ? 'stl' : null
  if (!kind) throw new PairError('not_supported', 'The computer slices STL and 3MF files')
  onPhase({ kind: 'uploading' })
  const data = new Uint8Array(await input.model.load())
  aborted(signal)
  const blobId = await conn.uploadModel({ name: input.model.name, kind, data, printerId: input.printer.id })
  aborted(signal)
  onPhase({ kind: 'queued' })
  const slice = await conn.slice(
    { source: { kind: 'blob', blobId }, where: 'host', printerId: input.printer.id, options: { material: input.material, easy: input.easy } },
    (stage, fraction) => onPhase({ kind: 'slicing', stage: asStage(stage), fraction }),
  )
  aborted(signal)
  return {
    sliceId: slice.sliceId,
    file: { name: slice.name, sha256: slice.sha256 },
    layerCount: slice.layers ?? 0,
    timeS: slice.timeS ?? 0,
    grams: slice.grams ?? 0,
  }
}

/**
 * Uploads and starts a computer slice on one printer. `token` is the phone's own approval for
 * printer.upload and printer.start on `file.name` and `file.sha256`, minted after device auth;
 * the computer's request is signed only if it matches.
 */
export async function sendSlice(pocket: PocketHost, sliceId: string, printer: PrinterInfo, token: ApprovalToken): Promise<void> {
  const { pairingId } = await activeConnection(pocket)
  const svc = await pairService(pocket)
  await svc.printers(pairingId).sendSlice(sliceId, printer.id, token, { start: true })
}
