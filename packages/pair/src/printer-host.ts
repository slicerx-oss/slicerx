// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A PrinterHost on the phone backed by a paired computer, so phone code written against the
// contract (list, status, upload, start, pause) runs unchanged against printers the computer
// reaches.
//
// Side effects keep both approval gates. The phone's code passes a token from the phone's own
// broker, minted after the person confirmed on the phone. The computer raises its own approval
// request for the same host calls. This adapter signs that request only when every one of its
// actions verifies against the phone's token, so the computer can never get a signature for
// something the person did not approve here. The computer's broker then mints the token its
// printers check.
import { startsPrint, type ApprovalToken, type ApprovalVerifier, type PrinterError, type PrinterErrorCode, type PrinterHost, type RemoteFile, type StartOptions } from '@slicerx/contracts'
import { toArrayBuffer } from './bytes'
import type { HostConnection } from './client'
import { PairError, type JobUpdate } from './rpc'

export class PairedPrinterError extends Error implements PrinterError {
  readonly printerId?: string
  constructor(
    readonly code: PrinterErrorCode,
    message: string,
    printerId?: string,
  ) {
    super(message)
    this.name = 'PairedPrinterError'
    if (printerId !== undefined) this.printerId = printerId
  }
}

export interface PairedPrinterHostOptions {
  /** A live connection to the paired computer. Called per operation, so it may reconnect. */
  connection(): Promise<HostConnection>
  /** The phone's own approval broker, which minted the tokens callers pass in. */
  local: ApprovalVerifier
  /** How long to wait for the computer's approval and the printer's answer. Default 5 minutes. */
  jobTimeoutMs?: number
  /**
   * Asks the person on this phone whether the build plate is clear, for a request that starts a print. Resolve true only from the
   * person's own tap. Absent, or false, sends no bed answer and the computer refuses the start (`bed_check`).
   */
  confirmBedClear?(printerId: string): Promise<boolean>
}

export interface PairedPrinterHost extends PrinterHost {
  /** True for computer approval requests this adapter answers, so the app does not show them twice. */
  owns(requestId: string): boolean
  /**
   * Like `owns`, after any job this adapter is raising has its request id. The computer announces
   * a request before it answers the call that raised it, so check this one from event handlers.
   */
  ownsSettled(requestId: string): Promise<boolean>
  /** The camera image as bytes. React Native cannot build a Blob from bytes, so apps there use this. */
  snapshotImage(printerId: string): Promise<{ contentType: string; data: Uint8Array } | null>
  /** The computer's live camera for this connection, or null when it offers none (use stills then). */
  camera(): Promise<HostConnection['camera'] | null>
  /** One still through the computer. */
  grab: HostConnection['grab']
  /** Push registration with the computer's hub, or null when it sends no alerts. */
  push(): Promise<HostConnection['push'] | null>
  /** Sends a file the computer sliced (`conn.slice`) to one printer, starting it when `start` is set. */
  sendSlice(sliceId: string, printerId: string, token: ApprovalToken, opts?: { start?: boolean; startOptions?: StartOptions }): Promise<RemoteFile>
}

const REF_PREFIX = 'pair:'

export function createPairedPrinterHost(o: PairedPrinterHostOptions): PairedPrinterHost {
  const owned = new Set<string>()
  const raising = new Set<Promise<unknown>>()
  const timeoutMs = o.jobTimeoutMs ?? 5 * 60 * 1000

  const unsupported = (what: string) => async (): Promise<never> => {
    throw new PairedPrinterError('not_supported', `${what} is done on the computer`)
  }

  /**
   * Raises a job on the computer, approves it with the phone's token when every action matches,
   * and resolves with the update that ends it.
   */
  async function runJob(
    conn: HostConnection,
    token: ApprovalToken,
    printerId: string,
    raise: () => Promise<{ jobId: string; requestId: string }>,
    success: JobUpdate['state'][],
  ): Promise<JobUpdate> {
    const updates: JobUpdate[] = []
    let wake: (() => void) | null = null
    const off = conn.onJob((u) => {
      updates.push(u)
      wake?.()
    })
    try {
      const raised = raise().then((r) => {
        owned.add(r.requestId)
        return r
      })
      raising.add(raised)
      const { jobId, requestId } = await raised.finally(() => raising.delete(raised))
      const view = (await conn.approvals()).find((v) => v.request.id === requestId)
      if (!view) throw new PairedPrinterError('approval_invalid', 'The computer did not raise the approval', printerId)
      for (const a of view.request.actions) {
        const check = await o.local.verify(token, a.action, a.target, a.paramsHash)
        if (!check.ok) {
          if (conn.info.rights.approve) await conn.deny(view).catch(() => undefined)
          throw new PairedPrinterError('approval_invalid', `The approval on this phone does not cover ${a.action} (${check.reason})`, printerId)
        }
      }
      // Without the approve right the computer's own approval card decides.
      if (conn.info.rights.approve) {
        const bedClear = startsPrint(view.request) && o.confirmBedClear ? (await o.confirmBedClear(printerId)) === true : false
        await conn.approve(view, { bedClear })
      }
      const end = Date.now() + timeoutMs
      for (;;) {
        const mine = updates.filter((u) => u.jobId === jobId)
        const last = mine.find((u) => success.includes(u.state) || ['denied', 'expired', 'failed'].includes(u.state))
        if (last) {
          if (success.includes(last.state)) return last
          const code: PrinterErrorCode = last.state === 'failed' ? 'bad_state' : 'approval_invalid'
          throw new PairedPrinterError(code, last.message ?? `The job was ${last.state}`, printerId)
        }
        const left = end - Date.now()
        if (left <= 0) throw new PairedPrinterError('unreachable', 'The computer did not finish the job in time', printerId)
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, Math.min(left, 1000))
          wake = () => {
            clearTimeout(t)
            resolve()
          }
        })
        wake = null
      }
    } catch (e) {
      if (e instanceof PairError) throw new PairedPrinterError(e.code === 'not_found' ? 'not_found' : e.code === 'closed' || e.code === 'timeout' ? 'unreachable' : 'protocol', e.message, printerId)
      throw e
    } finally {
      off()
    }
  }

  const remoteOf = (printerId: string, u: JobUpdate, fallback: string): RemoteFile => {
    if (!u.fileRef) throw new PairedPrinterError('protocol', 'The computer did not name the uploaded file', printerId)
    return { printerId, path: `${REF_PREFIX}${u.fileRef}`, name: u.remoteName ?? fallback }
  }

  const host: PairedPrinterHost = {
    owns: (id) => owned.has(id),
    async ownsSettled(id) {
      await Promise.allSettled([...raising])
      return owned.has(id)
    },
    plugins: async () => [],
    list: async () => (await o.connection()).printers(),
    fleets: async () => (await o.connection()).fleets(),
    createFleet: unsupported('Creating fleets'),
    renameFleet: unsupported('Renaming fleets'),
    updateFleet: unsupported('Changing fleets'),
    deleteFleet: unsupported('Deleting fleets'),
    addToFleet: unsupported('Changing fleets'),
    removeFromFleet: unsupported('Changing fleets'),
    status: async (printerId) => (await o.connection()).status(printerId),
    subscribe(printerId, onEvent) {
      let off: (() => void) | null = null
      let stopped = false
      void o
        .connection()
        .then((c) => c.watch(printerId, onEvent))
        .then(
          (stop) => {
            if (stopped) stop()
            else off = stop
          },
          () => undefined,
        )
      return () => {
        stopped = true
        off?.()
      }
    },
    async upload(printerId, file, token) {
      const conn = await o.connection()
      const slice = await conn.uploadSlice({ name: file.name, kind: file.kind, data: new Uint8Array(file.data), printerId })
      if (slice.sha256 !== file.sha256) throw new PairedPrinterError('protocol', 'The file hash does not match its contents', printerId)
      const u = await runJob(conn, token, printerId, () => conn.send({ sliceId: slice.sliceId, target: { printerIds: [printerId] }, start: false }), ['queued'])
      return remoteOf(printerId, u, file.name)
    },
    async sendSlice(sliceId, printerId, token, opts = {}) {
      const conn = await o.connection()
      const start = opts.start ?? false
      const u = await runJob(
        conn,
        token,
        printerId,
        () => conn.send({ sliceId, target: { printerIds: [printerId] }, start, ...(opts.startOptions ? { opts: opts.startOptions } : {}) }),
        [start ? 'started' : 'queued'],
      )
      return remoteOf(printerId, u, 'plate.gcode')
    },
    async start(file, opts, token) {
      if (!file.path.startsWith(REF_PREFIX)) throw new PairedPrinterError('not_found', 'This file was not sent through the computer', file.printerId)
      const conn = await o.connection()
      await runJob(conn, token, file.printerId, () => conn.startFile(file.path.slice(REF_PREFIX.length), opts), ['started'])
    },
    async pause(printerId, token) {
      const conn = await o.connection()
      await runJob(conn, token, printerId, () => conn.control(printerId, 'pause'), ['done'])
    },
    async resume(printerId, token) {
      const conn = await o.connection()
      await runJob(conn, token, printerId, () => conn.control(printerId, 'resume'), ['done'])
    },
    async cancel(printerId, token) {
      const conn = await o.connection()
      await runJob(conn, token, printerId, () => conn.control(printerId, 'cancel'), ['done'])
    },
    snapshotImage: async (printerId) => (await o.connection()).snapshot(printerId),
    async camera() {
      const conn = await o.connection()
      return conn.info.camera === true ? conn.camera : null
    },
    grab: async (printerId) => (await o.connection()).grab(printerId),
    async push() {
      const conn = await o.connection()
      return conn.info.push === true ? conn.push : null
    },
    async snapshot(printerId) {
      const r = await (await o.connection()).snapshot(printerId)
      if (!r) return null
      try {
        return new Blob([toArrayBuffer(r.data)], { type: r.contentType })
      } catch {
        throw new PairedPrinterError('not_supported', 'Use snapshotImage on this platform', printerId)
      }
    },
    callTool: unsupported('Plugin tools'),
  }
  return host
}
