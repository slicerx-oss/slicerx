// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// LayerMate (stand-in): opens a model in another program, the way a host app opens a file in its
// slicer. The command line is the program followed by the file path. A second launch hands the file to
// the program that is already running, so this works whether the slicer is open or not.
//   node open-in-edition.mjs <model file>      uses editionCommand from layermate.config.json
//   node open-in-edition.mjs --exe <program> <model file>
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The command from layermate.config.json: a program path, or an array of the program and its fixed arguments. */
export function configuredCommand() {
  const file = join(here, 'layermate.config.json')
  const cmd = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).editionCommand : null
  if (!cmd) return null
  return Array.isArray(cmd) ? cmd : [cmd]
}

/** Starts `command` with the model's absolute path as the last argument and detaches from it. */
export function openInEdition(command, model) {
  if (!command?.length) throw new Error('editionCommand is not set in layermate.config.json')
  const [program, ...args] = command
  const child = spawn(program, [...args, resolve(model)], { detached: true, stdio: 'ignore' })
  child.unref()
  return child
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2)
  const exe = argv[0] === '--exe' ? argv.splice(0, 2)[1] : null
  const model = argv[0]
  if (!model) throw new Error('usage: node open-in-edition.mjs [--exe <program>] <model file>')
  openInEdition(exe ? [exe] : configuredCommand(), model)
}
