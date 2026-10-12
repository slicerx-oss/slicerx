// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opens a model or project in the SlicerX desktop app on this computer, the way a person double-clicks it: through the
// system's opener, which hands the file to the app registered for .sx3mf, .3mf and .stl. The browser's "Open in
// SlicerX" button does the same through the app's link.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { ToolInputError } from './models'

const OPENS = ['.sx3mf', '.3mf', '.stl']

/** The system's opener for a file: open on macOS, start on Windows, xdg-open elsewhere. */
export function openerFor(platform: NodeJS.Platform, file: string): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [file] }
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '""', file] }
  return { cmd: 'xdg-open', args: [file] }
}

export interface Opened {
  file: string
  /** The command that handed it over. */
  command: string
}

/** Hands `file` to the desktop app. Throws a tool input error for a missing or unsupported file. */
export async function openInApp(file: string, run: (cmd: string, args: string[]) => Promise<void> = launch, platform: NodeJS.Platform = process.platform): Promise<Opened> {
  if (!OPENS.includes(extname(file).toLowerCase())) throw new ToolInputError(`${basename(file)} is not a project or model the app opens (.sx3mf, .3mf or .stl)`, 'unsupported_format')
  if (!existsSync(file)) throw new ToolInputError(`${file} does not exist`, 'invalid_model')
  const { cmd, args } = openerFor(platform, file)
  await run(cmd, args)
  return { file, command: [cmd, ...args].join(' ') }
}

function launch(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
