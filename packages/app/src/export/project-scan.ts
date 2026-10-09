// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The heavy half of reading a 3MF project: inflating the archive and scanning every model part into typed arrays,
// with the Vault marks of the model parts. It runs in the project worker (project-worker.ts) so a model of millions
// of triangles neither blocks the page nor leaves a string of hundreds of megabytes on its heap; import3mf.ts reads
// the small settings files and puts the project together. No DOM and no app state here.
import { MarkReadError, readVaultMarks, type VaultMark } from '@slicerx/contracts/sx3mf-marks'
import { ModelScanError, scanModelBytes, type ScannedModel } from './model-scan'
import { ProjectReadError, unzipEntries } from './unzip'

export interface ScannedProject {
  /** Every entry of the archive except the model parts, as stored. */
  files: Map<string, Uint8Array>
  /** Each model part by entry name, or why it could not be read (thrown only if the project uses that part). */
  models: Map<string, ScannedModel | { error: string }>
  /** The Vault marks of every model part, merged in archive order (a mark there covers the whole file). */
  marks: VaultMark
  /** A model part declares a DTD: the whole file is refused. */
  markError?: string
  /** performance.timeOrigin + performance.now() when the archive was inflated and when the parts were scanned. */
  unzippedAt: number
  scannedAt: number
}

const isModel = (name: string): boolean => /\.model$/i.test(name)

const now = (): number => performance.timeOrigin + performance.now()

export async function scanProject(bytes: Uint8Array): Promise<ScannedProject> {
  const all = await unzipEntries(bytes)
  const unzippedAt = now()
  const files = new Map<string, Uint8Array>()
  const models = new Map<string, ScannedModel | { error: string }>()
  const marks: VaultMark = {}
  let markError: string | undefined
  const dec = new TextDecoder()
  for (const [name, b] of all) {
    if (!isModel(name)) {
      files.set(name, b)
      continue
    }
    let skeleton: Uint8Array | null = null
    try {
      models.set(name, scanModelBytes(b, (s) => (skeleton = s)))
    } catch (e) {
      if (!(e instanceof ModelScanError)) throw e
      models.set(name, { error: e.message })
    }
    if (markError) continue
    try {
      // The skeleton is the part without its vertex and triangle runs, all a mark can be in; a part that did not scan
      // is read whole.
      const m = readVaultMarks(dec.decode(skeleton ?? b)).root
      if (m.listing && !marks.listing) marks.listing = m.listing
      if (m.creator && !marks.creator) marks.creator = m.creator
    } catch (e) {
      if (!(e instanceof MarkReadError)) throw e
      markError = e.message
    }
  }
  return { files, models, marks, ...(markError ? { markError } : {}), unzippedAt, scannedAt: now() }
}

/** The buffers of a scanned project, to transfer it from the worker without copies. */
export function transferables(p: ScannedProject): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>()
  const add = (a: ArrayBufferView) => {
    if (a.buffer instanceof ArrayBuffer) out.add(a.buffer)
  }
  for (const b of p.files.values()) add(b)
  for (const m of p.models.values()) {
    if ('error' in m) continue
    for (const o of m.objects.values()) {
      if (!o.mesh) continue
      add(o.mesh.positions)
      add(o.mesh.indices)
    }
  }
  return [...out]
}

/** What the worker sends back for an archive it could not read: a plain reason for the person, or a bug. */
export function scanFailure(e: unknown): { error: string; plain: boolean } {
  return { error: e instanceof Error ? e.message : String(e), plain: e instanceof ProjectReadError }
}
