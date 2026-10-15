// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Save and the other file commands, run as the command bar, Mod+S and the native menu run them: a save that fails
// comes back to the caller as a failed run (which the command bar shows as a message), never as a rejection
// nothing handles, which the page reports as a crash.
import type { FileRef, Host } from '@slicerx/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/export/threemf', async (orig) => ({ ...(await orig<object>()), writeProjectCompressed: async () => new Uint8Array([1, 2, 3]) }))

const { registerCommands, runCommand } = await import('../src/commands/registry')
const { plateCommands } = await import('../src/plate/commands')
const { clearProject } = await import('../src/project/new')
const { get, set } = await import('../src/state/store')

const entry = (id: string) => ({ id, name: id, handle: { id, hash: id, name: id, triangles: 1, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }, parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }) as never

const unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => void unhandled.push(reason)

function hostWith(save: (name: string, data: Blob) => Promise<FileRef | null>) {
  return { slicer: {}, files: { save: vi.fn(save) } } as unknown as Host
}

describe('the project save command', () => {
  let off = () => {}
  beforeEach(() => {
    clearProject()
    unhandled.length = 0
    process.on('unhandledRejection', onUnhandled)
  })
  afterEach(() => {
    off()
    process.off('unhandledRejection', onUnhandled)
  })

  it('reports a save the browser refuses as a failed run, not an unhandled rejection', async () => {
    const host = hostWith(async () => {
      throw new DOMException('Must be handling a user gesture to show a file picker.', 'SecurityError')
    })
    off = registerCommands(plateCommands(() => ({ id: 'slicerx' }) as never, host))
    set({ plate: [entry('a')] })
    const r = await runCommand('project-save')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(r).toMatchObject({ ok: false, reason: 'failed', message: expect.stringContaining('Must be handling a user gesture') })
    expect(unhandled).toEqual([])
  })

  it('finishes the save before the run counts as done', async () => {
    let written = 0
    const host = hostWith(async (name, data) => {
      written = data.size
      return { id: '1', name, size: data.size }
    })
    off = registerCommands(plateCommands(() => ({ id: 'slicerx' }) as never, host))
    set({ plate: [entry('a')] })
    expect(await runCommand('project-save')).toEqual({ ok: true })
    // the bytes reached the file by the time the run says it is done
    expect(written).toBe(3)
    expect(get().projectFile).toBeNull()
  })
})
