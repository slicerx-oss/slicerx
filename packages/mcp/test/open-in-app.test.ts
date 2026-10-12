// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicerx_open_in_app hands a project or model to the desktop app through the system's opener, and refuses anything else.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openerFor, openInApp } from '../src/open-in-app'

describe('open in the app', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-open-'))
  const project = join(dir, 'clip.sx3mf')
  writeFileSync(project, 'design')

  it('uses the opener of each system', () => {
    expect(openerFor('darwin', project)).toEqual({ cmd: 'open', args: [project] })
    expect(openerFor('linux', project)).toEqual({ cmd: 'xdg-open', args: [project] })
    expect(openerFor('win32', project)).toEqual({ cmd: 'cmd', args: ['/c', 'start', '""', project] })
  })

  it('hands a project to the opener and says how', async () => {
    const calls: string[][] = []
    const r = await openInApp(project, async (cmd, args) => void calls.push([cmd, ...args]), 'darwin')
    expect(calls).toEqual([['open', project]])
    expect(r).toEqual({ file: project, command: `open ${project}` })
  })

  it('refuses a file the app does not open, and a missing one', async () => {
    const run = async () => {
      throw new Error('should not run')
    }
    const notes = join(dir, 'notes.txt')
    writeFileSync(notes, 'x')
    await expect(openInApp(notes, run)).rejects.toMatchObject({ code: 'unsupported_format' })
    await expect(openInApp(join(dir, 'gone.3mf'), run)).rejects.toMatchObject({ code: 'invalid_model' })
  })
})
