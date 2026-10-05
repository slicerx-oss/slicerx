// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One PrinterHost whose backing source can change while the app runs: the demo fleet
// until a computer is paired, then that computer's printers. Calls go to whichever source
// is current; listeners hear about a switch so cached lists and subscriptions restart.
import type { PrinterHost } from '@slicerx/contracts'
import type { PairedCamera } from '../camera/feed'

export type PrinterSource = { kind: 'demo' } | { kind: 'paired'; hostId: string; hostName: string }

export interface SwitchablePrinters extends PrinterHost {
  source(): PrinterSource
  /** A camera snapshot as a data URI, from whichever snapshot call the current source supports. */
  snapshotUri(printerId: string): Promise<string | null>
  /** The current source's live camera stream, or null (demo fleet, or a source without one). */
  camera(): PairedCamera | null
  /** Replaces the backing host. The old one is not stopped; its owner does that. */
  use(source: PrinterSource, printers: PrinterHost, camera?: PairedCamera | null): void
  onSwitch(cb: (source: PrinterSource) => void): () => void
}

function base64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the snapshot'))
    reader.readAsDataURL(blob)
  })
}

export function switchablePrinters(source: PrinterSource, initial: PrinterHost): SwitchablePrinters {
  let current = initial
  let where = source
  let liveCamera: PairedCamera | null = null
  const listeners = new Set<(s: PrinterSource) => void>()
  return {
    source: () => where,
    async snapshotUri(printerId) {
      // A paired computer returns bytes; React Native cannot build a Blob from bytes.
      const withImage = current as PrinterHost & { snapshotImage?: (id: string) => Promise<{ contentType: string; data: Uint8Array } | null> }
      if (withImage.snapshotImage) {
        const img = await withImage.snapshotImage(printerId)
        return img ? `data:${img.contentType};base64,${base64(img.data)}` : null
      }
      const blob = await current.snapshot(printerId)
      return blob ? blobToDataUri(blob) : null
    },
    camera: () => liveCamera,
    use(next, printers, camera) {
      where = next
      current = printers
      liveCamera = camera ?? null
      for (const l of listeners) l(next)
    },
    onSwitch(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    plugins: () => current.plugins(),
    list: () => current.list(),
    fleets: () => current.fleets(),
    createFleet: (name, opts) => current.createFleet(name, opts),
    renameFleet: (id, name) => current.renameFleet(id, name),
    updateFleet: (id, patch) => current.updateFleet(id, patch),
    deleteFleet: (id) => current.deleteFleet(id),
    addToFleet: (id, printerId) => current.addToFleet(id, printerId),
    removeFromFleet: (id, printerId) => current.removeFromFleet(id, printerId),
    status: (id) => current.status(id),
    subscribe: (id, cb) => current.subscribe(id, cb),
    upload: (id, file, token) => current.upload(id, file, token),
    start: (file, opts, token) => current.start(file, opts, token),
    pause: (id, token) => current.pause(id, token),
    resume: (id, token) => current.resume(id, token),
    cancel: (id, token) => current.cancel(id, token),
    snapshot: (id) => current.snapshot(id),
    callTool: (pluginId, tool, input, token) => current.callTool(pluginId, tool, input, token),
  }
}
