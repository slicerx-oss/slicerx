// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Queueing sliced plates on the hub. The person at the terminal confirms first, and the hub asks
// again on its own approval card before each print starts. Nothing here starts a print.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { JobFile } from '@slicerx/contracts'

/** The one hub call this tool makes. `LinkHost` from @slicerx/link-client has it. */
export interface QueueTarget {
  queue: {
    add(printerId: string, file: JobFile, opts?: { title?: string }): Promise<{ item: { id: string; state: string } }>
  }
}

export interface Sliced {
  name: string
  gcodePath: string
}

/** Reads a G-code file into the shape the hub takes, with the SHA-256 it checks before upload. */
export async function jobFile(name: string, gcodePath: string): Promise<JobFile> {
  const bytes = await readFile(gcodePath)
  const kind: JobFile['kind'] = gcodePath.endsWith('.bgcode') ? 'bgcode' : 'gcode'
  const ext = kind === 'bgcode' ? '.bgcode' : '.gcode'
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return { name: `${name}${ext}`, kind, data, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/**
 * Asks once for the whole batch, then adds each plate to the printer's queue on the hub. `ask`
 * returns true only for an explicit yes. Returns the queue item ids, or an empty list when the
 * person said no.
 */
export async function queuePlates(
  hub: QueueTarget,
  printerId: string,
  plates: Sliced[],
  ask: (question: string) => Promise<boolean>,
  log: (line: string) => void = console.log,
): Promise<string[]> {
  if (plates.length === 0) return []
  const list = plates.map((p) => `  ${basename(p.gcodePath)} (${p.name})`).join('\n')
  const yes = await ask(
    `Queue ${plates.length} plate${plates.length === 1 ? '' : 's'} on printer ${printerId}?\n${list}\n` +
      'Each one still waits for approval in the SlicerX app before it starts. Queue them? [y/N] ',
  )
  if (!yes) {
    log('Nothing was queued.')
    return []
  }
  const ids: string[] = []
  for (const p of plates) {
    const file = await jobFile(p.name, p.gcodePath)
    const { item } = await hub.queue.add(printerId, file, { title: p.name })
    log(`queued ${file.name} as ${item.id} (${item.state})`)
    ids.push(item.id)
  }
  return ids
}

/** Reads a yes or no from the terminal. Anything but y or yes is a no. */
export async function askTerminal(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^(y|yes)$/i.test((await rl.question(question)).trim())
  } finally {
    rl.close()
  }
}
