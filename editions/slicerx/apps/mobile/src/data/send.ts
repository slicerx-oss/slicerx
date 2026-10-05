// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slice from the phone and send to a printer. The model goes to the cloud slicer with the
// printer's bed and flavor and the Easy settings; the G-code comes back and is uploaded
// and started under one approval that covers exactly those two calls.
import type { EasySettings, Fleet, StoreClient, JobFile, PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { useQueryClient } from '@tanstack/react-query'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { useCallback, useMemo, useRef, useState } from 'react'
import { runCloudSlice, type Material, type PhoneModel, type SlicePhase } from '../cloud/slice-job'
import { boxStl } from '../cloud/stl'
import { createCloudStub } from '../cloud/stub'
import type { PrinterView } from '../components/printers/printer-bits'
import { sendSlice, sliceOnComputer } from '../pair'
import { approve, buildApproval } from '../state/approval'
import { get } from '../state/store'
import type { PocketHost } from '../host'
import { keys } from './queries'
import { useCatalog, type CatalogItem } from './catalog'
import { usePocketHost } from './provider'

export const SAMPLE_MODEL: PhoneModel = { id: 'sample-cube', name: 'Calibration cube 20 mm.stl', origin: 'sample', bytes: 684, load: async () => boxStl([20, 20, 20]) }

/**
 * A library model as the slicer takes it. The file comes from the store's download address for the
 * current version. sx3mf is a 3MF container, so it is sliced as one.
 */
export function libraryModel(item: CatalogItem, store: StoreClient | null): PhoneModel {
  const version = item.listing.currentVersion
  return {
    id: `listing-${item.listing.id}`,
    name: `${item.listing.title}.${version?.format === 'stl' ? 'stl' : '3mf'}`,
    origin: 'library',
    by: item.creator.displayName,
    ...(version ? { versionId: version.id, bytes: version.sizeBytes } : {}),
    load: async () => {
      // The demo catalog has no files; a stand-in body lets the flow run end to end.
      if (!store || !version || store.mode === 'offline') return boxStl([60, 60, 42])
      const link = await store.download(item.listing.id)
      // Downloads work signed out, limited per network, so the one error with its own words is the limit.
      if (!link.ok) throw new Error(link.code === 'rate_limited' ? 'Too many downloads from this network for now. Try again in a little while' : link.message)
      const res = await fetch(link.value.url)
      if (!res.ok) throw new Error('Could not download the model. Check your connection')
      return res.arrayBuffer()
    },
  }
}

/** The printer a fleet send goes to: the first idle one, else the first one that is not busy. */
export function pickFromFleet(fleet: Fleet, views: PrinterView[]): PrinterInfo | null {
  const members = views.filter((v) => fleet.printerIds.includes(v.info.id))
  const ready = (s: PrinterStatus | null, states: string[]) => s !== null && states.includes(s.state)
  return (members.find((v) => ready(v.status, ['idle'])) ?? members.find((v) => ready(v.status, ['finished'])))?.info ?? null
}

type SendInput = { model: PhoneModel; printer: PrinterInfo; easy: EasySettings; material: Material }

function sendApproval(file: Pick<JobFile, 'name' | 'sha256'>, printer: PrinterInfo, o: { layerCount: number; timeS: number; grams: number }) {
  return buildApproval({
    tool: 'printer.send',
    permission: 'start',
    title: `Print ${file.name} on ${printer.name}?`,
    lines: [`${o.layerCount} layers, ${Math.round(o.timeS / 60)} min, ${o.grams.toFixed(1)} g`, `${printer.name}: ${printer.vendor} ${printer.model}`],
    printerId: printer.id,
    actions: [
      { action: 'printer.upload', target: printer.id, params: { printerId: printer.id, name: file.name, sha256: file.sha256 } },
      { action: 'printer.start', target: printer.id, params: { printerId: printer.id, name: file.name, opts: {}, ...(file.sha256 ? { sha256: file.sha256 } : {}) } },
    ],
  })
}

/**
 * Slices and sends. With a paired computer that can slice, the computer slices and sends
 * (it signs its own approval only when it matches the phone's token); otherwise the cloud
 * slices and the phone uploads through host.printers. Resolves once the printer accepted
 * the job. The person already confirmed on the device before the screen called this.
 */
export async function sliceAndSend(host: PocketHost, input: SendInput, onPhase: (p: SlicePhase) => void, signal?: AbortSignal): Promise<{ layerCount: number; timeS: number; grams: number }> {
  const { printer } = input
  if (get().sliceLocation && host.printers.source().kind === 'paired') {
    const slice = await sliceOnComputer(host, input, onPhase, signal)
    const token = await approve(host.approvals, await sendApproval(slice.file, printer, slice))
    await sendSlice(host, slice.sliceId, printer, token)
    return slice
  }
  // The cloud slicer takes the signed-in session's token; say so before uploading anything.
  if (host.edition.backend.cloudApi && !(await host.account.accessToken())) throw new Error('Sign in to slice in the cloud, or pair a computer to slice on')
  const outcome = await runCloudSlice(host.cloud, input, onPhase, signal)
  const token = await approve(host.approvals, await sendApproval(outcome.file, printer, outcome))
  const remote = await host.printers.upload(printer.id, outcome.file, token)
  await host.printers.start({ ...remote, sha256: remote.sha256 ?? outcome.file.sha256 }, {}, token)
  return outcome
}

/** Models the send screen can offer: picked files, the model opened from its page, the library, then the sample. */
export function useSendModels(opened?: CatalogItem | null) {
  const host = usePocketHost()
  const library = useCatalog()
  const [files, setFiles] = useState<PhoneModel[]>([])
  const models = useMemo(() => {
    const items = library.data ?? []
    const all = opened && !items.some((i) => i.listing.id === opened.listing.id) ? [opened, ...items] : items
    return [...files, ...all.map((i) => libraryModel(i, host.store)), SAMPLE_MODEL]
  }, [files, library.data, opened, host.store])

  const pickFile = useCallback(async (): Promise<PhoneModel | null> => {
    const r = await DocumentPicker.getDocumentAsync({ type: ['model/stl', 'model/3mf', 'application/octet-stream', '*/*'], copyToCacheDirectory: true, multiple: false })
    const asset = r.canceled ? undefined : r.assets[0]
    if (!asset) return null
    if (!/\.(stl|3mf|obj)$/i.test(asset.name)) throw new Error('Pick an STL, 3MF or OBJ file')
    const m: PhoneModel = { id: `file-${asset.uri}`, name: asset.name, origin: 'file', ...(asset.size ? { bytes: asset.size } : {}), load: () => new File(asset.uri).arrayBuffer() }
    setFiles((list) => [m, ...list.filter((x) => x.id !== m.id)].slice(0, 6))
    return m
  }, [])

  return { models, loading: library.isPending && library.fetchStatus !== 'idle', pickFile }
}

/** Time and filament for a selection, from the local estimator (no upload). */
export function useEstimate() {
  const estimator = useRef(createCloudStub({ stageMs: 0, queueMs: 0 }))
  const [estimate, setEstimate] = useState<{ timeS: number; grams: number; plates: number } | null>(null)
  const [estimating, setEstimating] = useState(false)
  const seq = useRef(0)
  const run = useCallback((input: { model: PhoneModel; printer: PrinterInfo; easy: EasySettings; material: Material } | null) => {
    const mine = ++seq.current
    if (!input) {
      setEstimate(null)
      return
    }
    setEstimating(true)
    runCloudSlice(estimator.current, input, () => undefined).then(
      (o) => mine === seq.current && setEstimate({ timeS: o.timeS, grams: o.grams, plates: 1 }),
      () => mine === seq.current && setEstimate(null),
    ).finally(() => mine === seq.current && setEstimating(false))
  }, [])
  return { estimate, estimating, run }
}

export function useRefreshPrinters() {
  const host = usePocketHost()
  const client = useQueryClient()
  return useCallback(async () => {
    await client.invalidateQueries({ queryKey: keys.printers })
    const list = await host.printers.list()
    await Promise.all(list.map((p) => host.printers.status(p.id).then((s) => client.setQueryData(keys.status(p.id), s))))
  }, [host, client])
}
