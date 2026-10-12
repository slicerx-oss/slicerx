// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A send whose connection to the printer bridge dropped part way: whether the upload or the start reached the printer
// is unknown, so it is never sent again. Once the bridge is back the printer is asked what it is doing, and that is
// what the person is told.
import type { Host, PrinterStatus } from '@slicerx/contracts'
import { bridgeBack } from './bridge'

/** How long a dropped send waits for the bridge to come back before it says so. */
export const DROPPED_SEND_WAIT_MS = 15_000

/** True for the error a call gets when the connection to the bridge closed under it or before it. */
export function isDroppedConnection(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === 'closed'
}

const STATE: Record<PrinterStatus['state'], string> = {
  idle: 'that it is idle',
  preparing: 'that it is preparing a print',
  printing: 'that it is printing',
  paused: 'that it is paused',
  finished: 'that its last print finished',
  error: 'an error',
  offline: 'that it is offline',
}

/** What to tell the person after a send dropped. Never sends anything itself. */
export async function droppedSendNote(host: Host, printerId: string, printerName: string, fileName: string, waitMs = DROPPED_SEND_WAIT_MS): Promise<string> {
  const head = `The connection to the printer bridge dropped while sending to ${printerName}, so ${fileName} was not sent again.`
  if (!(await bridgeBack(waitMs)) || !host.printers) return `${head} The bridge has not come back yet. Check the printer before you send again.`
  const status = await host.printers.status(printerId).catch(() => null)
  if (!status) return `${head} The printer did not answer. Check it before you send again.`
  const job = status.jobName?.trim()
  const ours = job ? job === fileName || fileName.startsWith(job) || job.startsWith(fileName.replace(/\.gcode(\.3mf)?$/i, '')) : false
  if ((status.state === 'printing' || status.state === 'preparing') && ours) return `${printerName} is printing ${job}: the print started before the connection dropped. ${head}`
  const what = STATE[status.state] + (job && status.state !== 'idle' ? ` (${job})` : '')
  return `${head} The printer reports ${what}. Send again if you still want this print.`
}
